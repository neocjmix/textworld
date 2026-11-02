import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { wrap, graphemes, gpsToCell, writePlan } from '../shared/world.js';

function fixture(t, options = {}) {
  const world = new World({ width: 64, height: 32, ...options });
  t.after(() => world.close());
  let nextId = 0;
  const write = (text, x = 0, y = 0, author = 'alice') => world.applyWrite({
    text, x, y, author, id: `input-${++nextId}`, epoch: world.epoch,
  });
  return { world, write };
}

test('overwrite and deletion leave neighboring cell contents and versions unchanged', t => {
  const { world, write } = fixture(t);
  write('ABC', 4, 7);
  const left = { ...world.getCell(4, 7) };
  const right = { ...world.getCell(6, 7) };
  write('한', 5, 7, 'bob');
  assert.equal(world.getCell(5, 7).text, '한');
  assert.deepEqual(world.getCell(4, 7), left);
  assert.deepEqual(world.getCell(6, 7), right);
  world.erase({ author: 'bob', id: 'delete', epoch: world.epoch, x: 5, y: 7 });
  assert.equal(world.getCell(5, 7).text, '');
  assert.deepEqual(world.getCell(4, 7), left);
  assert.deepEqual(world.getCell(6, 7), right);
  assert.equal(world.snapshot().cells.length, 2);
});

test('toroidal addressing handles negative positions and crossing both seams', t => {
  const { world, write } = fixture(t);
  const result = write('AB\nC', -1, -1);
  assert.equal(world.getCell(63, 31).text, 'A');
  assert.equal(world.getCell(0, 31).text, 'B');
  assert.equal(world.getCell(63, 0).text, 'C');
  assert.deepEqual(result.cursor, { x: 0, y: 0 });
  assert.equal(wrap(-129, 64), 63);
  assert.equal(wrap(192, 64), 0);
});

test('a paste longer than one circumference overwrites addresses rather than creating a new row', t => {
  const { world, write } = fixture(t, { width: 32, height: 16 });
  const result = write('a'.repeat(32) + 'BC', 0, 2);
  assert.equal(world.getCell(0, 2).text, 'B');
  assert.equal(world.getCell(1, 2).text, 'C');
  assert.equal(world.getCell(31, 2).text, 'a');
  assert.equal(world.getCell(0, 3), undefined);
  assert.equal(result.cells.length, 32);
  assert.equal(new Set(result.cells.map(c => `${c.x},${c.y}`)).size, 32);
  assert.deepEqual(result.cursor, { x: 2, y: 2 });
});

test('Korean decomposed syllables, combining accents, flags and ZWJ emoji each occupy one cell', t => {
  const { world, write } = fixture(t);
  const input = '한e\u0301🇰🇷👨‍👩‍👧‍👦';
  assert.deepEqual(graphemes(input), ['한', 'é', '🇰🇷', '👨‍👩‍👧‍👦']);
  const result = write(input, 10, 10);
  assert.deepEqual(result.cells.map(c => c.text), ['한', 'é', '🇰🇷', '👨‍👩‍👧‍👦']);
  assert.deepEqual(result.cursor, { x: 14, y: 10 });
  assert.equal(world.snapshot().cells.length, 4);
});

test('newline resets to the write origin and CRLF never creates an extra cell', () => {
  const plan = writePlan('가나\r\n다', 5, 15, { width: 32, height: 16 });
  assert.deepEqual(plan.cells, [
    { x: 5, y: 15, text: '가' }, { x: 6, y: 15, text: '나' }, { x: 5, y: 0, text: '다' },
  ]);
  assert.deepEqual(plan.cursor, { x: 6, y: 0 });
});

test('server ordering converges same-cell overwrites and a retried earlier operation cannot resurrect text', t => {
  const { world } = fixture(t);
  const a = { author: 'alice', id: 'a-1', epoch: world.epoch, x: 3, y: 4, text: 'A' };
  const first = world.applyWrite(a);
  const second = world.applyWrite({ ...a, author: 'bob', id: 'b-1', text: 'B' });
  assert.ok(second.seq > first.seq);
  assert.equal(world.getCell(3, 4).text, 'B');
  assert.equal(world.getCell(3, 4).version, second.seq);
  const retry = world.applyWrite(a);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.seq, first.seq);
  assert.equal(world.seq, second.seq);
  assert.equal(world.getCell(3, 4).text, 'B');
});

test('growth keeps cell identity and provenance while rejecting stale-epoch writes', t => {
  const { world, write } = fixture(t);
  write('가', 63, 31);
  const before = { ...world.getCell(63, 31) };
  const oldEpoch = world.epoch;
  assert.equal(world.resize(128, 64).changed, true);
  assert.deepEqual(world.getCell(63, 31), before);
  assert.equal(world.epoch, oldEpoch + 1);
  assert.throws(() => world.applyWrite({
    author: 'alice', id: 'late', epoch: oldEpoch, x: 63, y: 31, text: 'X',
  }), { code: 'STALE_EPOCH' });
  assert.deepEqual(world.getCell(63, 31), before);
});

