import { remesh } from './topology.js';
import { coherentSeams } from './coherent-seams.js';
import { DENSITY, DensityController, inkArea } from './density.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomInt } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { cellKey, cellSpan, occupiedCell, graphemes, wrap, writePlan } from '../shared/world.js';

export class WorldError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Single-writer authority. SQLite commits are complete before patches are broadcast. */
export class World {
  constructor({ width = 128, height = 64, storagePath = ':memory:', now = Date.now } = {}) {
    if (storagePath !== ':memory:') mkdirSync(dirname(storagePath), { recursive: true });
    this.db = new DatabaseSync(storagePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS author_colors (author TEXT PRIMARY KEY, color TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS cells (x INTEGER, y INTEGER, text TEXT NOT NULL,
        version INTEGER NOT NULL, author TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        groupId TEXT NOT NULL, PRIMARY KEY(x,y));
      CREATE TABLE IF NOT EXISTS history (seq INTEGER, x INTEGER, y INTEGER,
        text TEXT, author TEXT, updatedAt INTEGER, groupId TEXT, reason TEXT);
      CREATE TABLE IF NOT EXISTS operations (author TEXT, id TEXT, result TEXT, PRIMARY KEY(author,id));
      CREATE INDEX IF NOT EXISTS history_cell ON history(x,y);
      CREATE INDEX IF NOT EXISTS history_group ON history(author,groupId);
      CREATE INDEX IF NOT EXISTS cells_group ON cells(author,groupId);`);
    // Existing cells retain their exact addresses and one-column footprint.
    // Retyping upgrades their width; migration never overwrites a neighbour.
    const saved = this.db.prepare("SELECT value FROM meta WHERE key='world'").get();
    const columnsByTable = new Map(['cells', 'history'].map(table => [table,
      new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)),
    ]));
    const needsMigration = [...columnsByTable.values()].some(columns => !columns.has('width') || !columns.has('leadX'));
    const needsTimeMigration = !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='change_times'").get();
    this.migrationBackupPath = null;
    if (storagePath !== ':memory:' && saved && (needsMigration || needsTimeMigration)) {
      // VACUUM INTO captures the complete committed WAL state. A unique path
      // preserves any failed/previous backup; SQLite also refuses overwrites.
      const backupPath = `${storagePath}.${needsMigration ? "pre-width-v2" : "pre-change-times-v3"}-${Date.now()}-${randomUUID()}.sqlite`;
      try {
        this.db.prepare('VACUUM INTO ?').run(backupPath);
        // SQLite VACUUM INTO does not fsync its output before returning.
        // Persist the backup before changing the only live database schema.
        const backupFile = openSync(backupPath, 'r');
        try { fsyncSync(backupFile); } finally { closeSync(backupFile); }
        if (process.platform !== 'win32') {
          const backupDirectory = openSync(dirname(backupPath), 'r');
          try { fsyncSync(backupDirectory); } finally { closeSync(backupDirectory); }
        }
        this.migrationBackupPath = backupPath;
        console.info(`Saved pre-width migration backup: ${backupPath}`);
      } catch (error) {
        this.db.close();
        throw new Error('Width migration backup failed; schema was not changed.', { cause: error });
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, columns] of columnsByTable) {
        if (!columns.has('width')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN width INTEGER NOT NULL DEFAULT 1`);
        if (!columns.has('leadX')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN leadX INTEGER`);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    // Time belongs to a committed change, not to each addressed cell.
    // Keep legacy columns as zero-valued compatibility slots (SQLite stores 0
    // without a numeric payload); their removal can be a separate migration.
    if (needsTimeMigration) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS change_times (version INTEGER PRIMARY KEY, updatedAt INTEGER NOT NULL);
      INSERT OR IGNORE INTO change_times SELECT seq, MAX(updatedAt) FROM history GROUP BY seq;
      INSERT OR IGNORE INTO change_times SELECT version, MAX(updatedAt) FROM cells GROUP BY version;
      UPDATE cells SET updatedAt=0 WHERE updatedAt!=0;
      UPDATE history SET updatedAt=0 WHERE updatedAt!=0;
      COMMIT;`);
    this.now = now;
    this.authorColors = new Map(this.db.prepare("SELECT author,color FROM author_colors").all().map(row => [row.author,row.color]));
    this.usedColors = new Set(this.authorColors.values());
    this.persistedAuthors = new Set(this.authorColors.keys());
    const meta = saved ? JSON.parse(saved.value) : { width, height, epoch: 1, seq: 0 };
    Object.assign(this, meta);
    this.cells = new Map(this.db.prepare('SELECT c.x,c.y,c.text,c.width,c.leadX,c.version,c.author,t.updatedAt,c.groupId AS "group" FROM cells c JOIN change_times t ON t.version=(SELECT MAX(version) FROM change_times WHERE version<=c.version)').all().map(cell => [cellKey(cell.x, cell.y), cell]));
    this.lastResize = this.now();
    this.ink = [...this.cells.values()].reduce((sum, cell) => sum + inkArea(cell), 0);
    this.densityController = new DensityController(this.now(), this.ink);
    this.saveMeta();
  }
  metadata() { return { width: this.width, height: this.height, epoch: this.epoch, seq: this.seq, textLayout: 2 }; }
  snapshot() { return { world: this.metadata(), seq: this.seq, cells: [...this.cells.values()].filter(occupiedCell) }; }
  getCell(x, y) { return this.cells.get(cellKey(wrap(x, this.width), wrap(y, this.height))); }
  saveMeta() { this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('world',?)").run(JSON.stringify(this.metadata())); }
  assertEpoch(epoch) {
    if (epoch !== this.epoch) throw new WorldError('STALE_EPOCH', '세계 크기가 바뀌었습니다. 새 지도를 확인하고 다시 입력하세요.');
  }
  assertPosition(x, y) {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new WorldError('BAD_POSITION', '셀 좌표는 정수여야 합니다.');
  }
  prior(author, id) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 100) throw new WorldError('BAD_ID', '입력 식별자가 필요합니다.');
    const previous = this.db.prepare('SELECT result FROM operations WHERE author=? AND id=?').get(author, id);
    if (!previous) return null;
    const result = JSON.parse(previous.result);
    const stamp = this.db.prepare('SELECT updatedAt FROM change_times WHERE version<=? ORDER BY version DESC LIMIT 1').get(result.seq);
    if (stamp) for (const cell of result.cells) cell.updatedAt = stamp.updatedAt;
    return { ...result, duplicate: true };
  }
  applyWrite({ author, id, epoch, x, y, text, lineStartX, clear = [] }) {
    const previous = this.prior(author, id);
    if (previous) return previous;
    this.assertEpoch(epoch);
    this.assertPosition(x, y);
    if (lineStartX !== undefined && !Number.isSafeInteger(lineStartX)) {
      throw new WorldError('BAD_POSITION', '줄 시작 좌표는 정수여야 합니다.');
    }
    if (typeof text !== 'string' || text.length > 4096 || graphemes(text).length > 512 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
      throw new WorldError('BAD_TEXT', '한 번에 512자 이내의 텍스트를 입력하세요.');
    }
    if (!Array.isArray(clear) || clear.length > 2048) {
      throw new WorldError('BAD_CLEAR', '교체할 셀은 최대 2048개 주소여야 합니다.');
    }
    // A native range update is one spatial operation. Validate the entire
    // footprint before calculating any changes, never erase then validate.
    for (const address of clear) {
      if (!address || typeof address !== 'object' || Array.isArray(address)) {
        throw new WorldError('BAD_CLEAR', '교체할 셀 주소가 잘못되었습니다.');
      }
      this.assertPosition(address.x, address.y);
      if (address.x < 0 || address.x >= this.width || address.y < 0 || address.y >= this.height) {
        throw new WorldError('BAD_POSITION', '교체할 셀 주소는 현재 세계 안에 있어야 합니다.');
      }
    }
    const plan = writePlan(text, x, y, this, { lineStartX });
    const changes = new Map();
    for (const address of clear) {
      const span = this.spanAt(address.x, address.y);
      for (const old of span.length ? span : [address]) changes.set(cellKey(old.x, old.y), { x: old.x, y: old.y, text: '' });
    }
    for (const cell of plan.cells) {
      for (const old of this.spanAt(cell.x, cell.y)) changes.set(cellKey(old.x, old.y), { x: old.x, y: old.y, text: '' });
    }
    for (const cell of plan.cells) changes.set(cellKey(cell.x, cell.y), cell);
    return this.commit([...changes.values()], { author, id, cursor: plan.cursor, reason: 'write' });
  }
  spanAt(x, y) { return cellSpan((a, b) => this.getCell(a, b), x, y, this); }
  erase({ author, id, epoch, x, y }) {
    const previous = this.prior(author, id);
    if (previous) return previous;
    this.assertEpoch(epoch);
    this.assertPosition(x, y);
    x = wrap(x, this.width); y = wrap(y, this.height);
    const span = this.spanAt(x, y);
    const changes = (span.length ? span : [{ x, y }]).map(cell => ({ x: cell.x, y: cell.y, text: '' }));
    return this.commit(changes, { author, id, cursor: { x, y }, reason: 'erase' });
  }
  commit(changes, { author, id, cursor, reason }) {
    const seq = this.seq + 1;
    const time = this.now();
    const previousTime = this.db.prepare('SELECT updatedAt FROM change_times ORDER BY version DESC LIMIT 1').get();
    // A sparse sequence-to-time index: all writes within a five-second
    // interval share one marker; cells already carry the sequence reference.
    const newTime = !previousTime || time < previousTime.updatedAt || time - previousTime.updatedAt >= 5000;
    const updatedAt = newTime ? time : previousTime.updatedAt;
    const cells = changes.map(cell => ({ ...cell, width: cell.width ?? 1, leadX: cell.leadX ?? null, version: seq, author, updatedAt, group: id }));
    const result = { seq, epoch: this.epoch, cells, cursor, id, author };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (newTime) this.db.prepare('INSERT INTO change_times VALUES (?,?)').run(seq, updatedAt);
      const upsert = this.db.prepare('INSERT OR REPLACE INTO cells (x,y,text,version,author,updatedAt,groupId,width,leadX) VALUES (?,?,?,?,?,?,?,?,?)');
      const history = this.db.prepare('INSERT INTO history (seq,x,y,text,author,updatedAt,groupId,reason,width,leadX) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const cell of cells) {
        upsert.run(cell.x, cell.y, cell.text, seq, author, 0, id, cell.width, cell.leadX);
        history.run(seq, cell.x, cell.y, cell.text, author, 0, id, reason, cell.width, cell.leadX);
      }
      this.db.prepare('INSERT INTO operations VALUES (?,?,?)').run(author, id, JSON.stringify({ ...result, cells: result.cells.map(({ updatedAt, ...cell }) => cell) }));
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('world',?)").run(JSON.stringify({ ...this.metadata(), seq }));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.seq = seq;
    for (const cell of cells) {
      const key = cellKey(cell.x, cell.y);
      this.ink += inkArea(cell) - inkArea(this.cells.get(key));
      this.cells.set(key, cell);
    }
    return result;
  }
  reserveAuthor(author, color) {
    this.authorColors.set(author, color);
    this.usedColors.add(color);
  }
  releaseAuthor(author) {
    if (!this.persistedAuthors.has(author)) {
      this.usedColors.delete(this.authorColors.get(author));
      this.authorColors.delete(author);
    }
  }
  persistAuthor(author) {
    if (!this.persistedAuthors.has(author) && this.authorColors.has(author)) this.registerAuthor(author, this.authorColors.get(author));
  }
  registerAuthor(author, color) {
    this.db.prepare("INSERT INTO author_colors (author,color) VALUES (?,?)").run(author, color);
    this.authorColors.set(author, color);
    this.usedColors.add(color);
    this.persistedAuthors.add(author);
  }
  expiredCandidates(before, limit = 500) {
    const result = [];
    for (const cell of this.cells.values()) {
      if (cell.text && cell.updatedAt <= before) {
        result.push({ x: cell.x, y: cell.y, version: cell.version });
        if (result.length >= limit) break;
      }
    }
    return result;
  }
  evidence({ before = this.now(), limit = 500 } = {}) {
    return this.db.prepare(`SELECT c.x,c.y,c.text,c.width,c.leadX,c.version,c.author,t.updatedAt,c.groupId AS "group",
      (SELECT count(*) FROM history h WHERE h.x=c.x AND h.y=c.y) AS revisions,
      (SELECT count(*) FROM history h WHERE h.author=c.author AND h.groupId=c.groupId) AS originalGroupCells,
      (SELECT count(*) FROM cells g WHERE g.groupId=c.groupId AND g.author=c.author AND (g.text!='' OR g.width=0)) AS survivingGroupCells
      FROM cells c JOIN change_times t ON t.version=(SELECT MAX(version) FROM change_times WHERE version<=c.version) WHERE c.text!='' AND t.updatedAt<=? ORDER BY t.updatedAt LIMIT ?`).all(before, Math.min(500, Math.max(1, limit)));
  }
  conditionalDelete({ id, epoch, candidates }) {
    const author = 'expiry';
    const previous = this.prior(author, id);
    if (previous) return previous;
    this.assertEpoch(epoch);
    if (!Array.isArray(candidates) || candidates.length > 500) throw new WorldError('BAD_CANDIDATES', '최대 500개 셀을 정리할 수 있습니다.');
    const changes = new Map();
    for (const candidate of candidates) {
      this.assertPosition(candidate.x, candidate.y);
      const key = cellKey(candidate.x, candidate.y);
      const current = this.cells.get(key);
      if (current?.text && current.version === candidate.version) {
        const span = this.spanAt(current.x, current.y);
        if (current.width === 2 && (span.length !== 2 || span.some(cell => cell.version !== candidate.version || cell.author !== current.author || cell.group !== current.group))) continue;
        for (const cell of span) changes.set(cellKey(cell.x, cell.y), { x: cell.x, y: cell.y, text: '' });
      }
    }
    return this.commit([...changes.values()], { author, id, reason: 'expire', cursor: null });
  }
  resize(width, height, peers = [], { seed = randomInt(0, 4294967296), seams } = {}) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 32 || height < 16 || width > 1024 || height > 512) {
      throw new WorldError('BAD_EXTENT', '세계 크기가 실험 범위를 벗어났습니다.');
    }
    if (width === this.width && height === this.height) return { changed: false, reason: 'unchanged' };
    if(!Number.isSafeInteger(seed)||seed<0||seed>4294967295)throw new WorldError('BAD_SEED','Invalid topology seed.');
    const from = { width: this.width, height: this.height };
    const plan = remesh(this.cells, from, { width, height }, seed, { seams });
    const next = { width, height, epoch: this.epoch + 1, seq: this.seq + 1 };
    const relocated = peers.map(peer => plan.cursor(peer));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS topology_events (seq INTEGER PRIMARY KEY, fromWidth INTEGER, fromHeight INTEGER, toWidth INTEGER, toHeight INTEGER, seed INTEGER, summary TEXT)`);
      this.db.prepare('INSERT INTO topology_events VALUES (?,?,?,?,?,?,?)').run(next.seq, from.width, from.height, width, height, seed, JSON.stringify({ ...plan.summary, ...(seams ? { seams } : {}) }));
      this.db.exec('DELETE FROM cells');
      const insert = this.db.prepare('INSERT INTO cells (x,y,text,version,author,updatedAt,groupId,width,leadX) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const cell of plan.cells.values()) insert.run(cell.x, cell.y, cell.text, cell.version, cell.author, 0, cell.group, cell.width, cell.leadX);
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('world',?)").run(JSON.stringify(next));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.cells = plan.cells;
    this.ink = [...this.cells.values()].reduce((sum, cell) => sum + inkArea(cell), 0);
    this.densityController.resized(this.ink, width * height);
    Object.assign(this, next);
    peers.forEach((peer, index) => Object.assign(peer, relocated[index]));
    this.lastResize = this.now();
    const result = { changed: true, reason: 'density', preservesAddresses: false, from, ...this.metadata(), ...plan.summary };
    // Internal proof of local continuity. Never expose the world's seam paths
    // or a map of unseen addresses through the participant interface.
    Object.defineProperty(result, 'mapping', { value: plan.point });
    return result;
  }
  adapt(peers = [], { cooldown, seed = randomInt(0, 4294967296) } = {}) {
    const control = this.densityController.decide({ now: this.now(), occupied: this.ink,
      width: this.width, height: this.height, lastResize: this.lastResize, cooldown });
    if (control.reason !== 'due') return control;
    const grow = control.mode === 'grow', from = { width: this.width, height: this.height };
    const preferWidth = grow ? this.width / this.height <= 2 : this.width / this.height > 2;
    const dimensions = [
      { axis: 'width', other: this.height, size: this.width, min: DENSITY.minWidth, max: DENSITY.maxWidth },
      { axis: 'height', other: this.width, size: this.height, min: DENSITY.minHeight, max: DENSITY.maxHeight },
    ].filter(d => grow ? d.size < d.max : d.size > d.min)
      .sort((a, b) => Number(b.axis === (preferWidth ? 'width' : 'height')) - Number(a.axis === (preferWidth ? 'width' : 'height')));
    let best, candidate = 0;
    for (const d of dimensions) {
      const goal = Math.ceil(control.targetArea / d.other);
      // Blank preservation must not turn a 2D world into an ever longer strip.
      const min = Math.max(d.min, d.axis === 'width' ? d.other : Math.ceil(d.other / 4));
      const max = Math.min(d.max, d.axis === 'width' ? d.other * 4 : d.other);
      const room = grow ? max - d.size : d.size - min;
      if (room <= 0) continue;
      const requested = Math.min(room, Math.max(1, Math.floor(d.size * DENSITY.stepFraction)), Math.max(1, Math.abs(goal - d.size)));
      // A large blank deletion may not fit where several smaller ones would.
      // Exhaust smaller blank steps before forcing deletion; growth of a band
      // has the same cut locations regardless of its inserted width.
      for (let step = requested; step >= 1; step = grow || step === 1 ? 0 : Math.max(1, Math.floor(step / 2))) {
        const to = { ...from, [d.axis]: d.size + (grow ? step : -step) };
        for (let attempt = 0; attempt < 2; attempt++) {
          const candidateSeed = (seed + candidate++ * 0x9e3779b9) >>> 0;
          const seams = coherentSeams(this.cells, from, d.axis, grow ? step : -step, candidateSeed);
          const plan = remesh(this.cells, from, to, candidateSeed, { seams });
          if (plan.preservesText) return { ...control, ...this.resize(to.width, to.height, peers, { seed: candidateSeed, seams }), preservation: 'text' };
          // Forced progress must still provide the requested capacity, not an
          // arbitrarily tiny safe-looking change that cannot catch up to input.
          if (step !== requested) continue;
          const score = plan.summary.lostTextCells * (2 * this.width * this.height + 1) + plan.summary.brokenAdjacencies;
          if (!best || score < best.score) best = { to, seed: candidateSeed, seams, score };
        }
      }
    }
    if (!best) return { ...control, reason: 'limit' };
    return { ...control, ...this.resize(best.to.width, best.to.height, peers, { seed: best.seed, seams: best.seams }), preservation: 'forced' };
  }
  close() { this.db.close(); }
}
