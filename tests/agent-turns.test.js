import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { ParticipantPolicy, PolicyError } from '../server/participant-policy.js';
import { createTurnRunner, TURN_LIMITS } from '../server/agent-turns.js';

function fixture(t, { delay: customDelay, width = 1024, height = 512, x = 100, y = 100 } = {}) {
  let time = 0;
  const world = new World({ width, height, now: () => 1000 });
  const peer = { id: 'agent', x, y };
  const now = () => time;
  const policy = new ParticipantPolicy({ world, peer, now });
  const actor = { peer, policy }, effects = [], presences = [];
  const delay = customDelay || (async ms => { time += ms; });
  const runner = createTurnRunner({ world, now, delay,
    publish: result => effects.push({ time, result }), presence: () => presences.push({ time, x: peer.x, y: peer.y }) });
  t.after(() => { runner.shutdown(); world.close(); });
  return { world, actor, runner, effects, presences, now, advance: ms => { time += ms; } };
}
const request = (id, actions) => ({ id, actions });
const type = text => ({ type: 'type', text });
const tick = () => new Promise(resolve => setImmediate(resolve));
const errorIs = (status, code) => error => error instanceof PolicyError && error.status === status && error.code === code;

// These tests use an advancing fake monotonic clock, independent of SQLite's
// fixed wall clock, to inspect the schedule rather than waiting 25 seconds.
test('a batched string publishes one grapheme every 100ms, including CJK width', async t => {
  const f = fixture(t);
  const result = await f.runner.run(f.actor, request('hello', [type('A한e\u0301👩‍💻')]));
  assert.equal(result.status, 'completed');
  assert.equal(result.completedActions, 1);
  assert.equal(result.completedSteps, 4);
  assert.deepEqual(f.effects.map(effect => effect.time), [0, 100, 200, 300]);
  assert.deepEqual(result.cursor, { x: 106, y: 100 });
  assert.equal(f.world.getCell(103, 100).text, 'é');
  assert.equal(f.world.getCell(104, 100).text, '👩‍💻');
});

test('separate one-character requests retain the typing schedule', async t => {
  const f = fixture(t);
  await f.runner.run(f.actor, request('one', [type('A')]));
  await f.runner.run(f.actor, request('two', [type('B')]));
  await f.runner.run(f.actor, request('three', [type('C')]));
  assert.deepEqual(f.effects.map(effect => effect.time), [0, 100, 200]);
});

test('all invalid actions and oversized payloads fail before the first effect', async t => {
  const f = fixture(t);
  const invalid = [
    [type('okay'), { type: 'teleport', x: 50 }],
    [type('okay'), { type: 'move', dx: 1.5, dy: 0 }],
    [type('okay'), { type: 'type', text: '\u0000' }],
    [type('A'.repeat(20_000))], [type('\t'.repeat(65))],
    [type('A'.repeat(256)), { type: 'wait', ms: 5000 }],
    [{ type: 'move', dx: 5000, dy: 0 }],
    Array.from({ length: 17 }, () => ({ type: 'enter' })),
  ];
  for (let index = 0; index < invalid.length; index++) {
    await assert.rejects(f.runner.run(f.actor, request(`bad-${index}`, invalid[index])), error => [400, 413].includes(error.status));
    assert.equal(f.world.seq, 0); assert.deepEqual(f.actor.peer, { id: 'agent', x: 100, y: 100 });
  }
});

test('normalized pasted tabs and newlines obey the same typing clock and origin', async t => {
  const f = fixture(t);
  const result = await f.runner.run(f.actor, request('paste', [type('A\tB\r\n한')]));
  assert.equal(result.completedSteps, 8);
  assert.deepEqual(result.cursor, { x: 102, y: 101 });
  assert.equal(f.world.getCell(105, 100).text, 'B');
  assert.equal(f.world.getCell(100, 101).text, '한');
  assert.equal(f.now(), 700);
});

