// Build the next layout in the same database. The only publication point is
// the transaction which also writes the topology event and advances the epoch.
const shadow = 'resize_next_cells', retired = 'resize_old_cells';
const alternate = 'resize_shadow_';
const quote = name => '"' + name.replaceAll('"', '""') + '"';

function indices(db, table) {
  return db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table);
}
function indexOn(index, name, table) {
  const tail = index.sql.slice(index.sql.indexOf('('));
  const unique = /^CREATE UNIQUE/i.test(index.sql) ? 'UNIQUE ' : '';
  return `CREATE ${unique}INDEX ${quote(name)} ON ${quote(table)} ${tail}`;
}
export function recoverResizeTables(db) {
  db.exec(`DROP TABLE IF EXISTS ${shadow}; DROP TABLE IF EXISTS ${retired}`);
  // A completed cutover can leave the alternate names in place. Restore the
  // canonical names before the regular migrations check CREATE IF NOT EXISTS.
  const swapped = indices(db, 'cells').filter(index => index.name.startsWith(alternate));
  if (!swapped.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const index of swapped) {
      db.exec(`DROP INDEX ${quote(index.name)}`);
      db.exec(indexOn(index, index.name.slice(alternate.length), 'cells'));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export class ResizeStaging {
  constructor(db) {
    this.db = db;
    const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='cells'").get().sql;
    db.exec(`CREATE TABLE ${shadow} ${definition.slice(definition.indexOf('('))}`);
    try {
      for (const index of indices(db, 'cells')) {
        const name = index.name.startsWith(alternate) ? index.name.slice(alternate.length) : alternate + index.name;
        db.exec(indexOn(index, name, shadow));
      }
      this.insert = db.prepare(`INSERT INTO ${shadow}(x,y,text,version,author,updatedAt,groupId,width,leadX) VALUES(?,?,?,?,?,0,?,?,?)`);
      this.remove = db.prepare(`DELETE FROM ${shadow} WHERE x=? AND y=?`);
    } catch (error) { db.exec(`DROP TABLE ${shadow}`); throw error; }
  }
  put(cell) {
    this.insert.run(cell.x, cell.y, cell.text, cell.version, cell.author, cell.group, cell.width, cell.leadX);
  }
  install() {
    const triggers = this.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='cells'").all();
    for (const { name } of triggers) this.db.exec(`DROP TRIGGER ${quote(name)}`);
    this.db.exec(`ALTER TABLE cells RENAME TO ${retired}; ALTER TABLE ${shadow} RENAME TO cells`);
    for (const { sql } of triggers) this.db.exec(sql);
  }
  discard(pending, pause) { return releaseTable(this.db, shadow, pending, pause); }
}
export function releaseRetired(db, pending, pause) { return releaseTable(db, retired, pending, pause); }
async function releaseTable(db, table, pending, pause) {
  // Free large old tables in small transactions after publication; a process
  // restart drops the unreferenced table before opening the world.
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) return;
  const remove = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT 256)`);
  while (!pending.cancelled && remove.run().changes) await pause();
  db.exec(`DROP TABLE ${table}`);
}
