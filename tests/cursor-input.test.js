import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextworld } from '../server/index.js';
import { connect } from './ws-client.js';
import { CursorInput } from '../shared/cursor-input.js';

async function fixture(t) {
  let time = 0;
  const app = createTextworld({ storagePath: ':memory:', now: () => 1000000, policyNow: () => time });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1');
  const client = connect(`ws://127.0.0.1:${port}/ws`);
  await client.next(m => m.type === 'snapshot');
  let sequence = 0;
  const input = async (action, { epoch = app.world.epoch, expectError = false } = {}) => {
    const message = { type: 'input', id: `i${++sequence}`, sequence, epoch, action };
    client.send(message);
    const reply = await client.next(m => m.id === message.id && m.type === (expectError ? 'error' : 'ack'));
    return { message, reply };
  };
  await input({ kind: 'goto', x: 7, y: 8 });
  return { app, client, input, advance: ms => { time += ms; } };
}
const native = (start, end, text, context = 1) => ({ kind: 'native', context, edit: { start, end, text } });

test('late cursor intentions execute once after multiple resizes, without old coordinate authority', async t => {
  const { app, client, input } = await fixture(t);
  const epoch = app.world.epoch;
  app.world.resize(160, 64, undefined, { seed: 1 });
  app.world.resize(128, 64, undefined, { seed: 2 });
  await client.next(m => m.type === 'snapshot' && m.world.epoch === app.world.epoch);
  const snapshot = await client.sync(), cursor = snapshot.input.state.cursor;
  const { message } = await input(native(0, 0, '한'), { epoch });
  assert.equal(app.world.getCell(cursor.x, cursor.y).text, '한');
  const seq = app.world.seq;
  const after = client.messages.length; client.send(message);
  assert.equal((await client.next(m => m.type === 'ack', after)).duplicate, true);
  assert.equal(app.world.seq, seq);
  assert.equal(client.messages.some(m => m.code === 'STALE_EPOCH'), false);
  app.measurements.flush();
  const metrics = new Map(app.measurements.read({ period: 60 }).map(row => [row.metric, row.value]));
  assert.equal(metrics.get('input.after_resize').count, 1);
  assert.equal(metrics.get('input.cursor_actions').count, 2);
  assert.ok(metrics.get('input.snapshot_bytes').min > 0);
  assert.ok(metrics.get('input.plan_ms').count >= 2);
});

test('native reconversion replaces the surviving mapped glyph, not an old address', async t => {
  const { app, client, input } = await fixture(t);
  await input(native(0, 0, 'ㅎ글'));
  app.world.resize(160, 64, undefined, { seed: 42 });
  const head = [...app.world.cells.values()].find(c => c.text === 'ㅎ');
  await input(native(0, 1, '한'));
  assert.equal(app.world.getCell(head.x, head.y).text, '한');
  assert.equal([...app.world.cells.values()].filter(c => c.text === 'ㅎ').length, 0);
  assert.equal([...app.world.cells.values()].filter(c => c.text === '글').length, 1);
  assert.equal((await client.sync()).input.state.native.text, '한글');
});

test('repaired CJK tails do not retain phantom replacement addresses after a two-axis remesh', async t => {
  const { app, input } = await fixture(t);
  await input(native(0, 0, 'ㅎ'));
  app.world.resize(64, 32, undefined, { seed: 42 });
  const head = [...app.world.cells.values()].find(c => c.text === 'ㅎ');
  await input(native(0, 1, '하'));
  assert.equal(app.world.getCell(head.x, head.y).text, '하');
  assert.equal([...app.world.cells.values()].filter(c => c.text || c.width === 0).length, 2);
});

test('shrinking away a native glyph retains its range and corrects its insertion position', async t => {
  const { app, client, input } = await fixture(t);
  await input(native(0, 0, 'ㅎ'));
  const values = Array(64).fill(7); values[0] = 8;
  app.world.resize(126, 64, undefined, { seed: 42, seams: { axis: 'width', values } });
  assert.equal([...app.world.cells.values()].filter(c => c.text === 'ㅎ').length, 0);
  const snapshot = await client.sync(), at = snapshot.input.state.native.entries[0].from;
  await input(native(0, 1, '한'));
  assert.equal(app.world.getCell(at.x, at.y).text, '한');
  assert.equal([...app.world.cells.values()].filter(c => c.text === '한').length, 1);
});

test('movement queued in an older topology remains relative to the corrected cursor', async t => {
  const { app, client, input } = await fixture(t);
  const epoch = app.world.epoch;
  app.world.resize(160, 64, undefined, { seed: 42 });
  const at = (await client.sync()).input.state.cursor;
  await input({ kind: 'move', dx: 3, dy: -2 }, { epoch });
  assert.deepEqual((await client.sync()).input.state.cursor, { x: at.x + 3, y: at.y - 2 });
});

