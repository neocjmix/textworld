import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { scenario, target } from '../experiments/playtest/scenario.mjs';
import { startTraffic } from '../experiments/playtest/traffic.mjs';
import { graphemes } from '../shared/world.js';

const script = fileURLToPath(new URL('../experiments/playtest/run.mjs', import.meta.url));
const plan = {
  seed: 7, lifetimeSeconds: [2, 2], budget: { admissions: 40, botMinutes: 10, receivedMiB: 48 },
  phases: [{ name: '시작', seconds: 9, writers: 1, walkers: 0, readers: 0 },
    { name: '조용', seconds: 2, writers: 0, walkers: 0, readers: 0 }],
};

async function waitFor(check) {
  const end = Date.now() + 8000;
  do { const value = await check(); if (value) return value; await sleep(40); } while (Date.now() < end);
  throw Error('runner condition timed out');
}

async function start(t, config) {
  const cwd = await mkdtemp(join(tmpdir(), 'tw-runner-test-'));
  const path = join(cwd, 'plan.json');
  await writeFile(path, JSON.stringify(config));
  const child = spawn(process.execPath, [script, '--scenario', path], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8').on('data', chunk => { output += chunk; });
  }
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    await rm(cwd, { recursive: true, force: true });
  });
  const link = await waitFor(() => {
    if (child.exitCode && !output.includes('지도 http://')) throw Error(output);
    return output.match(/^지도 (http:\/\/[^\s]+)/m)?.[1];
  });
  const dir = output.match(/^기록 (.+)$/m)[1];
  async function end() {
    const [code] = await exited;
    assert.equal(code, 0, output);
    return (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  }
  return { child, link, end };
}

test('only finite plans, positive budgets and bounded role targets are accepted', () => {
  assert.ok(scenario.safeParse(plan).success);
  assert.equal(scenario.safeParse({ ...plan, lifetimeSeconds: [5, 2] }).success, false);
  assert.equal(scenario.safeParse({ ...plan, budget: { ...plan.budget, botMinutes: 0 } }).success, false);
  assert.equal(scenario.safeParse({ ...plan, phases: [{ ...plan.phases[0], seconds: 3600 }, plan.phases[1]] }).success, false);
  assert.equal(target.safeParse({ writers: 24, walkers: 24, readers: 1 }).success, false);
  assert.equal(scenario.parse(plan).jitterRatio, .3);
  assert.equal(scenario.safeParse({ ...plan, jitterRatio: .61 }).success, false);
});

test('a writer sends one grapheme at a time and rests after a delayed acknowledgement', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const writes = [];
  let release;
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'snapshot', world: { epoch: 1 }, peers: [] }));
    socket.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type !== 'input') return;
      const ack = () => socket.send(JSON.stringify({ type: 'ack', id: m.id }));
      if (m.action.kind === 'type') {
        writes.push({ at: performance.now(), text: m.action.text });
        if (writes.length === 1) { release = ack; return; }
      }
      ack();
    });
  });
  const traffic = startTraffic({ port: server.address().port, onPhase() {},
    plan: scenario.parse({ ...plan, lifetimeSeconds: [25, 25], phases: [
      { ...plan.phases[0], seconds: 20, actionIntervalMs: 650 },
    ] }) });
  t.after(async () => { await traffic.stop('test'); await new Promise(resolve => server.close(resolve)); });
  await waitFor(() => release);
  await sleep(600);
  assert.equal(writes.length, 1);
  const released = performance.now();
  release();
  await waitFor(() => writes.length >= 8 && traffic.population.report().writtenGraphemes >= 8);
  assert.ok(writes[1].at - released >= 90);
  assert.ok(writes.every(({ text }) => graphemes(text).length === 1));
  assert.equal(writes.slice(0, 8).map(w => w.text).join(''), '지금 보이는 글');
});

test('the visitable world handles churn, operator changes, ordinary address limits, a quiet phase and shutdown', { timeout: 24000 }, async t => {
  const { link, child, end } = await start(t, plan);
  child.stdin.write('set 49 0 0\nset 0 1 2 overwrite\nmark 입력 확인\n');
  const health = new URL('/health', link);
  await waitFor(async () => (await (await fetch(health)).json()).peers === 3);
  const browserSocket = new URL('/ws', link); browserSocket.protocol = 'ws:';
  const sockets = [];
  try {
    for (let i = 0; i < 8; i++) {
      const s = new WebSocket(browserSocket); sockets.push(s);
      await once(s, 'open');
    }
    const excess = new WebSocket(browserSocket);
    const [error] = await once(excess, 'error');
    assert.match(error.message, /429/);
  } finally { for (const s of sockets) s.terminate(); }
  const events = await end();
  assert.equal(events.filter(e => e.type === 'override').length, 1);
  assert.equal(events.find(e => e.type === 'override').phase.writing, 'overwrite');
  assert.equal(events.find(e => e.type === 'mark').note, '입력 확인');
  assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.phase.name), ['시작','조용']);
  const { reason, world, population: p } = events.at(-1);
  assert.equal(reason, 'deadline');
  assert.equal(world.connections, 0);
  assert.equal(p.peak, 3);
  assert.ok(p.departures.lifetime > 0 && p.departures['target-reduced'] > 0);
  assert.ok(p.ack > 0 && p.receivedBytes > 0);
  assert.equal(p.sent, p.ack + p.rejected + p.unconfirmed);
  assert.equal(Object.values(p.departures).reduce((a,b) => a+b), p.attempts);
  await assert.rejects(fetch(health));
});

test('repeated overwrites by a long-lived writer keep the same two CJK cells occupied', { timeout: 18000 }, async t => {
  const { end } = await start(t, { ...plan, lifetimeSeconds: [20, 20],
    phases: [{ ...plan.phases[0], seconds: 6, writing: 'overwrite', actionIntervalMs: 650 }] });
  const result = (await end()).at(-1);
  assert.equal(result.world.occupiedCells, 2);
  assert.ok(result.population.ack >= 4);
});

test('each resource budget and an operator interrupt independently end a run', { timeout: 20000 }, async t => {
  const cases = [
    ['admission-budget', { admissions: 1 }], ['byte-budget', { receivedMiB: .001 }],
    ['bot-minute-budget', { botMinutes: .002 }], ['signal', {}], ['operator', {}],
  ];
  await Promise.all(cases.map(async ([reason, budget]) => {
    const { child, end } = await start(t, { ...plan, budget: { ...plan.budget, ...budget },
      phases: [{ ...plan.phases[0], seconds: 14, writers: 2 }] });
    if (reason === 'signal') child.kill('SIGTERM');
    if (reason === 'operator') child.stdin.write('stop\n');
    const last = (await end()).at(-1);
    assert.equal(last.reason, reason);
    assert.equal(last.world.connections, 0);
    const p = last.population;
    assert.equal(p.sent, p.ack + p.rejected + p.unconfirmed);
  }));
});
