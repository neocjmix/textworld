import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { cellKey, cellSpan } from '../shared/world.js';
import { projectLocalCells } from '../public/local-world.js';

function fixture(t, options = {}) {
  const world = new World({ width: 32, height: 16, now: () => 1000, ...options });
  t.after(() => world.close());
  let seed = 0;
  const write = (text, x, y = 3) => world.applyWrite({ text, x, y, epoch: world.epoch, author: 'seed', id: `seed-${++seed}` });
  const snapshot = () => new Map(world.snapshot().cells.map(cell => [cellKey(cell.x, cell.y), { ...cell }]));
  const apply = operation => world[operation.type === 'write' ? 'applyWrite' : 'erase']({ author: 'local-user', epoch: world.epoch, ...operation });
  return { world, write, snapshot, apply };
}

const shape = cells => [...cells.values()].map(cell => ({
  x: cell.x, y: cell.y, text: cell.text, width: cell.width ?? 1, leadX: cell.leadX ?? null,
})).sort((a, b) => a.y - b.y || a.x - b.x);
const cell = (cells, x, y = 3) => cells.get(cellKey(x, y));

test('local native replacement matches the server and leaves the authoritative map and suffix untouched', t => {
  const { world, write, snapshot, apply } = fixture(t);
  write('Pnihon!S', 4);
  const base = snapshot(), original = structuredClone(base), suffix = cell(base, 10);
  const operation = { type: 'write', id: 'candidate', x: 5, y: 3, text: '日本', clear: [5, 6, 7, 8, 9].map(x => ({ x, y: 3 })) };
  const request = structuredClone(operation);
  const view = projectLocalCells(base, [operation], world);
  apply(operation);
  assert.deepEqual(shape(view), shape(snapshot()));
  assert.deepEqual(base, original); assert.deepEqual(operation, request);
  assert.equal(cell(view, 10), suffix, 'untouched suffix retains its original object and metadata');
  assert.equal(cell(view, 9), undefined);
  assert.equal(cell(view, 5).version, 'local:candidate');
  assert.equal(cell(view, 6).version, 'local:candidate');
});

test('queued wide writes, a half overwrite, and deletion project in send order', t => {
  const { world, snapshot, apply } = fixture(t);
  const operations = [
    { type: 'write', id: 'one', x: 8, y: 3, text: '한글S' },
    { type: 'write', id: 'two', x: 9, y: 3, text: '文' },
    { type: 'erase', id: 'three', x: 10, y: 3 },
    { type: 'write', id: 'four', x: 8, y: 3, text: '語A' },
  ];
  const base = snapshot();
  for (let end = 1; end <= operations.length; end++) {
    const view = projectLocalCells(base, operations.slice(0, end), world);
    apply(operations[end - 1]);
    assert.deepEqual(shape(view), shape(snapshot()), `pending prefix ${end}`);
  }
  const view = projectLocalCells(base, operations, world);
  assert.equal(cell(view, 12).text, 'S'); assert.equal(cell(view, 11), undefined);
  assert.equal(cellSpan((x, y) => cell(view, x, y), 9, 3, world).length, 2);
});

test('a torus seam half-clear and a long self-overwriting paste match server footprints', t => {
  const { world, write, snapshot, apply } = fixture(t);
  write('한S', 31);
  const operations = [
    { type: 'write', id: 'seam', x: 31, y: 3, text: 'Q', clear: [{ x: 0, y: 3 }] },
    { type: 'write', id: 'lap', x: 28, y: 3, text: '中文'.repeat(12) + 'A' },
    { type: 'erase', id: 'wrapped-delete', x: -1, y: 19 },
  ];
  const base = snapshot();
  for (let end = 1; end <= operations.length; end++) {
    const view = projectLocalCells(base, operations.slice(0, end), world);
    apply(operations[end - 1]);
    assert.deepEqual(shape(view), shape(snapshot()));
  }
});

test('a clear-only native edit immediately removes both wide halves without shifting neighbors', t => {
  const { world, write, snapshot, apply } = fixture(t);
  write('P한AB', 7);
  const base = snapshot(), neighbor = cell(base, 11);
  const operation = { type: 'write', id: 'remove', x: 8, y: 3, text: '', clear: [{ x: 9, y: 3 }, { x: 10, y: 3 }] };
  const view = projectLocalCells(base, [operation], world);
  apply(operation);
  assert.deepEqual(shape(view), shape(snapshot()));
  assert.equal(cell(view, 11), neighbor);
  for (const x of [8, 9, 10]) assert.equal(cell(view, x), undefined);
});

test('remaining local edits rebase on remote writes and own echoes without reviving stale cells', t => {
  const { world, write, snapshot, apply } = fixture(t);
  write('original', 5);
  const first = { type: 'write', id: 'first', x: 5, y: 3, text: '한' };
  const second = { type: 'write', id: 'second', x: 6, y: 3, text: 'B' };
  const initial = snapshot();
  const predicted = projectLocalCells(initial, [first, second], world);
  assert.equal(cell(predicted, 5), undefined); assert.equal(cell(predicted, 6).text, 'B');

  apply(first); // Own echo acknowledges only the first pending operation.
  write('文', 6); // A remote overwrite becomes part of the authoritative base.
  const base = snapshot(), before = structuredClone(base);
  const view = projectLocalCells(base, [second], world);
  apply(second);
  assert.deepEqual(shape(view), shape(snapshot()));
  assert.deepEqual(base, before);
  assert.equal(cell(view, 7), undefined, 'replay clears the remote glyph tail too');

  write('新', 6); // A later remote write must win once no local operation remains.
  const authoritative = snapshot(), settled = projectLocalCells(authoritative, [], world);
  assert.deepEqual(settled, authoritative);
  assert.equal(cell(settled, 6).text, '新');
  assert.notEqual(cell(settled, 6).version, 'local:second');
});

test('discarding rejected or disconnected edits restores the current authority, not an old snapshot', t => {
  const { world, write, snapshot } = fixture(t);
  write('first', 4);
  const operation = { type: 'erase', id: 'pending', x: 4, y: 3 };
  const base = snapshot();
  assert.equal(cell(projectLocalCells(base, [operation], world), 4), undefined);
  write('latest', 4);
  const current = snapshot();
  const restored = projectLocalCells(current, [], world);
  assert.deepEqual(restored, current);
  assert.equal(cell(restored, 4).text, 'l');
  assert.equal(cell(base, 4).text, 'f');
});

test('multiline and tab input use the same writing origin as the server', t => {
  const { world, write, snapshot, apply } = fixture(t);
  write('unchanged', 20, 6);
  const base = snapshot();
  const operation = { type: 'write', id: 'paste', x: 29, y: 15, lineStartX: 7, text: '한\tA\r\n中文\nZ' };
  const view = projectLocalCells(base, [operation], world);
  apply(operation);
  assert.deepEqual(shape(view), shape(snapshot()));
  assert.equal(cell(view, 7, 0).text, '中'); assert.equal(cell(view, 7, 1).text, 'Z');
  assert.equal(cell(view, 20, 6), cell(base, 20, 6));
});