test('resize does not replenish write budgets and refused inputs never advance native context', async t => {
  const { app, client, input } = await fixture(t);
  await input(native(0, 0, 'A'.repeat(64)));
  app.world.resize(160, 64, undefined, { seed: 42 });
  const before = (await client.sync()).input.state;
  const { reply, message } = await input(native(64, 64, 'B'), { expectError: true });
  assert.equal(reply.status, 429); assert.equal(reply.code, 'RATE_LIMITED');
  assert.equal(reply.input, undefined, '429 must not amplify a tiny request into a full context response');
  assert.deepEqual((await client.sync()).input.state, before);
  client.send(message);
  await client.next(m => m.id === message.id && m.duplicate);
  assert.equal([...app.world.cells.values()].some(c => c.text === 'B'), false);
});

test('invalid native ranges and giant edits cannot become arbitrary spatial operations', async t => {
  const { app, input } = await fixture(t);
  for (const action of [native(10, 11, 'X'), native(0, 0, 'X'.repeat(20000)), { kind: 'native', context: 1, edit: { start: 0, end: 0, text: 'X'.repeat(65) } }]) {
    const { reply } = await input(action, { expectError: true });
    assert.ok(['BAD_INPUT', 'TOO_LARGE'].includes(reply.code));
    assert.equal(app.world.seq, 0);
  }
});

test('request-level 429 consumes the refused ordinal and later input can continue', async t => {
  const { app, input, advance } = await fixture(t);
  for (let i = 0; i < 159; i++) await input({ kind: 'home' });
  const { reply } = await input(native(0, 0, 'X'), { expectError: true });
  assert.equal(reply.status, 429);
  advance(1000);
  await input(native(0, 0, '한'));
  assert.equal(app.world.getCell(7, 8).text, '한');
});

test('native line-break-only edits remain bounded movement without inventing cells', async t => {
  const { app, client, input } = await fixture(t);
  await input(native(0, 0, '\n\n'));
  assert.deepEqual((await client.sync()).input.state.cursor, { x: 7, y: 10 });
  assert.equal(app.world.seq, 0);
  const { reply } = await input({ kind: 'type', text: '\n'.repeat(65) }, { expectError: true });
  assert.equal(reply.code, 'BAD_INPUT');
  assert.equal(app.world.seq, 0);
});

test('server native memory has a fixed entry bound, independent of world size', () => {
  const input = new CursorInput({ x: 0, y: 0 }), world = { width: 1024, height: 512 };
  for (let i = 0; i < 32; i++) {
    const offset = input.native.text.length;
    input.restore(input.plan(native(offset, offset, 'A'.repeat(64)), world).next.snapshot());
    assert.ok(input.native.entries.length <= 256);
    assert.ok(input.writing.trail.length <= 512);
  }
  assert.deepEqual(input.cursor, { x: 0, y: 0 });
});

test('bounded context retains provisional Korean range through compaction and resize', async t => {
  const { app, client, input, advance } = await fixture(t);
  for (let i = 0; i < 4; i++) { advance(6000); await input(native(i * 64, i * 64, 'A'.repeat(64))); }
  advance(1000); await input(native(256, 256, 'ㅎ'));
  const context = (await client.sync()).input.state.native;
  assert.equal(context.text, 'A'.repeat(127) + 'ㅎ');
  app.world.resize(160, 64, undefined, { seed: 42 });
  const head = [...app.world.cells.values()].find(c => c.text === 'ㅎ');
  await input(native(127, 128, '한'));
  assert.equal(app.world.getCell(head.x, head.y).text, '한');
  assert.equal([...app.world.cells.values()].some(c => c.text === 'ㅎ'), false);
});

test('failed input storage rolls back native context, cursor and budgets', async t => {
  const { app, client, input } = await fixture(t);
  const before = (await client.sync()).input.state;
  app.world.db.exec("CREATE TRIGGER fail_cells BEFORE INSERT ON cells BEGIN SELECT RAISE(ABORT, 'test'); END");
  const { reply } = await input(native(0, 0, '한'), { expectError: true });
  assert.deepEqual((await client.sync()).input.state, before); assert.equal(app.world.seq, 0);
  app.world.db.exec('DROP TRIGGER fail_cells');
  await input(native(0, 0, 'A'.repeat(64)));
  assert.equal(app.world.seq, 1, 'failed attempt refunded its write budget');
});

test('replaying unacknowledged intentions changes only a local prediction', () => {
  const local = new CursorInput({ x: 5, y: 5 });
  const world = { width: 32, height: 16 };
  const before = local.snapshot();
  const plan = local.plan(native(0, 0, '한'), world);
  assert.deepEqual(local.snapshot(), before, 'planning cannot mutate authoritative context');
  local.restore(plan.next.snapshot());
  assert.deepEqual(local.cursor, { x: 7, y: 5 });
  const corrected = new CursorInput({ x: 11, y: 5 });
  corrected.restore(corrected.plan(native(0, 0, '한'), world).next.snapshot());
  assert.deepEqual(corrected.cursor, { x: 13, y: 5 });
});
