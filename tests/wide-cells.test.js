import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { WritingSession } from '../shared/writing.js';
import { cellKey, occupiedCell, writePlan } from '../shared/world.js';

function fixture(t, options = {}) {
  const world = new World({ width: 64, height: 32, ...options });
  t.after(() => world.close());
  let id = 0;
  const write = (text, x, y = 3, author = 'writer') => world.applyWrite({ text, x, y, author, id: `w${++id}`, epoch: world.epoch });
  const erase = (x, y = 3) => world.erase({ x, y, author: 'eraser', id: `e${++id}`, epoch: world.epoch });
  return { world, write, erase };
}
function validSpans(world) {
  for (const cell of world.snapshot().cells) {
    if (cell.width === 2) {
      const tail = world.getCell(cell.x + 1, cell.y);
      assert.equal(tail.width, 0); assert.equal(tail.leadX, cell.x);
      assert.equal(tail.version, cell.version); assert.equal(tail.author, cell.author);
    } else if (cell.width === 0) {
      const lead = world.getCell(cell.leadX, cell.y);
      assert.equal(lead.width, 2); assert.equal(lead.version, cell.version);
      assert.equal((lead.x + 1) % world.width, cell.x);
    }
  }
}

test('mixed text occupies deterministic columns and preserves an outside neighbour', t => {
  const { world, write } = fixture(t);
  write('N', 18); const neighbor = { ...world.getCell(18, 3) };
  const result = write('A한B字', 10);
  assert.deepEqual(result.cursor, { x: 16, y: 3 });
  assert.deepEqual(result.cells.filter(c => c.text).map(c => [c.x, c.text, c.width]), [[10, 'A', 1], [11, '한', 2], [13, 'B', 1], [14, '字', 2]]);
  assert.equal(world.getCell(12, 3).width, 0); assert.equal(world.getCell(15, 3).width, 0);
  assert.deepEqual(world.getCell(18, 3), neighbor);
  validSpans(world);
});

test('overwriting either half clears the displaced whole glyph without reflow', t => {
  const { world, write, erase } = fixture(t);
  write('한글', 10);
  const result = write('字', 11);
  // New width-two glyph touches the tail of 한 and the head of 글.
  assert.equal(world.getCell(10, 3).text, ''); assert.equal(world.getCell(13, 3).text, '');
  assert.equal(world.getCell(11, 3).text, '字'); assert.equal(world.getCell(12, 3).leadX, 11);
  assert.equal(result.cells.length, 4); assert.ok(result.cells.every(c => c.version === result.seq));
  validSpans(world);
  erase(12);
  assert.equal(world.snapshot().cells.length, 0);
  write('한', 10); write('X', 11);
  assert.equal(world.getCell(10, 3).text, ''); assert.equal(world.getCell(11, 3).text, 'X');
  write('한', 10); write('Y', 10);
  assert.equal(world.getCell(10, 3).text, 'Y'); assert.equal(world.getCell(11, 3).text, '');
  validSpans(world);
});

test('competing wide and narrow overwrites converge and retries do not resurrect a span', t => {
  const { world } = fixture(t);
  const first = { author: 'a', id: 'wide', epoch: 1, x: 10, y: 3, text: '한' };
  world.applyWrite(first);
  world.applyWrite({ author: 'b', id: 'tail', epoch: 1, x: 11, y: 3, text: 'B' });
  world.applyWrite({ author: 'c', id: 'new-wide', epoch: 1, x: 9, y: 3, text: '字' });
  const before = world.snapshot();
  assert.equal(world.applyWrite(first).duplicate, true);
  assert.deepEqual(world.snapshot(), before);
  assert.equal(world.getCell(9, 3).text, '字'); assert.equal(world.getCell(11, 3).text, 'B');
  validSpans(world);
});

