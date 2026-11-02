import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeProjection, NativeProjectionError } from '../shared/native-projection.js';
import { World } from '../server/world.js';

function fixture(t, cursor = { x: 10, y: 8 }, size = {}) {
  const world = new World(size), projection = new NativeProjection(cursor);
  t.after(() => world.close());
  let position = { ...cursor }, serial = 0;
  function commit(start, end, text, selectionEnd = start + text.length) {
    const before = projection.text, after = before.slice(0, start) + text + before.slice(end);
    const plan = projection.plan({ before, start, end, text, after, selectionStart: selectionEnd, selectionEnd }, position, world, { lineStartX: cursor.x });
    // Exercise projection semantics without depending on the transport's atomic
    // replacement implementation (that is tested by the server integration suite).
    if (plan.changed) {
      for (const point of plan.clear) world.erase({ author: 'native', id: `e${++serial}`, epoch: world.epoch, ...point });
      if (plan.text) world.applyWrite({ author: 'native', id: `w${++serial}`, epoch: world.epoch, x: plan.x, y: plan.y, text: plan.text, lineStartX: cursor.x });
    }
    projection.accept(plan); position = plan.cursor;
    return plan;
  }
  return { world, projection, commit, get cursor() { return position; } };
}

test('native UTF-16 replacement corrects a provisional Korean jamo at its original address', t => {
  const f = fixture(t);
  f.commit(0, 0, 'ㅎ');
  const corrected = f.commit(0, 1, '한');
  assert.deepEqual(corrected.clear, [{ x: 10, y: 8 }, { x: 11, y: 8 }]);
  assert.equal(f.world.getCell(10, 8).text, '한');
  assert.deepEqual(f.cursor, { x: 12, y: 8 });
  f.commit(1, 1, '글');
  assert.equal(f.world.getCell(12, 8).text, '글');
  assert.equal(f.projection.text, '한글');
  assert.equal(f.projection.entries.length, 2);
});

test('Japanese and Chinese range conversion replaces long runs without a 32-character heuristic', t => {
  const f = fixture(t);
  const source = 'にほんご'.repeat(10);
  f.commit(0, 0, source);
  const conversion = f.commit(0, source.length, '日本語中文');
  assert.equal(conversion.clear.length, source.length * 2);
  assert.deepEqual(f.cursor, { x: 20, y: 8 });
  assert.equal(f.world.getCell(10, 8).text, '日');
  assert.equal(f.world.getCell(18, 8).text, '文');
  assert.equal(f.world.getCell(20, 8).text, '');
  assert.equal(conversion.historyToCursor.length, 5);
});

test('appending a combining mark resegments the touched glyph while preserving raw native offsets', t => {
  const f = fixture(t);
  f.commit(0, 0, 'e');
  const mark = f.commit(1, 1, '\u0301');
  assert.equal(mark.x, 10);
  assert.equal(mark.text, 'e\u0301');
  assert.equal(f.projection.text.length, 2, 'DOM UTF-16 text must not be normalized');
  assert.equal(f.world.getCell(10, 8).text, 'é');
  assert.deepEqual(f.cursor, { x: 11, y: 8 });
  const removeAccent = f.commit(1, 2, '');
  assert.equal(removeAccent.text, 'e');
  assert.equal(f.world.getCell(10, 8).text, 'e');
  assert.deepEqual(f.cursor, { x: 11, y: 8 });
});

test('decomposed Hangul and surrogate/ZWJ ranges use native UTF-16 rather than grapheme indexes', t => {
  const f = fixture(t);
  f.commit(0, 0, '\u1112');
  f.commit(1, 1, '\u1161');
  f.commit(2, 2, '\u11ab');
  assert.equal(f.projection.text.length, 3);
  assert.equal(f.world.getCell(10, 8).text, '한');
  assert.deepEqual(f.cursor, { x: 12, y: 8 });
  f.commit(3, 3, '👩👧');
  const joined = f.commit(5, 5, '\u200d');
  assert.equal(joined.x, 12);
  assert.equal(joined.text, '👩‍👧');
  assert.equal(f.world.getCell(12, 8).text, '👩‍👧');
  assert.equal(f.world.getCell(14, 8).text, '');
  assert.equal(f.projection.text, '\u1112\u1161\u11ab👩‍👧');
});

