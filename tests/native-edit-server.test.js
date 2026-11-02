import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { createTextworld } from '../server/index.js';
import { connect, hasCell, hasPeer } from './ws-client.js';

function fixture(t, options = {}) {
  const world = new World({ width: 64, height: 32, ...options });
  t.after(() => world.close());
  let id = 0;
  const write = (text, x, y = 3) => world.applyWrite({ author: 'seed', id: `seed-${++id}`, epoch: world.epoch, x, y, text });
  const edit = values => world.applyWrite({ author: 'writer', id: `edit-${++id}`, epoch: world.epoch, x: 10, y: 3, text: '', ...values });
  return { world, write, edit };
}

test('native candidate replacement commits its cleared footprint and text in one version without moving a suffix', t => {
  const { world, write, edit } = fixture(t);
  write('nihon!', 10);
  const suffix = { ...world.getCell(15, 3) }, before = world.seq;
  const result = edit({ text: '日本', clear: Array.from({ length: 5 }, (_, index) => ({ x: 10 + index, y: 3 })) });
  assert.equal(result.seq, before + 1);
  assert.deepEqual(result.cursor, { x: 14, y: 3 });
  assert.equal(world.getCell(10, 3).text, '日'); assert.equal(world.getCell(12, 3).text, '本');
  assert.equal(world.getCell(11, 3).leadX, 10); assert.equal(world.getCell(13, 3).leadX, 12);
  assert.equal(world.getCell(14, 3).text, '');
  assert.deepEqual(world.getCell(15, 3), suffix, 'unchanged suffix must keep its address and version');
  assert.equal(result.cells.length, 5); assert.ok(result.cells.every(cell => cell.version === result.seq));
  const history = world.db.prepare('SELECT seq,x,y,text FROM history WHERE seq=? ORDER BY x').all(result.seq);
  assert.equal(history.length, 5); assert.equal(new Set(history.map(cell => `${cell.x},${cell.y}`)).size, 5);
});

test('a clear address on either wide half and an overlapping replacement remove whole displaced glyphs atomically', t => {
  const { world, write, edit } = fixture(t);
  write('P한글S', 8);
  const prefix = { ...world.getCell(8, 3) }, suffix = { ...world.getCell(13, 3) };
  const result = edit({ x: 10, text: 'AB', clear: [{ x: 10, y: 3 }, { x: 9, y: 3 }, { x: 10, y: 3 }] });
  assert.deepEqual(result.cells.map(cell => [cell.x, cell.text]).sort((a, b) => a[0] - b[0]), [[9, ''], [10, 'A'], [11, 'B'], [12, '']]);
  assert.ok(result.cells.every(cell => cell.version === result.seq && cell.width === 1));
  assert.deepEqual(world.getCell(8, 3), prefix); assert.deepEqual(world.getCell(13, 3), suffix);
});

test('native replacement at a toroidal seam clears the old wrapped tail without shifting its neighbour', t => {
  const { world, write, edit } = fixture(t, { width: 32, height: 16 });
  write('한S', 31);
  const suffix = { ...world.getCell(1, 3) };
  const result = edit({ x: 31, text: 'Q', clear: [{ x: 0, y: 3 }] });
  assert.equal(world.getCell(31, 3).text, 'Q'); assert.equal(world.getCell(0, 3).text, '');
  assert.deepEqual(world.getCell(1, 3), suffix); assert.deepEqual(result.cursor, { x: 0, y: 3 });
  assert.ok(result.cells.every(cell => cell.version === result.seq));
});

test('native deletion can clear a full range with empty replacement text, and retries never erase a later write', t => {
  const { world, write } = fixture(t);
  write('한AB', 10);
  const operation = { author: 'writer', id: 'native-delete', epoch: 1, x: 10, y: 3, text: '', clear: [{ x: 11, y: 3 }, { x: 12, y: 3 }] };
  const result = world.applyWrite(operation);
  assert.equal(result.cells.length, 3); assert.ok(result.cells.every(cell => cell.text === ''));
  assert.deepEqual(result.cursor, { x: 10, y: 3 }); assert.equal(world.getCell(13, 3).text, 'B');
  write('新', 10); const snapshot = world.snapshot();
  const retried = world.applyWrite(operation);
  assert.equal(retried.duplicate, true); assert.equal(retried.seq, result.seq);
  assert.deepEqual(world.snapshot(), snapshot);
});