test('relative movement is streamed in short steps and wraps on the torus', async t => {
  const f = fixture(t, { x: 1020 });
  const result = await f.runner.run(f.actor, request('walk', [{ type: 'move', dx: 24, dy: 0 }]));
  assert.deepEqual(result.cursor, { x: 20, y: 100 });
  assert.deepEqual(f.presences.map(item => [item.time, item.x]), [[0, 4], [50, 12], [100, 20]]);
  assert.equal(f.world.seq, 0);
  await f.runner.run(f.actor, request('write', [type('X'), { type: 'enter' }, type('Y')]));
  assert.equal(f.world.getCell(20, 101).text, 'Y', 'navigation starts a new writing margin');
});

test('Enter, return Backspace, wide Backspace and Home use the human writing model', async t => {
  const f = fixture(t);
  await f.runner.run(f.actor, request('keys', [type('A한'), { type: 'enter' }, { type: 'backspace' }, { type: 'backspace' }]));
  assert.deepEqual({ x: f.actor.peer.x, y: f.actor.peer.y }, { x: 101, y: 100 });
  assert.equal(f.world.getCell(101, 100).text, '');
  assert.equal(f.world.getCell(102, 100).text, '');
  assert.equal(f.world.getCell(100, 100).text, 'A');
  await f.runner.run(f.actor, request('home', [{ type: 'home' }, { type: 'delete' }]));
  assert.deepEqual({ x: f.actor.peer.x, y: f.actor.peer.y }, { x: 100, y: 100 });
  assert.equal(f.world.getCell(100, 100).text, '');
});

test('completed retries do not mutate, charge or rewind the current cursor', async t => {
  const f = fixture(t);
  const first = await f.runner.run(f.actor, request('same', [type('A')]));
  await f.runner.run(f.actor, request('move', [{ type: 'move', dx: 8, dy: 0 }]));
  const seq = f.world.seq, cursor = { ...f.actor.peer }, tokens = f.actor.policy.write.tokens;
  assert.deepEqual(await f.runner.run(f.actor, request('same', [type('A')])), first);
  assert.equal(f.world.seq, seq); assert.deepEqual(f.actor.peer, cursor);
  assert.equal(f.actor.policy.write.tokens, tokens);
  await assert.rejects(f.runner.run(f.actor, request('same', [type('B')])), errorIs(409, 'ID_CONFLICT'));
});

test('only one turn runs, active duplicates are immediate, cancellation aborts waiting', async t => {
  const f = fixture(t, { delay: (ms, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const first = f.runner.run(f.actor, request('slow', [type('ABCDE')]));
  await tick();
  assert.equal(f.world.seq, 1);
  const active = await f.runner.run(f.actor, request('slow', [type('ABCDE')]));
  assert.equal(active.status, 'running'); assert.equal(active.completedSteps, 1);
  await assert.rejects(f.runner.run(f.actor, request('other', [type('Z')])), errorIs(429, 'TURN_BUSY'));
  assert.equal(f.runner.cancel(f.actor), true);
  const cancelled = await first;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.completedSteps, 1);
  assert.equal(f.world.seq, 1); assert.equal(f.runner.cancel(f.actor), false);
  assert.deepEqual(await f.runner.run(f.actor, request('slow', [type('ABCDE')])), cancelled);
});

test('a mid-turn policy rejection reports exact partial progress and a real 429', async t => {
  const f = fixture(t);
  f.actor.policy.write.spend(64);
  const blocked = await f.runner.run(f.actor, request('blocked', [type('ABC')]));
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.completedSteps, 0);
  assert.equal(blocked.error.status, 429); assert.equal(blocked.error.retryAfterMs, 84);
  assert.equal(f.world.seq, 0);
  f.advance(1000);
  assert.deepEqual(await f.runner.run(f.actor, request('blocked', [type('ABC')])), blocked, 'retry never silently repeats a blocked turn');
});

test('a blocked Backspace preserves writing trail for the next independent attempt', async t => {
  const f = fixture(t);
  await f.runner.run(f.actor, request('write', [type('한')]));
  f.actor.policy.write.spend(63);
  const original = f.actor.policy.acceptErase.bind(f.actor.policy);
  f.actor.policy.acceptErase = () => { throw new PolicyError('RATE_LIMITED', 'wait', { status: 429, retryAfterMs: 100 }); };
  const before = structuredClone(f.actor.writing.trail);
  const blocked = await f.runner.run(f.actor, request('erase', [{ type: 'backspace' }]));
  assert.equal(blocked.status, 'blocked'); assert.deepEqual(f.actor.writing.trail, before);
  assert.equal(f.actor.peer.x, 102);
  f.actor.policy.acceptErase = original;
  f.advance(1000);
  assert.equal((await f.runner.run(f.actor, request('erase-again', [{ type: 'backspace' }]))).status, 'completed');
  assert.equal(f.actor.peer.x, 100);
});

test('world resize during a delay stops remaining steps before mutation', async t => {
  let f;
  f = fixture(t, { width: 128, height: 64, x: 10, y: 10, delay: async ms => {
    f.advance(ms); f.world.resize(256, 128, [f.actor.peer]);
  } });
  const result = await f.runner.run(f.actor, request('resize', [type('ABC')]));
  assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'STALE_EPOCH');
  assert.equal(result.error.status, 409); assert.equal(result.completedSteps, 1);
  assert.equal(f.world.getCell(10, 10).text, 'A'); assert.equal(f.world.getCell(11, 10), undefined);
});

