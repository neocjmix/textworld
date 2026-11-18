import { cellKey } from '../shared/world.js';

// The public world keeps recent receipts, evidence and invisible deletion marks
// for five minutes. Current glyphs keep their source group and shared clock
// until they are actually expired (including across a delayed cleanup/restart).
export const RETENTION_MS = 5 * 60_000;
export const MAINTENANCE_ROWS = 128;
const RETAINED_RESIZES = 64;

export function indexMaintenance(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS topology_events (seq INTEGER PRIMARY KEY, fromWidth INTEGER,
      fromHeight INTEGER, toWidth INTEGER, toHeight INTEGER, seed INTEGER, summary TEXT);
    CREATE INDEX IF NOT EXISTS cells_version ON cells(version);
    CREATE INDEX IF NOT EXISTS glyph_versions ON cells(version) WHERE text!='';
    CREATE INDEX IF NOT EXISTS tombstone_versions ON cells(version) WHERE text='' AND width!=0;
    CREATE INDEX IF NOT EXISTS history_version ON history(seq);
    CREATE INDEX IF NOT EXISTS change_clock ON change_times(updatedAt);
    CREATE INDEX IF NOT EXISTS receipt_version ON operations(json_extract(result,'$.seq'))`);
}

// Versions before this fence are all old enough. A clock adjustment can defer
// cleanup of later versions; it can never age a newly written cell early.
export function firstFreshVersion(world, cutoff) {
  return world.db.prepare('SELECT MIN(version) AS version FROM change_times INDEXED BY change_clock WHERE updatedAt>?')
    .get(cutoff).version ?? world.seq + 1;
}

export function pruneRecords(world, limit = MAINTENANCE_ROWS) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAINTENANCE_ROWS) {
    throw new RangeError('Cleanup page size must be between 1 and ' + MAINTENANCE_ROWS);
  }
  const db = world.db;
  const before = firstFreshVersion(world, world.now() - RETENTION_MS);
  const tombstones = db.prepare(`SELECT x,y FROM cells
    WHERE version<? AND text='' AND width!=0 ORDER BY version LIMIT ?`).all(before, limit);
  let more = tombstones.length === limit;
  const removedAuthors = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const removeCell = db.prepare('DELETE FROM cells WHERE x=? AND y=?');
    for (const cell of tombstones) removeCell.run(cell.x, cell.y);
    const deletedReceipts = db.prepare(`DELETE FROM operations WHERE rowid IN (SELECT rowid FROM operations
      WHERE json_extract(result,'$.seq')<? ORDER BY json_extract(result,'$.seq') LIMIT ?)`).run(before, limit).changes;
    more ||= deletedReceipts === limit;
    const deletedResizes = db.prepare(`DELETE FROM topology_events WHERE seq IN (
      SELECT seq FROM topology_events WHERE seq < (SELECT seq FROM topology_events
        ORDER BY seq DESC LIMIT 1 OFFSET ?) ORDER BY seq LIMIT ?)`).run(RETAINED_RESIZES - 1, limit).changes;
    more ||= deletedResizes === limit;
    // Limit inspected rows as well as mutations. A source group with even one
    // surviving cell retains its full original footprint for scavenger evidence.
    const history = db.prepare(`SELECT rowid,seq FROM history WHERE (seq,rowid)>(?,?)
      AND seq<? ORDER BY seq,rowid LIMIT ?`).all(...(world.maintenanceHistory ?? [-1, -1]), before, limit);
    const dropHistory = db.prepare(`DELETE FROM history WHERE rowid=?
      AND NOT EXISTS (SELECT 1 FROM cells WHERE version=?)`);
    for (const row of history) dropHistory.run(row.rowid, row.seq);
    more ||= history.length === limit;

    // A marker can cover multiple versions. Delete it only after its whole
    // interval has no remaining consumer. Markers still in use survive restarts.
    const stamps = db.prepare(`SELECT t.version,(SELECT MIN(n.version) FROM change_times n
      WHERE n.version>t.version) AS next FROM change_times t WHERE t.version>? AND t.version<?
      ORDER BY t.version LIMIT ?`).all(world.maintenanceStamp ?? -1, before, limit);
    const referenced = db.prepare(`SELECT EXISTS(SELECT 1 FROM cells WHERE version>=?1 AND version<?2)
      OR EXISTS(SELECT 1 FROM history WHERE seq>=?1 AND seq<?2)
      OR EXISTS(SELECT 1 FROM operations WHERE json_extract(result,'$.seq')>=?1
        AND json_extract(result,'$.seq')<?2) AS found`);
    const removeStamp = db.prepare('DELETE FROM change_times WHERE version=?');
    for (const {version, next} of stamps) {
      if (!referenced.get({'1':version, '2':next ?? world.seq + 1}).found) removeStamp.run(version);
    }

    // Sweep a page even when the first authors all still have live cells.
    const colors = db.prepare(`SELECT author FROM author_colors WHERE author>?
      ORDER BY author LIMIT ?`).all(world.maintenanceAuthor ?? '', limit);
    const dropUnused = db.prepare(`DELETE FROM author_colors WHERE author=? AND
      NOT EXISTS (SELECT 1 FROM cells WHERE author=?)`);
    for (const {author} of colors) {
      if (dropUnused.run(author, author).changes) removedAuthors.push(author);
    }
    db.exec('COMMIT');
    world.maintenanceHistory = history.length === limit ? [history.at(-1).seq, history.at(-1).rowid] : [-1, -1];
    world.maintenanceStamp = stamps.length === limit ? stamps.at(-1).version : -1;
    world.maintenanceAuthor = colors.length === limit ? colors.at(-1).author : '';
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  for (const cell of tombstones) world.cells.delete(cellKey(cell.x, cell.y));
  for (const author of removedAuthors) {
    world.persistedAuthors.delete(author);
    if (!world.reservedAuthors.has(author)) world.releaseAuthor(author);
  }
  return more;
}
