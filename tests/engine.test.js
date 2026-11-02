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
  write('X', 5, 7, 'bob');
  assert.equal(world.getCell(5, 7).text, 'X');
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

test('Korean and emoji occupy two columns while combining accents remain one glyph column', t => {
  const { world, write } = fixture(t);
  const input = '한e\u0301🇰🇷👨‍👩‍👧‍👦';
  assert.deepEqual(graphemes(input), ['한', 'é', '🇰🇷', '👨‍👩‍👧‍👦']);
  const result = write(input, 10, 10);
  assert.deepEqual(result.cells.filter(c => c.text).map(c => [c.x, c.text, c.width]), [[10, '한', 2], [12, 'é', 1], [13, '🇰🇷', 2], [15, '👨‍👩‍👧‍👦', 2]]);
  assert.deepEqual(result.cursor, { x: 17, y: 10 });
  assert.equal(world.snapshot().cells.length, 7);
});

test('newline resets to the write origin and CRLF never creates an extra cell', () => {
  const plan = writePlan('가나\r\n다', 5, 15, { width: 32, height: 16 });
  assert.deepEqual(plan.cells, [
    { x: 5, y: 15, text: '가', width: 2 }, { x: 6, y: 15, text: '', width: 0, leadX: 5 },
    { x: 7, y: 15, text: '나', width: 2 }, { x: 8, y: 15, text: '', width: 0, leadX: 7 },
    { x: 5, y: 0, text: '다', width: 2 }, { x: 6, y: 0, text: '', width: 0, leadX: 5 },
  ]);
  assert.deepEqual(plan.cursor, { x: 7, y: 0 });
});

test('explicit line origin preserves the current insertion cell and aligns subsequent rows', t => {
  const { world, write } = fixture(t);
  write('AB', 7, 3);
  write('N', 6, 4, 'neighbor');
  const neighbor = { ...world.getCell(6, 4) };
  const result = world.applyWrite({
    author: 'alice', id: 'continue-lines', epoch: world.epoch,
    x: 9, y: 3, text: 'CD\nEF\nG', lineStartX: 7,
  });
  assert.deepEqual(result.cells.map(({ x, y, text }) => ({ x, y, text })), [
    { x: 9, y: 3, text: 'C' }, { x: 10, y: 3, text: 'D' },
    { x: 7, y: 4, text: 'E' }, { x: 8, y: 4, text: 'F' },
    { x: 7, y: 5, text: 'G' },
  ]);
  assert.deepEqual(result.cursor, { x: 8, y: 5 });
  assert.equal(world.getCell(7, 3).text, 'A');
  assert.equal(world.getCell(8, 3).text, 'B');
  assert.deepEqual(world.getCell(6, 4), neighbor);
});

