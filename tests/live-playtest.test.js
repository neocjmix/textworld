import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createTextworld } from '../server/index.js';

const plan = { seed: 3, lifetimeSeconds: [8, 10], budget: { admissions: 32, botMinutes: 4, receivedMiB: 48 },
  phases: [{ name: '현장 체험', seconds: 16, writers: 2, walkers: 2, readers: 5 }] };
async function until(check) {
  const deadline = Date.now() + 10000;
  do { const value = await check(); if (value) return value; await sleep(40); } while (Date.now() < deadline);
  throw Error('timed out waiting for the live world');
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-live-'));
  const token = randomUUID();
  let app, base;
  async function boot() {
    app = createTextworld({ storagePath: join(dir, 'world.sqlite'), playtestToken: token, trustProxy: false });
    base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1')).port;
  }
  await boot();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, get base() { return base; },
    async restart() { await app.close(); await boot(); },
    health: async () => (await fetch(base + '/health')).json(),
    operator: async (body, key) => {
      const r = await fetch(base + '/api/playtest' + (key ? '?id=' + key : ''), { method: body ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    },
  };
}

test('visiting is passive; one authenticated run shares cells with ordinary map clients and stops independently', { timeout: 25000 }, async t => {
  const f = await fixture(t), id = randomUUID();
  const visit = await fetch(f.base + '/playtest', { redirect: 'manual' });
  assert.equal(visit.status, 302);
  assert.match(visit.headers.get('location'), /^\/#x=\d+&y=\d+$/);
  assert.equal((await fetch(f.base + '/api/playtest', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await f.operator()).data.state, 'idle');
  assert.equal((await f.health()).peers, 0);
  await assert.rejects(stat(join(f.dir, 'playtests')), { code: 'ENOENT' });
  assert.equal((await f.operator({ command: 'start', id, plan: { ...plan, phases: [] } })).status, 400);

  const browser = new WebSocket(f.base.replace('http:', 'ws:') + '/ws');
  let actorsSeen = false, inkSeen = false;
  browser.on('message', raw => {
    const m = JSON.parse(raw);
    const view = m.type === 'snapshot' ? m : m.observation;
    if (view?.peers?.some(p => p.name.startsWith('글쓴이'))) actorsSeen = true;
    if (view?.cells?.some(c => c.text?.trim())) inkSeen = true;
  });
  await once(browser, 'open');
  try {
    const start = { command: 'start', id, plan };
    const responses = await Promise.all([f.operator(start), f.operator(start)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 202]);
    assert.equal((await f.operator({ ...start, id: randomUUID() })).status, 409);
    await until(async () => (await f.health()).peers === 10 && actorsSeen && inkSeen);
    await until(async () => (await f.operator()).data.position);
    const where = await fetch(f.base + '/playtest', { redirect: 'manual' });
    assert.match(where.headers.get('location'), /^\/#x=\d+&y=\d+$/);
    assert.equal((await f.operator({ command: 'stop', id: randomUUID() })).status, 409);
    assert.equal((await f.operator({ command: 'set', id, counts: { writers: 1, walkers: 0, readers: 0 }, writing: 'overwrite' })).status, 202);
    await until(async () => (await f.health()).peers === 2 && (await f.operator()).data.phase.writing === 'overwrite');
    await f.operator({ command: 'mark', id, note: '같은 지도' });
    await f.operator({ command: 'stop', id });
    await until(async () => (await f.operator()).data.state === 'idle');
    const result = (await f.operator(null, id)).data;
    assert.equal(result.reason, 'operator');
    assert.ok(result.population.ack > 0);
    assert.equal(result.population.sent, result.population.ack + result.population.rejected + result.population.unconfirmed);
    assert.equal((await f.health()).peers, 1);
    assert.equal(browser.readyState, WebSocket.OPEN);
    const events = (await readFile(join(f.dir, 'playtests', id, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.type === 'mark' && e.note === '같은 지도'));
    assert.equal(events.at(-1).reason, 'operator');
    assert.equal((await f.operator(start)).data.state, 'finished');
  } finally { browser.terminate(); }
});

test('deployment, a wall-clock deadline and a byte budget end only their run; restart cannot replay an ID', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = { command: 'start', id: randomUUID(), plan };
  await f.operator(first);
  await until(async () => (await f.health()).peers > 0);
  await f.restart();
  assert.equal((await f.health()).playtest, 'idle');
  assert.equal((await f.operator(first)).data.reason, 'deployment');
  assert.equal((await f.health()).peers, 0);
  for (const [reason, seconds, receivedMiB] of [['deadline', 2, 48], ['byte-budget', 10, .0001]]) {
    const id = randomUUID();
    await f.operator({ command: 'start', id, plan: { ...plan, budget: { ...plan.budget, receivedMiB },
      phases: [{ ...plan.phases[0], seconds, writers: 1, walkers: 0, readers: 0 }] } });
    await until(async () => (await f.operator()).data.state === 'idle');
    assert.equal((await f.operator(null, id)).data.reason, reason);
    assert.equal((await f.health()).peers, 0);
  }
});
