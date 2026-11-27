import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTextworld } from '../server/index.js';
import { Measurements } from '../server/measurements.js';
import { UsageSession, USAGE_SAMPLE, writeKind } from '../server/usage-patterns.js';
import { usageReport } from '../scripts/usage-report.mjs';
import { readMetrics } from '../scripts/read-metrics.mjs';
import { connect } from './ws-client.js';

test('elapsed session mix, closed cohorts, cadence and crowd are measured without action payloads', t => {
  const m = new Measurements({ now: () => 0 });
  t.after(() => m.close());
  let at = 0;
  const start = () => new UsageSession(m, 'public_ws', () => at);
  const reader = start(), editor = start(), writer = start();
  const view = { peers: new Map([['self', {}], ['peer', {}]]), view: { cols: 7, rows: 5 } };
  at = 400; writer.accepted('write', 1, true);
  at = 500; writer.accepted('move');
  at = 600; writer.accepted('write', 2, true);
  at = 700; editor.accepted('write', 1, false); editor.accepted('erase'); editor.sample(view, true);
  at = 1000; reader.sample({ ...view, peers: new Map([['self', {}]]) }, true); writer.sample(view);
  writer.denied(null, { status: 429, code: 'RATE_LIMITED' }, { type: 'input', action: { kind: 'native', edit: { text: '私' } } });
  writer.denied('move', { status: 429, code: 'WORLD_BUSY' });
  at = 61000; writer.sample(view, true);
  m.record(USAGE_SAMPLE); m.record('process.elapsed_ms', at);
  m.record('ws.wire_tx_bytes', 567); m.record('ws.playtest_wire_tx_bytes', 67);
  m.flush();
  const report = usageReport(m.read({ period: 86400 }), { period: 86400, since: 0, before: 1 });
  const bucket = report.buckets[0], p = bucket.sources.public_ws;
  assert.equal(report.coveredBuckets, 1);
  assert.deepEqual(p.closedRoles, { observer: 1, mover: 0, editor: 1, writer: 1 });
  assert.equal(p.firstWriteFraction, 1/3); assert.equal(p.shortStayFraction, 2/3);
  assert.equal(p.firstWriteMs.mean, 400); assert.equal(p.actions.write.gapMs.mean, 200);
  assert.equal(p.graphemesPerWrite.mean, 4/3);
  assert.equal(p.actions.write.limited, 1); assert.equal(p.actions.move.busy, 1);
  assert.equal(p.timeFraction.editing, 1700/62700); assert.equal(p.timeFraction.observing, 61000/62700);
  assert.equal(p.sharedViewFraction, 3/4); assert.equal(p.visibleOthers.mean, .75); assert.equal(p.viewCells.mean, 35);
  assert.equal(bucket.service.publicWsBytes, 500); assert.equal(bucket.service.publicWsBytesPerParticipantHour, 500 / (62700/3600000));
  assert.equal(bucket.includesPlaytest, true); assert.equal(bucket.sources.playtest.firstWriteFraction, null);
  assert.equal(JSON.stringify(report).includes('私'), false);
  assert.equal(writeKind('\n'), 'move'); assert.equal(writeKind('', true), 'erase');
});

test('public WS replay, HTTP turn replay and a short reader count once in their own channel', async t => {
  const app = createTextworld({ storagePath: ':memory:', metricsToken: 'fixture' });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1'), base = 'http://127.0.0.1:' + port;
  const ws = connect('ws://127.0.0.1:' + port + '/ws');
  await ws.next(m => m.type === 'snapshot');
  ws.send({ type: 'hello', name: 'playtest', source: 'playtest' });
  const event = { type: 'input', epoch: 1, sequence: 1, id: 'once', action: { kind: 'type', text: '비' } };
  ws.send(event); await ws.next(m => m.type === 'ack' && m.id === 'once');
  ws.send(event); await ws.next(m => m.type === 'ack' && m.duplicate);
  const path = base + '/api/agents/v1/sessions';
  const request = (path, method, body, token) => fetch(path, { method, body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) } });
  async function joinSession() {
    const joined = await request(path, 'POST', {});
    assert.equal(joined.status, 201);
    return (await joined.json()).session;
  }
  const reader = await joinSession(), writer = await joinSession();
  const turn = { id: 'retry', actions: [{ type: 'type', text: '가' }] };
  for (let i = 0; i < 2; i++) {
    const reply = await request(path + '/' + writer.id + '/turn', 'POST', turn, writer.token);
    assert.equal(reply.status, 200);
  }
  for (const s of [reader, writer]) assert.equal((await request(path + '/' + s.id, 'DELETE', undefined, s.token)).status, 204);
  const closed = once(ws.socket, 'close'); ws.socket.close(); await closed;
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.equal((await fetch(base + '/', { headers: { 'if-none-match': page.headers.get('etag') } })).status, 304);
  app.measurements.flush();
  const data = await readMetrics({ base, token: 'fixture', limit: 5 });
  const metric = name => data.rows.find(r => r.metric === name)?.value;
  assert.equal(metric('usage.public_ws.write.ok').sum, 1); assert.equal(metric('usage.public_ws.short_stay').sum, 1);
  assert.equal(metric('usage.agent_api.write.ok').sum, 1); assert.equal(metric('usage.agent_api.stay.writer_ms').count, 1);
  assert.equal(metric('usage.agent_api.stay.observer_ms').count, 1);
  assert.equal(metric('usage.playtest.opened'), undefined); assert.equal(metric('http.map.status_304').sum, 1);
  assert.ok(!JSON.stringify(data).includes(writer.token));
});