test('every malformed native clear footprint is rejected before changing cells, history, operations or order', t => {
  const { world, write, edit } = fixture(t);
  write('한글', 10);
  const snapshot = world.snapshot();
  const count = table => world.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const historyCount = count('history'), operationCount = count('operations');
  const invalid = [null, {}, '10,3', 1, false, [null], [[]], [1], [false],
    [{ x: 10, y: 3 }, { x: -1, y: 3 }], [{ x: 64, y: 3 }], [{ x: 10, y: 32 }],
    [{ x: 10.5, y: 3 }], [{ x: '10', y: 3 }], [{ x: 10 }],
    [{ x: 10, y: Number.MAX_SAFE_INTEGER + 1 }], Array.from({ length: 2049 }, () => ({ x: 10, y: 3 }))];
  for (const clear of invalid) {
    assert.throws(() => edit({ text: 'X', clear }), error => ['BAD_CLEAR', 'BAD_POSITION'].includes(error.code));
    assert.deepEqual(world.snapshot(), snapshot); assert.equal(count('history'), historyCount); assert.equal(count('operations'), operationCount);
  }
  for (const change of [{ text: '\u0000' }, { text: 'x'.repeat(513) }, { lineStartX: null, text: 'X' }, { epoch: 0, text: 'X' }]) {
    assert.throws(() => edit({ clear: [{ x: 10, y: 3 }], ...change }));
    assert.deepEqual(world.snapshot(), snapshot); assert.equal(count('history'), historyCount); assert.equal(count('operations'), operationCount);
  }
});

test('two independent observers receive one atomic native replacement and its final cursor', async t => {
  const app = createTextworld({ storagePath: ':memory:', now: () => 1000 }); t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1'), url = `ws://127.0.0.1:${address.port}/ws`;
  const writer = connect(url), a = connect(url), b = connect(url);
  await Promise.all([writer.next(m => m.type === 'snapshot'), a.next(m => m.type === 'snapshot'), b.next(m => m.type === 'snapshot')]);
  for (const client of [writer, a, b]) {
    client.send({ type: 'view', cols: 128, rows: 64 });
    await client.locate(10, 3);
  }
  writer.send({ type: 'write', id: 'seed', epoch: 1, x: 10, y: 3, text: 'nihao!' });
  await writer.next(m => m.type === 'ack' && m.id === 'seed');
  const suffix = { ...app.world.getCell(15, 3) };
  const operation = { type: 'write', id: 'replace', epoch: 1, x: 10, y: 3, text: '你好', clear: Array.from({ length: 5 }, (_, index) => ({ x: 10 + index, y: 3 })) };
  writer.send(operation);
  const [patchA, patchB, ack] = await Promise.all([
    a.next(m => hasCell(m, 10, 3, '你', 2)), b.next(m => hasCell(m, 10, 3, '你', 2)), writer.next(m => m.type === 'ack' && m.id === 'replace'),
  ]);
  assert.deepEqual(patchA.observation.cells, patchB.observation.cells);
  assert.deepEqual(patchA.observation.forget, patchB.observation.forget);
  assert.equal(ack.seq, 2);
  assert.ok(patchA.observation.cells.every(cell => cell.version === 2));
  assert.deepEqual(patchA.observation.forget, [{ x: 14, y: 3 }]);
  assert.deepEqual(ack.cursor, { x: 14, y: 3 });
  assert.deepEqual(app.world.getCell(15, 3), suffix);
  await b.next(m => hasPeer(m, writer.state.selfId, 14, 3));
  writer.send(operation); await writer.next(m => m.type === 'ack' && m.id === 'replace' && m.duplicate);
  await writer.sync();
  assert.equal(a.messages.filter(m => m.type === 'view' && hasCell(m, 10, 3, '你', 2)).length, 1);
  assert.equal(b.messages.filter(m => m.type === 'view' && hasCell(m, 10, 3, '你', 2)).length, 1);
});

test('large native footprints fit transport but exceed participant reach without mutating any cells', async t => {
  const app = createTextworld({ storagePath: ':memory:', now: () => 1000 }); t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1'), writer = connect(`ws://127.0.0.1:${address.port}/ws`);
  await writer.next(m => m.type === 'snapshot');
  const clear = Array.from({ length: 2048 }, (_, index) => ({ x: index % 128, y: Math.floor(index / 128) }));
  const operation = { type: 'write', layout: 2, id: 'large-native-range', epoch: 1, x: 5, y: 20, text: '한', clear };
  const bytes = Buffer.byteLength(JSON.stringify(operation));
  assert.ok(bytes > 16384 && bytes < 65536);
  writer.send(operation);
  const error = await writer.next(m => m.type === 'error' && m.id === operation.id);
  assert.equal(error.code, 'TOO_LARGE'); assert.equal(error.status, 413);
  assert.equal(app.world.seq, 0);
  assert.equal(app.world.db.prepare('SELECT count(*) AS n FROM history').get().n, 0);
  writer.socket.send('x'.repeat(65537));
  const [code] = await new Promise(resolve => writer.socket.once('close', (...args) => resolve(args)));
  assert.equal(code, 1009); assert.equal(app.world.seq, 0);
});

test('versioned WOFF2 font responses are immutable while the font stylesheet remains refreshable', async t => {
  const app = createTextworld({ storagePath: ':memory:' }); t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
  const font = await fetch(`${base}/fonts/sarasa-fixed-k-regular-1.0.43.woff2`, { method: 'HEAD' });
  assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await font.arrayBuffer()).byteLength, 0);
  const stylesheet = await fetch(`${base}/fonts/sarasa.css`);
  assert.equal(stylesheet.status, 200); assert.equal(stylesheet.headers.get('cache-control'), 'no-cache');
  assert.match(await stylesheet.text(), /Textworld Sarasa/);
});