test('wide glyphs crossing the seam no longer block growth or shrink', t => {
  const {world,write}=fixture(t);write('한',63,31);assert.equal(world.getCell(0,31).leadX,63);
  assert.equal(world.resize(128,64,[],{seed:42}).changed,true);validSpans(world);
  assert.equal(world.resize(32,16,[],{seed:43}).changed,true);validSpans(world);
});
test('contraction removes no dangling wide continuations', t => {
  const {world,write}=fixture(t);write('한',31);assert.equal(world.resize(32,16).changed,true);validSpans(world);
  assert.equal(world.adapt([],{cooldown:0}).density,world.snapshot().cells.filter(occupiedCell).length/(32*16));
});

test('a paste wrapping over its own span leaves no orphan and matches split input', t => {
  const { world: combined, write } = fixture(t, { width: 32, height: 16 });
  const { world: split } = fixture(t, { width: 32, height: 16 });
  const text = `한${'a'.repeat(31)}`;
  const result = write(text, 0);
  const first = split.applyWrite({ author: 'a', id: 'first', epoch: 1, x: 0, y: 3, text: '한' });
  const second = split.applyWrite({ author: 'a', id: 'second', epoch: 1, ...first.cursor, text: 'a'.repeat(31) });
  const content = world => world.snapshot().cells.map(({ x, y, text, width, leadX }) => ({ x, y, text, width, leadX })).sort((a, b) => a.x - b.x);
  assert.deepEqual(content(combined), content(split)); assert.deepEqual(result.cursor, second.cursor);
  assert.equal(combined.getCell(0, 3).text, 'a'); assert.equal(combined.getCell(1, 3).text, '');
  validSpans(combined); validSpans(split);
  const plan = writePlan(text, 0, 3, combined);
  assert.equal(plan.steps.length, 32); assert.equal(plan.steps[0].to.x, 2);
});

test('scavenger removes complete observed spans and protects subsequent half overwrites', t => {
  let now = 1000;
  const { world, write } = fixture(t, { now: () => now });
  write('한', 10);
  const old = world.evidence();
  assert.equal(old.length, 1); assert.equal(old[0].survivingGroupCells, 2);
  now = 2000; write('X', 11, 3, 'new-writer');
  assert.equal(world.conditionalDelete({ id: 'stale', epoch: 1, candidates: old }).cells.length, 0);
  assert.equal(world.getCell(11, 3).text, 'X');
  write('글', 20);
  const fresh = world.evidence().filter(c => c.x === 20);
  const removed = world.conditionalDelete({ id: 'fresh', epoch: 1, candidates: fresh });
  assert.equal(removed.cells.length, 2); assert.ok(removed.cells.every(c => c.text === '' && c.width === 1));
  assert.equal(world.getCell(11, 3).text, 'X'); validSpans(world);
});

test('scavenger refuses a head if continuation evidence no longer matches', t => {
  const { world, write } = fixture(t);
  write('한', 10); const evidence = world.evidence();
  // Simulate damaged imported metadata; deletion must not erase the fresh cell.
  world.cells.set(cellKey(11, 3), { ...world.getCell(11, 3), version: world.seq + 1, author: 'new' });
  const result = world.conditionalDelete({ id: 'damaged-span', epoch: 1, candidates: evidence });
  assert.equal(result.cells.length, 0); assert.equal(world.getCell(10, 3).text, '한');
});

test('Backspace retraces wide typing and resolves a preceding continuation after navigation', t => {
  const { world, write } = fixture(t);
  write('한', 10);
  const session = new WritingSession({ x: 10, y: 3 });
  const plan = session.plan('한', { x: 10, y: 3 }, world); session.accept(plan);
  assert.deepEqual(session.backspace(plan.cursor, world, world.cells), { cursor: { x: 10, y: 3 }, erase: true });
  session.reposition({ x: 12, y: 3 });
  assert.deepEqual(session.backspace({ x: 12, y: 3 }, world, world.cells), { cursor: { x: 10, y: 3 }, erase: true });
  assert.equal(session.lineStartX, 10);
});