test('day rollups survive restart, time out after 90 days, and unavailable windows stay unknown', async t => {
  const day = 86400000, dir = await mkdtemp(join(tmpdir(), 'tw-usage-')), path = join(dir, 'metrics.sqlite');
  let now = 0, m;
  t.after(async () => { m?.close(); await rm(dir, { recursive: true, force: true }); });
  function boot(revision) { m = new Measurements({ path, now: () => now, revision }); }
  boot('legacy'); m.record('process.elapsed_ms', 1000); m.close();
  boot('a'); m.record('usage.agent_api.opened', 2); m.record(USAGE_SAMPLE); m.flush();
  now += 3600000; m.record('usage.agent_api.opened', 3); m.record(USAGE_SAMPLE); m.close();
  boot('b'); m.record(USAGE_SAMPLE); m.flush();
  const days = m.read({ period: 86400 });
  const keys = days.map(r => [r.bucket, r.revision, r.metric]);
  const paged = [];
  let after;
  for (;;) {
    const page = m.read({ period: 86400, limit: 2, after });
    if (!page.length) break;
    for (const r of page) { after = [r.bucket, r.revision, r.metric]; paged.push(after); }
  }
  assert.deepEqual(paged, keys);
  const report = usageReport([...days, ...m.read({ period: 60 })], { period: 86400, since: 0, before: 2*day });
  assert.equal(report.expectedBuckets, 3); assert.equal(report.coveredBuckets, 1);
  assert.equal(report.buckets.find(r => r.revision === 'legacy').sources, undefined);
  assert.equal(report.buckets.find(r => r.revision === 'a').sources.agent_api.opened, 5);
  assert.equal(report.buckets.find(r => r.revision === 'b').sources.agent_api.opened, 0);
  now = 31*day; m.record(USAGE_SAMPLE); m.flush();
  assert.equal(m.read({ period: 3600, before: day }).length, 0);
  assert.ok(m.read({ period: 86400, before: day }).length);
  now = 91*day; m.record(USAGE_SAMPLE); m.flush();
  assert.equal(m.read({ period: 86400, before: day }).length, 0);
});

test('row pressure evicts complete buckets so covered cohorts keep every denominator', t => {
  let now = 0;
  const m = new Measurements({ now: () => now, maxRows: 32 });
  t.after(() => m.close());
  for (let i = 0; i < 40; i++) {
    now += 86400000;
    m.record(USAGE_SAMPLE); m.record('usage.public_ws.opened'); m.record('usage.public_ws.stay.writer_ms', 100);
    m.flush();
  }
  assert.ok(m.db.prepare('SELECT count(*) n FROM measurements').get().n <= 32);
  for (const period of [60, 3600, 86400]) {
    const groups = Map.groupBy(m.read({ period }), r => r.bucket);
    assert.ok(groups.size >= 1);
    for (const group of groups.values()) assert.ok([USAGE_SAMPLE, 'usage.public_ws.opened', 'usage.public_ws.stay.writer_ms']
      .every(name => group.some(r => r.metric === name)));
  }
});

test('window totals pool raw counts for organic periods and isolate periods with the internal runner', t => {
  let now = 0;
  const m = new Measurements({ now: () => now });
  t.after(() => m.close());
  for (const [i, [writers, observers, test]] of [[1, 0, false], [0, 3, false], [2, 0, true]].entries()) {
    now = i * 3600000;
    m.record(USAGE_SAMPLE); m.record('process.elapsed_ms', 60000);
    for (let n = 0; n < writers; n++) m.record('usage.public_ws.stay.writer_ms', 9000);
    for (let n = 0; n < observers; n++) m.record('usage.public_ws.stay.observer_ms', 1000);
    if (test) m.record('usage.playtest.opened');
    m.flush();
  }
  const { totals } = usageReport(m.read({ period: 3600 }), { period: 3600, since: 0, before: now });
  const ordinary = totals.find(r => !r.includesPlaytest), trial = totals.find(r => r.includesPlaytest);
  assert.equal(ordinary.buckets, 2); assert.equal(ordinary.sources.public_ws.firstWriteFraction, .25);
  assert.equal(ordinary.sources.public_ws.meanStayMs, 3000); assert.equal(ordinary.service.reportedVisibleFraction, null);
  assert.equal(trial.buckets, 1); assert.equal(trial.sources.public_ws.closed, 2);
});
