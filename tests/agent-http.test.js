import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { World } from '../server/world.js';
import { NetworkBudgets, ParticipantPolicy, LIMITS } from '../server/participant-policy.js';
import { Observer, contains, validateView, viewRectangle } from '../server/visibility.js';
import { createTurnRunner, TURN_LIMITS } from '../server/agent-turns.js';
import { createAgentHTTP, AGENT_HTTP_LIMITS } from '../server/agent-http.js';
import { VIEW_LIMITS } from '../shared/participant-rules.js';
import { WebSocket } from 'ws';
import { createTextworld } from '../server/index.js';
import { TextworldAgent, RateLimitError } from '../sdk/textworld-agent.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const world = new World({ width: 512, height: 256 });
  let clock = 0;
  const actors = new Map(), listeners = new Set(), networks = new NetworkBudgets({ now: () => clock });
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const peers = () => [...actors.values()].map(actor => actor.peer);
  const runner = createTurnRunner({ world, publish: notify, presence: notify });
  const api = createAgentHTTP({ world, peers, runner, now: () => clock,
    limits: { ...LIMITS, view: VIEW_LIMITS, turn: TURN_LIMITS },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    createActor(req, input) {
      const view = validateView(input.view), network = networks.acquire('loopback');
      const peer = { id: randomUUID(), name: input.name || '여행자', color: '#fff', x: 256, y: 128 };
      const actor = { peer, network, closed: false };
      actor.policy = new ParticipantPolicy({ world, peer, network, now: () => clock,
        isVisible: (x, y) => contains(viewRectangle(world, peer, view), x, y, world) });
      actor.observer = new Observer({ world, peer, view, charge: cost => actor.policy.acceptObservation(cost) });
      if (input.position) actor.policy.acceptMove({ ...input.position, epoch: world.epoch });
      actors.set(peer.id, actor); notify(); return actor;
    },
    removeActor(actor) {
      actor.closed = true; runner.cancel(actor); actors.delete(actor.peer.id); networks.release(actor.network); notify();
    },
  });
  const server = http.createServer(async (req, res) => {
    if (!await api.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/agents/v1`;
  const request = async (path, { method = 'POST', value, session, signal, raw } = {}) => {
    const headers = session ? { Authorization: `Bearer ${session.token}` } : {};
    if (value !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, signal,
      body: raw ?? (value === undefined ? undefined : JSON.stringify(value)) });
    return { status: response.status, headers: response.headers,
      body: response.status === 204 ? null : await response.json() };
  };
  const create = async options => {
    const result = await request('/sessions', { value: { view: { cols: 9, rows: 7 }, ...options } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const turn = (session, value) => request(`/sessions/${session.id}/turn`, { session, value });
  t.after(async () => {
    api.close(); await runner.shutdown(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); world.close();
  });
  return { world, actors, api, create, turn, request, notify, listeners, setClock: value => { clock = value; } };
}

test('public discovery and anonymous session expose only the current bounded view', async t => {
  const f = await fixture(t);
  f.world.applyWrite({ author: 'seed', id: 'hidden', epoch: 1, x: 10, y: 10, text: 'secret' });
  const discovery = await f.request('', { method: 'GET' });
  assert.equal(discovery.status, 200); assert.equal(discovery.body.access, 'public-anonymous');
  const created = await f.create({ name: '봇' });
  assert.notEqual(created.session.id, created.session.token);
  assert.equal(created.session.expiresInMs, 120000);
  assert.equal(created.observation.cells.length, 0);
  assert.deepEqual(Object.keys(created.world).sort(), ['epoch', 'height', 'textLayout', 'width']);
  const invalid = await f.request(`/sessions/${created.session.id}/turn`, { value: { actions: [] } });
  const missing = await f.request('/sessions/missing/turn', { value: { actions: [] } });
  assert.equal(invalid.status, 401); assert.deepEqual(invalid.body, missing.body);
});

test('two HTTP participants share paced CJK input and visible cursor updates', async t => {
  const f = await fixture(t), a = await f.create(), b = await f.create();
  const result = await f.turn(a.session, { id: 'hello', actions: [{ type: 'type', text: '한A' }], since: a.observation.revision });
  assert.equal(result.status, 200); assert.equal(result.body.turn.completedSteps, 2);
  const observed = await f.turn(b.session, { actions: [], since: b.observation.revision });
  assert.equal(observed.status, 200);
  assert.deepEqual(observed.body.observation.cells.map(cell => [cell.x, cell.text, cell.width]),
    [[256, '한', 2], [257, '', 0], [258, 'A', 1]]);
  assert.equal(observed.body.observation.peers.find(peer => peer.id === a.session.id).x, 259);
  assert.equal(observed.body.observation.cells.some(cell => 'author' in cell || 'group' in cell), false);
});

test('20,000 characters and oversized views are rejected before any effect', async t => {
  const f = await fixture(t), a = await f.create();
  const large = await f.turn(a.session, { id: 'large', actions: [{ type: 'type', text: 'A'.repeat(20000) }] });
  assert.equal(large.status, 413); assert.equal(f.world.seq, 0);
  const badView = await f.request('/sessions', { value: { view: { cols: 10000, rows: 10000 } } });
  assert.equal(badView.status, 400); assert.equal(f.actors.size, 1);
  const body = await f.request('/sessions', { raw: JSON.stringify({ name: 'x'.repeat(AGENT_HTTP_LIMITS.bodyBytes) }) });
  assert.equal(body.status, 413);
});

test('abnormal request frequency returns actual HTTP 429 and Retry-After; cancel stays available', async t => {
  const f = await fixture(t), a = await f.create();
  let result;
  for (let i = 0; i <= LIMITS.request.burst; i++) result = await f.turn(a.session, { actions: [], since: a.observation.revision });
  assert.equal(result.status, 429); assert.equal(result.body.error.code, 'RATE_LIMITED');
  assert.ok(result.body.error.retryAfterMs > 0); assert.equal(result.headers.get('retry-after'), '1');
  const cancel = await f.request(`/sessions/${a.session.id}/cancel`, { session: a.session });
  assert.equal(cancel.status, 200);
  const deleted = await f.request(`/sessions/${a.session.id}`, { method: 'DELETE', session: a.session });
  assert.equal(deleted.status, 204); assert.equal(f.actors.size, 0);
});

test('recreating anonymous sessions does not replenish the shared network creation budget', async t => {
  const f = await fixture(t);
  for (let i = 0; i < LIMITS.network.create.burst; i++) {
    const a = await f.create();
    await f.request(`/sessions/${a.session.id}`, { method: 'DELETE', session: a.session });
  }
  const result = await f.request('/sessions', { value: {} });
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '1');
});

test('completed request retries do not replay writes and return current observations', async t => {
  const f = await fixture(t), a = await f.create(), b = await f.create();
  const request = { id: 'once', actions: [{ type: 'type', text: 'A' }] };
  const first = await f.turn(a.session, request);
  assert.equal(first.status, 200);
  await f.turn(b.session, { id: 'other', actions: [{ type: 'type', text: 'B' }] });
  const seq = f.world.seq;
  const retry = await f.turn(a.session, request);
  assert.equal(retry.status, 200); assert.equal(f.world.seq, seq);
  assert.equal(retry.body.observation.cells.find(cell => cell.x === 256 && cell.y === 128).text, 'B');
  const conflict = await f.turn(a.session, { ...request, actions: [{ type: 'type', text: 'C' }] });
  assert.equal(conflict.status, 409); assert.equal(f.world.seq, seq);
});

test('active retries and cached-id probes cannot observe intermediate views; cancellation stops remaining actions', async t => {
  const f = await fixture(t), a = await f.create();
  const previous = { id: 'previous', actions: [{ type: 'wait', ms: 0 }] };
  await f.turn(a.session, previous);
  const command = { id: 'slow', actions: [{ type: 'move', dx: 160, dy: 0 }] };
  const pending = f.turn(a.session, command);
  await pause(65);
  const duplicate = await f.turn(a.session, command);
  assert.equal(duplicate.status, 202); assert.equal(duplicate.body.turn.status, 'running');
  assert.equal('observation' in duplicate.body, false);
  const cached = await f.turn(a.session, previous);
  assert.equal(cached.status, 429); assert.equal('observation' in cached.body, false);
  const read = await f.turn(a.session, { actions: [] });
  assert.equal(read.status, 429);
  const cancel = await f.request(`/sessions/${a.session.id}/cancel`, { session: a.session });
  assert.deepEqual(cancel.body, { cancelled: true });
  const stopped = await pending;
  assert.equal(stopped.body.turn.status, 'cancelled');
  const x = stopped.body.cursor.x;
  await pause(100); assert.equal(f.actors.get(a.session.id).peer.x, x);
});

test('long polling wakes on visible changes and does not expose hidden-world activity', async t => {
  const f = await fixture(t), a = await f.create();
  let settled = false;
  const pending = f.turn(a.session, { actions: [], since: a.observation.revision, waitMs: 1000 }).then(value => { settled = true; return value; });
  await pause(20);
  f.world.applyWrite({ author: 'seed', id: 'hidden', epoch: 1, x: 10, y: 10, text: 'hidden' }); f.notify();
  await pause(40); assert.equal(settled, false);
  f.world.applyWrite({ author: 'seed', id: 'visible', epoch: 1, x: 256, y: 128, text: 'Z' }); f.notify();
  const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.body.observation.reset, false);
  assert.deepEqual(result.body.observation.cells.map(cell => cell.text), ['Z']);
  assert.equal(f.listeners.size, 0);
});

test('long polling is single-flight, cancellable, and does not expire while waiting', async t => {
  const f = await fixture(t), a = await f.create();
  const pending = f.turn(a.session, { actions: [], since: a.observation.revision, waitMs: 1000 });
  await pause(20);
  f.setClock(120001); f.api.prune(); assert.equal(f.actors.size, 1);
  const competing = await f.turn(a.session, { actions: [] });
  assert.equal(competing.status, 429);
  const cancel = await f.request(`/sessions/${a.session.id}/cancel`, { session: a.session });
  assert.equal(cancel.body.cancelled, true); assert.equal((await pending).status, 200);
  f.setClock(240002); f.api.prune(); assert.equal(f.actors.size, 0);
  const expired = await f.turn(a.session, { actions: [] });
  assert.equal(expired.status, 401);
});

test('a read-budget failure after successful actions retains their summary and never replays them', async t => {
  const f = await fixture(t), a = await f.create();
  const actor = f.actors.get(a.session.id);
  actor.policy.read.tokens = 0;
  const request = { id: 'move', actions: [{ type: 'move', dx: 16, dy: 0 }] };
  const blocked = await f.turn(a.session, request);
  assert.equal(blocked.status, 429); assert.equal(blocked.body.turn.status, 'completed');
  assert.equal(blocked.body.cursor.x, 272); assert.equal('observation' in blocked.body, false);
  actor.policy.read.tokens = actor.policy.read.capacity;
  const retry = await f.turn(a.session, request);
  assert.equal(retry.status, 200); assert.equal(retry.body.cursor.x, 272);
});

test('real server, two SDK agents, and a browser WebSocket share input and enforce HTTP 429', async t => {
  const app = createTextworld({ storagePath: ':memory:', policyNow: () => 0, trustProxy: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`, messages = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  const a = await TextworldAgent.connect(base, { name: 'SDK A', view: { cols: 9, rows: 7 } });
  const b = await TextworldAgent.connect(base, { name: 'SDK B', view: { cols: 9, rows: 7 } });
  t.after(async () => { await a.close(); await b.close(); socket.terminate(); await app.close(); });
  const position = { ...a.cursor };
  await a.turn([{ type: 'type', text: '한' }], { id: 'sdk-a' });
  await b.observe();
  assert.equal([...b.cells.values()].find(cell => cell.x === position.x && cell.y === position.y)?.text, '한');
  await b.turn([{ type: 'type', text: 'B' }], { id: 'sdk-b' });
  await a.observe();
  assert.equal([...a.cells.values()].find(cell => cell.x === position.x && cell.y === position.y)?.text, 'B');
  assert.ok(messages.some(message => message.type === 'view' && message.observation.cells.some(cell => cell.text === '한')));
  assert.ok(messages.some(message => message.type === 'view' && message.observation.cells.some(cell => cell.text === 'B')));
  let limited;
  for (let i = 0; i < LIMITS.request.burst && !limited; i++) {
    try { await a.observe(); } catch (error) { limited = error; }
  }
  assert.ok(limited instanceof RateLimitError); assert.equal(limited.status, 429);
  assert.ok(limited.retryAfterMs > 0);
  assert.equal((await fetch(`${base}/api/scavenger/evidence`)).status, 404);
});