test('legacy SQLite migration preserves old addresses while new spans and provenance survive restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'textworld-width-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'world.sqlite');
  const old = new DatabaseSync(storagePath);
  old.exec(`CREATE TABLE cells (x INTEGER,y INTEGER,text TEXT NOT NULL,version INTEGER NOT NULL,author TEXT NOT NULL,updatedAt INTEGER NOT NULL,groupId TEXT NOT NULL,PRIMARY KEY(x,y));
    INSERT INTO cells VALUES (10,3,'한',1,'old',1000,'old-write'),(11,3,'N',1,'old',1000,'old-write');
    CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES ('world','{"width":64,"height":32,"epoch":1,"seq":1}');`);
  old.close();
  let world = new World({ storagePath });
  assert.ok(world.migrationBackupPath.startsWith(`${storagePath}.pre-width-v2-`));
  const backup = new DatabaseSync(world.migrationBackupPath);
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(backup.prepare('PRAGMA table_info(cells)').all().some(column => column.name === 'width'), false);
  assert.deepEqual(backup.prepare('SELECT x,y,text,version FROM cells ORDER BY x').all().map(row => ({ ...row })), [
    { x: 10, y: 3, text: '한', version: 1 }, { x: 11, y: 3, text: 'N', version: 1 },
  ]);
  assert.equal(JSON.parse(backup.prepare("SELECT value FROM meta WHERE key='world'").get().value).seq, 1);
  backup.close();
  assert.equal(world.getCell(10, 3).width, 1); assert.equal(world.getCell(11, 3).text, 'N');
  world.applyWrite({ author: 'new', id: 'span', epoch: 1, x: 20, y: 3, text: '글' });
  const before = world.snapshot();
  assert.deepEqual(world.db.prepare('SELECT width,leadX FROM history WHERE groupId=? ORDER BY x').all('span').map(r => ({ ...r })), [{ width: 2, leadX: null }, { width: 0, leadX: 20 }]);
  world.close(); world = new World({ storagePath }); t.after(() => world.close());
  assert.equal(world.migrationBackupPath, null);
  assert.equal(readdirSync(directory).filter(name => name.includes('.pre-width-v2-')).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(world.snapshot())), JSON.parse(JSON.stringify(before))); validSpans(world);
});

test('new databases do not create pre-migration backups', t => {
  const directory = mkdtempSync(join(tmpdir(), 'textworld-new-width-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = new World({ storagePath: join(directory, 'world.sqlite') });
  assert.equal(world.migrationBackupPath, null); world.close();
  assert.equal(readdirSync(directory).some(name => name.includes('.pre-width-v2-')), false);
  const memory = new World(); assert.equal(memory.migrationBackupPath, null); memory.close();
});

test('a failed backup prevents all width schema migration and leaves legacy cells intact', t => {
  const directory = mkdtempSync(join(tmpdir(), 'textworld-backup-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'world.sqlite');
  const old = new DatabaseSync(storagePath);
  old.exec(`CREATE TABLE cells (x INTEGER,y INTEGER,text TEXT NOT NULL,version INTEGER NOT NULL,author TEXT NOT NULL,updatedAt INTEGER NOT NULL,groupId TEXT NOT NULL,PRIMARY KEY(x,y));
    INSERT INTO cells VALUES (10,3,'한',9,'old',1000,'old-write');
    CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES ('world','{"width":64,"height":32,"epoch":1,"seq":9}');`);
  old.close();
  const original = DatabaseSync.prototype.prepare;
  const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (sql === 'VACUUM INTO ?') throw new Error('Simulated disk full');
    return original.call(this, sql, ...args);
  });
  assert.throws(() => new World({ storagePath }), /backup failed; schema was not changed/);
  mock.mock.restore();
  const unchanged = new DatabaseSync(storagePath);
  assert.equal(unchanged.prepare('PRAGMA table_info(cells)').all().some(column => column.name === 'width'), false);
  assert.equal(unchanged.prepare('SELECT text,version FROM cells WHERE x=10 AND y=3').get().version, 9);
  assert.equal(unchanged.prepare('SELECT text FROM cells WHERE x=10 AND y=3').get().text, '한');
  unchanged.close();
});
