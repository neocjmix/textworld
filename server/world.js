import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
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
    this.migrationBackupPath = null;
    if (storagePath !== ':memory:' && saved && needsMigration) {
      // VACUUM INTO captures the complete committed WAL state. A unique path
      // preserves any failed/previous backup; SQLite also refuses overwrites.
      const backupPath = `${storagePath}.pre-width-v2-${Date.now()}-${randomUUID()}.sqlite`;
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
    this.now = now;
    const meta = saved ? JSON.parse(saved.value) : { width, height, epoch: 1, seq: 0 };
    Object.assign(this, meta);
    this.cells = new Map(this.db.prepare('SELECT x,y,text,width,leadX,version,author,updatedAt,groupId AS "group" FROM cells').all().map(cell => [cellKey(cell.x, cell.y), cell]));
    this.lastResize = this.now();
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
    return previous ? { ...JSON.parse(previous.result), duplicate: true } : null;
  }
  applyWrite({ author, id, epoch, x, y, text, lineStartX }) {
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
    const plan = writePlan(text, x, y, this, { lineStartX });
    const changes = new Map();
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
    const updatedAt = this.now();
    const cells = changes.map(cell => ({ ...cell, width: cell.width ?? 1, leadX: cell.leadX ?? null, version: seq, author, updatedAt, group: id }));
    const result = { seq, epoch: this.epoch, cells, cursor, id, author };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.db.prepare('INSERT OR REPLACE INTO cells (x,y,text,version,author,updatedAt,groupId,width,leadX) VALUES (?,?,?,?,?,?,?,?,?)');
      const history = this.db.prepare('INSERT INTO history (seq,x,y,text,author,updatedAt,groupId,reason,width,leadX) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const cell of cells) {
        upsert.run(cell.x, cell.y, cell.text, seq, author, updatedAt, id, cell.width, cell.leadX);
        history.run(seq, cell.x, cell.y, cell.text, author, updatedAt, id, reason, cell.width, cell.leadX);
      }
      this.db.prepare('INSERT INTO operations VALUES (?,?,?)').run(author, id, JSON.stringify(result));
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('world',?)").run(JSON.stringify({ ...this.metadata(), seq }));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.seq = seq;
    for (const cell of cells) this.cells.set(cellKey(cell.x, cell.y), cell);
    return result;
  }
  evidence({ before = this.now(), limit = 500 } = {}) {
    return this.db.prepare(`SELECT c.x,c.y,c.text,c.width,c.leadX,c.version,c.author,c.updatedAt,c.groupId AS "group",
      (SELECT count(*) FROM history h WHERE h.x=c.x AND h.y=c.y) AS revisions,
      (SELECT count(*) FROM history h WHERE h.author=c.author AND h.groupId=c.groupId) AS originalGroupCells,
      (SELECT count(*) FROM cells g WHERE g.groupId=c.groupId AND g.author=c.author AND (g.text!='' OR g.width=0)) AS survivingGroupCells
      FROM cells c WHERE c.text!='' AND c.updatedAt<=? ORDER BY c.updatedAt LIMIT ?`).all(before, Math.min(500, Math.max(1, limit)));
  }
  conditionalDelete({ id, epoch, candidates }) {
    const author = 'scavenger';
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
    return this.commit([...changes.values()], { author, id, reason: 'scavenge', cursor: null });
  }
  resize(width, height, peers = []) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 32 || height < 16 || width > 1024 || height > 512) {
      throw new WorldError('BAD_EXTENT', '세계 크기가 실험 범위를 벗어났습니다.');
    }
    if (width === this.width && height === this.height) return { changed: false, reason: 'unchanged' };
    if (width !== this.width && [...this.cells.values()].some(c => c.width === 2 && c.x === this.width - 1)) {
      return { changed: false, reason: 'wide-boundary' };
    }
    if ([...this.cells.values()].some(c => occupiedCell(c) && (c.x >= width || c.y >= height)) || peers.some(p => p.x >= width || p.y >= height)) {
      return { changed: false, reason: 'occupied-boundary' };
    }
    const next = { width, height, epoch: this.epoch + 1, seq: this.seq + 1 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('world',?)").run(JSON.stringify(next));
      this.db.prepare("DELETE FROM cells WHERE text='' AND width!=0 AND (x>=? OR y>=?)").run(width, height);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    Object.assign(this, next);
    for (const [key, cell] of this.cells) if (cell.x >= width || cell.y >= height) this.cells.delete(key);
    this.lastResize = this.now();
    return { changed: true, reason: 'density', ...this.metadata() };
  }
  adapt(peers = [], { cooldown = 30000 } = {}) {
    const occupied = [...this.cells.values()].filter(occupiedCell).length;
    const density = Math.max(occupied, peers.length * 96) / (this.width * this.height);
    if (this.now() - this.lastResize < cooldown) return { changed: false, reason: 'cooldown', density };
    if (density > 0.25 && this.width < 1024 && this.height < 512) return { ...this.resize(Math.min(1024, this.width * 2), Math.min(512, this.height * 2), peers), density };
    if (density < 0.04 && this.width > 32 && this.height > 16) return { ...this.resize(Math.max(32, Math.floor(this.width / 2)), Math.max(16, Math.floor(this.height / 2)), peers), density };
    return { changed: false, reason: 'stable', density };
  }
  close() { this.db.close(); }
}