test('expired result IDs remain tombstoned and cannot accidentally execute twice', async t => {
  const f = fixture(t);
  for (let i = 0; i <= TURN_LIMITS.recentResults; i++) {
    await f.runner.run(f.actor, request(`turn-${i}`, [{ type: 'wait', ms: 0 }]));
  }
  await assert.rejects(f.runner.run(f.actor, request('turn-0', [{ type: 'wait', ms: 0 }])), errorIs(409, 'IDEMPOTENCY_EXPIRED'));
  assert.equal(f.world.seq, 0);
});

test('session lifetime bounds request tombstones without recycling old IDs', async t => {
  const f = fixture(t);
  for (let i = 0; i < TURN_LIMITS.lifetimeTurns; i++) await f.runner.run(f.actor, request(`t${i}`, [{ type: 'wait', ms: 0 }]));
  await assert.rejects(f.runner.run(f.actor, request('overflow', [type('A')])), errorIs(409, 'SESSION_TURN_LIMIT'));
  assert.equal(f.world.seq, 0);
});

test('shutdown cancels pending work and rejects new turns', async t => {
  const f = fixture(t, { delay: (ms, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const pending = f.runner.run(f.actor, request('wait', [{ type: 'wait', ms: 30000 }]));
  await tick();
  const finished = await f.runner.shutdown();
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'fulfilled');
  assert.equal(finished[0].value.status, 'cancelled');
  assert.equal((await pending).status, 'cancelled');
  await assert.rejects(f.runner.run(f.actor, request('new', [type('A')])), errorIs(410, 'SESSION_CLOSED'));
});


test('world mutations notify once; pure navigation publishes presence separately', async t => {
  const f = fixture(t);
  await f.runner.run(f.actor, request('notify', [type('A'), { type: 'delete' }, { type: 'move', dx: 1, dy: 0 }]));
  assert.equal(f.effects.length, 2);
  assert.equal(f.presences.length, 1);
});

test('notification failures still report already committed progress', async t => {
  const f = fixture(t);
  const runner = createTurnRunner({ world: f.world, now: f.now, publish() { throw new Error('transport failure'); } });
  t.after(() => runner.shutdown());
  const result = await runner.run(f.actor, request('published', [type('A')]));
  assert.equal(result.status, 'blocked'); assert.equal(result.completedSteps, 1);
  assert.equal(result.completedActions, 1);
  assert.equal(f.world.getCell(100, 100).text, 'A');
});
