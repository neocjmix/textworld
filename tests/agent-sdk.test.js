import test from 'node:test';
import assert from 'node:assert/strict';
import { TextworldAgent, RateLimitError, TextworldError } from '../sdk/textworld-agent.mjs';
import { createTextworld } from '../server/index.js';

const initial = () => ({
  session: { id: 'public-id', token: 'private-token', expiresInMs: 120000 },
  limits: { example: true }, world: { width: 128, height: 64, epoch: 1 }, cursor: { x: 64, y: 32 },
  observation: { revision: 1, reset: true, view: { x: 24, y: 20, cols: 80, rows: 24 },
    cells: [{ x: 64, y: 32, text: 'A', width: 1 }], peers: [{ id: 'public-id', name: '봇' }] },
});
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
function service(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), ...options, body: options.body === undefined ? undefined : JSON.parse(options.body) });
    assert.ok(responses.length, 'No unexpected automatic requests');
    return responses.shift();
  };
  return { calls, fetch };
}

test('SDK creates an anonymous session and keeps the bearer token out of public state', async () => {
  const mock = service([json(initial(), 201), json({ cancelled: false })]);
  const agent = await TextworldAgent.connect('https://example.test/', { name: '봇', fetch: mock.fetch });
  assert.equal(mock.calls[0].url, 'https://example.test/api/agents/v1/sessions');
  assert.deepEqual(mock.calls[0].body, { name: '봇' });
  assert.equal(mock.calls[0].headers.Authorization, undefined);
  assert.equal(agent.id, 'public-id');
  assert.equal(agent.cells.get('64,32').text, 'A');
  assert.ok(!JSON.stringify(agent).includes('private-token'));
  await agent.cancel();
  assert.equal(mock.calls[1].headers.Authorization, 'Bearer private-token');
  assert.ok(!mock.calls[1].url.includes('private-token'));
});

test('SDK applies deltas, scope forgets, and reset snapshots to one bounded cache', async () => {
  const mock = service([json(initial(), 201), json({ observation: {
    revision: 2, reset: false, view: { x: 25, y: 20, cols: 80, rows: 24 },
    cells: [{ x: 65, y: 32, text: 'B', width: 1 }], forget: [{ x: 64, y: 32 }], peers: [],
  } }), json({ observation: {
    revision: 5, reset: true, view: { x: 40, y: 20, cols: 80, rows: 24 }, cells: [], peers: [],
  } })]);
  const agent = await TextworldAgent.connect('http://localhost:3000', { fetch: mock.fetch });
  await agent.observe({ waitMs: 25000 });
  assert.deepEqual(mock.calls[1].body, { actions: [], since: 1, waitMs: 25000 });
  assert.equal(agent.cells.size, 1);
  assert.equal(agent.cells.get('65,32').text, 'B');
  assert.equal(agent.revision, 2);
  await agent.observe();
  assert.equal(mock.calls[2].body.since, 2);
  assert.equal(agent.cells.size, 0);
  assert.equal(agent.revision, 5);
});

test('SDK exposes partial 429 progress and current view without replaying writes', async () => {
  const turn = { id: 'stable-id', status: 'blocked', completedSteps: 2, completedActions: 0 };
  const mock = service([json(initial(), 201), json({
    error: { code: 'RATE_LIMITED', message: 'Too fast', retryAfterMs: 250 }, turn,
    cursor: { x: 66, y: 32 }, observation: {
      revision: 2, reset: false, view: initial().observation.view,
      cells: [{ x: 65, y: 32, text: 'B', width: 1 }], forget: [], peers: [],
    },
  }, 429, { 'Retry-After': '1' })]);
  const agent = await TextworldAgent.connect('http://localhost:3000', { fetch: mock.fetch });
  await assert.rejects(agent.turn([{ type: 'type', text: 'BCD' }], { id: 'stable-id' }), error => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryAfterMs, 250);
    assert.equal(error.requestId, 'stable-id');
    assert.deepEqual(error.turn, turn);
    return true;
  });
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(agent.cursor, { x: 66, y: 32 });
  assert.equal(agent.cells.get('65,32').text, 'B');
  assert.deepEqual(agent.lastTurn, turn);
});

test('SDK honors Retry-After on session creation failures', async () => {
  const mock = service([json({ error: { code: 'TOO_MANY_SESSIONS', message: 'Wait' } }, 429, { 'Retry-After': '2' })]);
  await assert.rejects(TextworldAgent.connect('http://localhost:3000', { fetch: mock.fetch }), error => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.retryAfterMs, 2000);
    return true;
  });
  assert.equal(mock.calls.length, 1);
});