test('typing a prefix then pasting lines matches one multiline paste with the same origin', t => {
  const { world: incremental } = fixture(t);
  const { world: pasted } = fixture(t);
  const origin = { x: 7, y: 3, lineStartX: 7, epoch: 1, author: 'alice' };
  let cursor = { x: origin.x, y: origin.y };
  for (const [index, text] of ['한', '글', 'ABC\n두번째\n끝'].entries()) {
    cursor = incremental.applyWrite({ ...origin, ...cursor, id: `part-${index}`, text }).cursor;
  }
  const whole = pasted.applyWrite({ ...origin, id: 'whole', text: '한글ABC\n두번째\n끝' });
  const content = world => world.snapshot().cells
    .map(({ x, y, text }) => ({ x, y, text }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  assert.deepEqual(content(incremental), content(pasted));
  assert.deepEqual(cursor, whole.cursor);
});

test('line origin wraps independently at torus seams and legacy clients retain paste-origin behavior', () => {
  const size = { width: 32, height: 16 };
  const anchored = writePlan('AB\r\nC\nD', 31, 15, size, { lineStartX: -2 });
  assert.deepEqual(anchored.cells, [
    { x: 31, y: 15, text: 'A' }, { x: 0, y: 15, text: 'B' },
    { x: 30, y: 0, text: 'C' }, { x: 30, y: 1, text: 'D' },
  ]);
  assert.deepEqual(anchored.cursor, { x: 31, y: 1 });
  const legacy = writePlan('A\nB', 31, 15, size);
  assert.deepEqual(legacy.cells, [
    { x: 31, y: 15, text: 'A' }, { x: 31, y: 0, text: 'B' },
  ]);
  assert.deepEqual(legacy.cursor, { x: 0, y: 0 });
});

test('write-plan traversal preserves newline return points across both torus seams', () => {
  const plan = writePlan('AB\nC', 31, 15, { width: 32, height: 16 }, { lineStartX: 30 });
  assert.deepEqual(plan.steps, [
    { kind: 'write', from: { x: 31, y: 15 }, to: { x: 0, y: 15 } },
    { kind: 'write', from: { x: 0, y: 15 }, to: { x: 1, y: 15 } },
    { kind: 'return', from: { x: 1, y: 15 }, to: { x: 30, y: 0 } },
    { kind: 'write', from: { x: 30, y: 0 }, to: { x: 31, y: 0 } },
  ]);
  // Undoing the last glyph reaches the return point; reversing that return
  // then finds the former line end rather than the cell left of the new line.
  let cursor = plan.cursor;
  for (const step of [...plan.steps].reverse()) {
    assert.deepEqual(cursor, step.to);
    cursor = step.from;
  }
  assert.deepEqual(cursor, { x: 31, y: 15 });
  const newline = writePlan('\r\n', 12, 15, { width: 32, height: 16 }, { lineStartX: 7 });
  assert.deepEqual(newline.cells, []);
  assert.deepEqual(newline.steps, [
    { kind: 'return', from: { x: 12, y: 15 }, to: { x: 7, y: 0 } },
  ]);
});

test('write-plan traversal retains every tab and repeated-address step without adding durable fields', t => {
  const { world } = fixture(t, { width: 32, height: 16 });
  const tabs = writePlan('\t', 31, 2, world);
  assert.equal(tabs.steps.length, 4);
  assert.ok(tabs.steps.every(step => step.kind === 'write'));
  assert.deepEqual(tabs.steps.map(step => step.from.x), [31, 0, 1, 2]);
  assert.deepEqual(tabs.cursor, { x: 3, y: 2 });
  const repeated = writePlan('A'.repeat(32) + 'B', 0, 2, world);
  assert.equal(repeated.cells.length, 32);
  assert.equal(repeated.steps.length, 33);
  assert.deepEqual(repeated.steps[0].from, repeated.steps[32].from);
  const committed = world.applyWrite({ author: 'alice', id: 'no-trail-storage', epoch: world.epoch, x: 0, y: 2, text: 'A\nB', lineStartX: 7 });
  assert.equal('steps' in committed, false);
  const stored = JSON.parse(world.db.prepare('SELECT result FROM operations WHERE author=? AND id=?').get('alice', 'no-trail-storage').result);
  assert.equal('steps' in stored, false);
});

test('invalid line origins do not mutate cells, operation order or provenance', t => {
  const { world, write } = fixture(t);
  write('기존', 5, 6);
  const before = world.snapshot();
  const evidence = world.evidence();
  for (const [index, lineStartX] of [null, '7', NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
    assert.throws(() => world.applyWrite({
      author: 'alice', id: `bad-origin-${index}`, epoch: world.epoch,
      x: 5, y: 6, text: 'X\nY', lineStartX,
    }), { code: 'BAD_POSITION' });
    assert.deepEqual(world.snapshot(), before);
    assert.deepEqual(world.evidence(), evidence);
  }
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
  write('A', 63, 31);
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
  world.erase({ author: 'bob', id: 'persistent-delete', epoch: 1, x: 6, y: 5 });
  world.resize(128, 64);
  const metadata = world.metadata();
  world.close();
  world = new World({ storagePath, width: 32, height: 16 });
  t.after(() => world.close());
  assert.deepEqual(world.metadata(), metadata);
  assert.equal(world.getCell(4, 5).text, '한');
  assert.equal(world.getCell(5, 5).width, 0);
  assert.equal(world.getCell(6, 5).text, '');
  assert.equal(world.getCell(7, 5).text, '');
  assert.equal(world.snapshot().cells.length, 2);
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