test('a middle conversion keeps an unchanged suffix at its original world coordinates', t => {
  const f = fixture(t);
  f.commit(0, 0, 'abcdZ');
  const converted = f.commit(0, 4, '中');
  assert.equal(f.world.getCell(10, 8).text, '中');
  assert.equal(f.world.getCell(12, 8).text, '');
  assert.equal(f.world.getCell(14, 8).text, 'Z', 'suffix must not collapse into the shortened prefix');
  assert.deepEqual(f.projection.entries.at(-1).from, { x: 14, y: 8 });
  assert.deepEqual(converted.cursor, { x: 12, y: 8 });
  assert.equal(converted.historyToCursor.length, 1);
  assert.equal(converted.connectsToBase, true);
  // Inserting at the native caret fills the spatial gap instead of moving Z.
  f.commit(1, 1, 'X');
  assert.equal(f.world.getCell(12, 8).text, 'X');
  assert.equal(f.world.getCell(14, 8).text, 'Z');
});

test('growth into an unchanged suffix invalidates only the overwritten native mappings', t => {
  const f = fixture(t);
  f.commit(0, 0, 'AZQ');
  f.commit(0, 1, '中');
  assert.equal(f.world.getCell(10, 8).text, '中');
  assert.equal(f.world.getCell(12, 8).text, 'Q');
  assert.equal(f.projection.entries[1].valid, false, 'Z address was overwritten by the wide glyph');
  assert.equal(f.projection.entries[2].valid, true);
  assert.throws(() => f.commit(1, 2, 'X'), NativeProjectionError);
  assert.equal(f.world.getCell(10, 8).text, '中');
  assert.equal(f.world.getCell(12, 8).text, 'Q');
});

test('native deletion clears the selected glyph without moving a following glyph', t => {
  const f = fixture(t);
  f.commit(0, 0, 'A한B');
  const removed = f.commit(1, 2, '');
  assert.equal(removed.text, '');
  assert.deepEqual(removed.clear, [{ x: 11, y: 8 }, { x: 12, y: 8 }]);
  assert.equal(f.world.getCell(10, 8).text, 'A');
  assert.equal(f.world.getCell(11, 8).text, '');
  assert.equal(f.world.getCell(13, 8).text, 'B');
  assert.deepEqual(f.cursor, { x: 11, y: 8 });
});

test('deleting a prefix keeps the caret in its cleared space before an unmoved suffix', t => {
  const f = fixture(t);
  f.commit(0, 0, 'ABZ');
  const deletion = f.commit(0, 2, '');
  assert.equal(f.world.getCell(12, 8).text, 'Z');
  assert.deepEqual(deletion.cursor, { x: 10, y: 8 });
  assert.deepEqual(f.projection.pointAt(0), { x: 10, y: 8 });
  f.commit(0, 0, 'Q');
  assert.equal(f.world.getCell(10, 8).text, 'Q');
  assert.equal(f.world.getCell(12, 8).text, 'Z');
});

test('tab/newline context and torus seams retain exact spatial traces for later correction', t => {
  const f = fixture(t, { x: 126, y: 63 });
  f.commit(0, 0, '한\t\n中');
  assert.equal(f.world.getCell(126, 63).text, '한');
  assert.equal(f.world.getCell(0, 63).text, ' ');
  assert.equal(f.world.getCell(126, 0).text, '中');
  assert.equal(f.projection.entries[1].steps.length, 4);
  const corrected = f.commit(3, 4, '文');
  assert.equal(f.world.getCell(126, 0).text, '文');
  assert.deepEqual(corrected.cursor, { x: 0, y: 0 });
  assert.equal(corrected.historyToCursor.length, 7);
  assert.equal(corrected.connectsToBase, true);
});

test('a native no-op conversion changes neither cells nor its ledger while selection can move', t => {
  const f = fixture(t);
  f.commit(0, 0, '日本');
  const seq = f.world.seq;
  const plan = f.commit(0, 2, '日本', 1);
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.clear, []);
  assert.equal(plan.text, '');
  assert.deepEqual(plan.cursor, { x: 12, y: 8 });
  assert.equal(f.world.seq, seq);
});

test('stale context, inconsistent ranges, and overlapping long torus history cannot erase guessed cells', t => {
  const f = fixture(t, { x: 0, y: 0 }, { width: 32, height: 16 });
  f.commit(0, 0, 'a'.repeat(40));
  assert.equal(f.projection.entries[0].valid, false);
  assert.throws(() => f.commit(0, 1, 'X'), NativeProjectionError);
  const seq = f.world.seq;
  assert.throws(() => f.projection.plan({ before: '', start: 0, end: 0, text: 'x', after: 'x' }, f.cursor, f.world), NativeProjectionError);
  assert.throws(() => f.projection.plan({ before: f.projection.text, start: 1, end: 2, text: 'x', after: 'wrong' }, f.cursor, f.world), NativeProjectionError);
  assert.equal(f.world.seq, seq);
  f.projection.reset({ x: 20, y: 4 });
  assert.equal(f.projection.text, '');
  assert.deepEqual(f.projection.pointAt(0), { x: 20, y: 4 });
});