test('SDK leaves running turns explicit and lets callers reuse the same action id', async () => {
  const mock = service([json(initial(), 201), json({ turn: { id: 'stable', status: 'running' } }, 202),
    json({ turn: { id: 'stable', status: 'completed' } })]);
  const agent = await TextworldAgent.connect('http://localhost:3000', { fetch: mock.fetch });
  const actions = [{ type: 'type', text: '한글' }];
  assert.equal((await agent.turn(actions, { id: 'stable' })).turn.status, 'running');
  assert.equal((await agent.turn(actions, { id: 'stable' })).turn.status, 'completed');
  assert.equal(mock.calls[1].body.id, mock.calls[2].body.id);
  assert.deepEqual(mock.calls[1].body.actions, mock.calls[2].body.actions);
});

test('SDK close is locally idempotent and rejects subsequent requests', async () => {
  const mock = service([json(initial(), 201), new Response(null, { status: 204 })]);
  const agent = await TextworldAgent.connect('http://localhost:3000', { fetch: mock.fetch });
  await agent.close();
  await agent.close();
  assert.equal(mock.calls[1].method, 'DELETE');
  assert.equal(mock.calls.length, 2);
  await assert.rejects(agent.observe(), error => error instanceof TextworldError && error.code === 'SESSION_CLOSED');
});

test('SDK reports malformed upstream responses without a retry', async () => {
  const mock = service([new Response('<html>upstream failed</html>', { status: 502 })]);
  await assert.rejects(TextworldAgent.connect('http://localhost:3000', { fetch: mock.fetch }), error => {
    assert.equal(error.code, 'BAD_RESPONSE');
    assert.equal(error.status, 502);
    return true;
  });
});

test('SDK exposes the generated turn id after a lost network response', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    if (!calls.length) { calls.push(options); return json(initial(), 201); }
    calls.push(options);
    throw new TypeError('connection lost');
  };
  const agent = await TextworldAgent.connect('http://localhost:3000', { fetch });
  await assert.rejects(agent.turn([{ type: 'type', text: 'A' }]), error => {
    assert.equal(error.requestId, JSON.parse(calls[1].body).id);
    assert.ok(error.requestId);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('two real SDK sessions observe paced Korean text and remove closed presence', async t => {
  const app = createTextworld({ storagePath: ':memory:', trustProxy: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}`;
  let a, b;
  t.after(async () => {
    if (a) await a.close().catch(() => {});
    if (b) await b.close().catch(() => {});
    await app.close();
  });
  a = await TextworldAgent.connect(url, { name: '관찰 봇' });
  b = await TextworldAgent.connect(url, { name: '작성 봇' });
  await a.observe();
  assert.ok(a.peers.some(peer => peer.id === b.id));
  const origin = { ...b.cursor };
  const waiting = a.observe({ waitMs: 1000 });
  const written = b.turn([{ type: 'type', text: '공유' }], { id: 'real-korean' });
  await waiting;
  assert.equal((await written).turn.status, 'completed');
  await a.observe();
  assert.equal(a.cells.get(`${origin.x},${origin.y}`).text, '공');
  assert.equal(a.cells.get(`${origin.x + 2},${origin.y}`).text, '유');
  assert.equal(a.cells.get(`${origin.x + 1},${origin.y}`).width, 0);
  await b.close();
  await a.observe();
  assert.equal(a.peers.some(peer => peer.id === b.id), false);
});

test('real SDK cancellation interrupts a waiting turn without replay or rollback', async t => {
  const app = createTextworld({ storagePath: ':memory:', trustProxy: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const agent = await TextworldAgent.connect(`http://127.0.0.1:${port}`);
  t.after(async () => { await agent.close().catch(() => {}); await app.close(); });
  const origin = { ...agent.cursor };
  const running = agent.turn([
    { type: 'type', text: 'A' }, { type: 'wait', ms: 10000 }, { type: 'type', text: 'B' },
  ], { id: 'cancel-example' });
  // Wait for the actual first effect, so cancellation is exercised mid-turn.
  for (let attempt = 0; attempt < 100 && !app.world.getCell(origin.x, origin.y); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(app.world.getCell(origin.x, origin.y)?.text, 'A');
  assert.equal((await agent.cancel()).cancelled, true);
  const result = await running;
  assert.equal(result.turn.status, 'cancelled');
  assert.equal(app.world.getCell(origin.x, origin.y)?.text, 'A');
  assert.equal(app.world.getCell(origin.x + 1, origin.y), undefined);
});