test('shrink never aliases occupied cells or removes a present cursor', t => {
  const { world, write } = fixture(t, { width: 128, height: 64 });
  write('A', 1, 1);
  write('B', 65, 1);
  assert.deepEqual(world.resize(64, 32), { changed: false, reason: 'occupied-boundary' });
  assert.equal(world.getCell(1, 1).text, 'A');
  assert.equal(world.getCell(65, 1).text, 'B');
  world.erase({ author: 'alice', id: 'remove-edge', epoch: world.epoch, x: 65, y: 1 });
  assert.deepEqual(world.resize(64, 32, [{ x: 80, y: 1 }]), { changed: false, reason: 'occupied-boundary' });
  assert.equal(world.resize(64, 32, [{ x: 1, y: 1 }]).changed, true);
  assert.equal(world.snapshot().cells.length, 1);
  assert.equal(world.getCell(1, 1).text, 'A');
});

test('density adaptation grows, contracts and honors cooldown hysteresis', t => {
  let now = 1000;
  const { world } = fixture(t, { width: 32, height: 16, now: () => now });
  const peers = [{ x: 1, y: 1 }, { x: 2, y: 1 }];
  assert.equal(world.adapt(peers).reason, 'cooldown');
  now += 30001;
  assert.equal(world.adapt(peers).changed, true);
  assert.deepEqual([world.width, world.height], [64, 32]);
  assert.equal(world.adapt([]).reason, 'cooldown');
  now += 30001;
  assert.equal(world.adapt([]).changed, true);
  assert.deepEqual([world.width, world.height], [32, 16]);
  assert.equal(world.adapt([], { cooldown: 0 }).changed, false);
});

test('scavenger compare-and-delete protects fresh overwrites and records group damage evidence', t => {
  let now = 1000;
  const { world, write } = fixture(t, { now: () => now });
  write('OLD', 10, 10);
  const candidates = world.evidence({ before: now });
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(c => c.survivingGroupCells === 3 && c.revisions === 1));
  now = 2000;
  write('N', 11, 10, 'bob');
  const result = world.conditionalDelete({ id: 'cleanup-1', epoch: world.epoch, candidates });
  assert.equal(result.cells.length, 2);
  assert.equal(world.getCell(10, 10).text, '');
  assert.equal(world.getCell(11, 10).text, 'N');
  assert.equal(world.getCell(12, 10).text, '');
  const fresh = world.evidence({ before: 2000 });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].revisions, 2);
  assert.equal(fresh[0].author, 'bob');
  const retry = world.conditionalDelete({ id: 'cleanup-1', epoch: world.epoch, candidates });
  assert.equal(retry.duplicate, true);
  assert.equal(world.getCell(11, 10).text, 'N');
});

test('GPS projection wraps the antimeridian, stays bounded at poles, and rejects invalid latitude', () => {
  const size = { width: 128, height: 64 };
  assert.deepEqual(gpsToCell(0, -180, size), gpsToCell(0, 180, size));
  assert.deepEqual(gpsToCell(0, 0, size), { x: 64, y: 32 });
  assert.equal(gpsToCell(90, 0, size).y, 0);
  assert.equal(gpsToCell(-90, 0, size).y, 63);
  for (let latitude = -90; latitude <= 90; latitude += 5) {
    for (let longitude = -540; longitude <= 540; longitude += 30) {
      const { x, y } = gpsToCell(latitude, longitude, size);
      assert.ok(Number.isInteger(x) && Number.isInteger(y));
      assert.ok(x >= 0 && x < size.width && y >= 0 && y < size.height);
    }
  }
  assert.throws(() => gpsToCell(91, 0, size), RangeError);
  assert.throws(() => gpsToCell(NaN, 0, size), RangeError);
  assert.throws(() => gpsToCell(0, Infinity, size), RangeError);
});

test('durable restart restores text, deletion, topology, operation order, deduplication and evidence', t => {
  const directory = mkdtempSync(join(tmpdir(), 'textworld-engine-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'world.sqlite');
  let world = new World({ storagePath, width: 64, height: 32, now: () => 1234 });
  const operation = { author: 'alice', id: 'persistent-input', epoch: 1, x: 4, y: 5, text: '한글' };
  world.applyWrite(operation);
  world.erase({ author: 'bob', id: 'persistent-delete', epoch: 1, x: 5, y: 5 });
  world.resize(128, 64);
  const metadata = world.metadata();
  world.close();
  world = new World({ storagePath, width: 32, height: 16 });
  t.after(() => world.close());
  assert.deepEqual(world.metadata(), metadata);
  assert.equal(world.getCell(4, 5).text, '한');
  assert.equal(world.getCell(5, 5).text, '');
  assert.equal(world.snapshot().cells.length, 1);
  assert.equal(world.applyWrite(operation).duplicate, true);
  assert.equal(world.seq, metadata.seq);
  assert.equal(world.evidence()[0].author, 'alice');
  assert.equal(world.evidence()[0].updatedAt, 1234);
});

test('invalid write payloads do not mutate the world or advance its sequence', t => {
  const { world } = fixture(t);
  const base = { author: 'alice', id: 'bad', epoch: world.epoch, x: 0, y: 0, text: 'X' };
  for (const patch of [{ x: 0.5 }, { y: NaN }, { text: 'x'.repeat(513) }, { text: '\u0000' }, { text: null }]) {
    assert.throws(() => world.applyWrite({ ...base, ...patch }));
    assert.equal(world.seq, 0);
    assert.equal(world.snapshot().cells.length, 0);
  }
});
