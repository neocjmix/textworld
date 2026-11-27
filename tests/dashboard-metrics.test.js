import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextworld } from '../server/index.js';
import { Measurements } from '../server/measurements.js';
import { USAGE_SAMPLE } from '../server/usage-patterns.js';
import { dashboardSeries } from '../server/dashboard-metrics.js';
import { dashboard } from '../observability/grafana/dashboard.mjs';

test('dashboard combines covered revisions before deriving rates and p95, preserving unknown time', async t => {
  const at = Date.UTC(2026, 10, 27, 15), m = new Measurements({ now: () => at, revision: 'legacy' });
  t.after(() => m.close());
  m.record('process.elapsed_ms', 3600000); m.record('client.reported.ack_ms', 32768); m.flush();
  m.revision = 'a';
  m.record(USAGE_SAMPLE); m.record('process.elapsed_ms', 30000);
  m.record('usage.public_ws.time.observing_ms', 60000);
  m.record('usage.public_ws.visible_others', 1); m.record('usage.public_ws.write.busy');
  for (let i=0; i<20; i++) m.record('client.reported.ack_ms', 4);
  for (let i=0; i<3; i++) m.record('usage.public_ws.stay.observer_ms', 1000);
  m.flush();
  m.revision = 'b';
  m.record(USAGE_SAMPLE); m.record('process.elapsed_ms', 30000);
  m.record('usage.public_ws.time.editing_ms', 30000); m.record('usage.playtest.time.observing_ms', 60000);
  m.record('usage.public_ws.visible_others', 5); m.record('usage.public_ws.stay.writer_ms', 80000);
  m.record('ws.wire_tx_bytes', 6500); m.record('ws.playtest_wire_tx_bytes', 500); m.record('client.reported.ack_ms', 64);
  m.flush();
  const { period, rows } = await dashboardSeries(m.db, at-60000, at+60000, { now: at+60000 });
  assert.equal(period, 60); assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {time: new Date(at-60000).toISOString()}); assert.equal(rows[2].busyWrites, undefined);
  const r = rows[1];
  assert.equal(r.publicWs, 1.5); assert.equal(r.playtest, 1); assert.equal(r.agents, 0);
  assert.equal(r.visibleMean, 3); assert.equal(r.visibleMax, 5);
  assert.equal(r.firstWrite, .25); assert.equal(r.busyWrites, 1); assert.equal(r.limitedWrites, 0);
  assert.equal(r.ackP95, 4); assert.equal(r.drawP95, null); assert.equal(r.publicTx, 100);
  const series = dashboard.panels[0].targets[0].columns.map(c => c.selector).sort();
  assert.deepEqual(Object.keys(r).sort(), series);
  assert.ok(dashboard.panels.slice(1).every(p => p.targets[0].panelId === 1 && p.targets[0].withTransforms === false));
});

test('dashboard chooses a retained resolution and caps the longest query to 90 days', async t => {
  const m = new Measurements(), now = Date.UTC(2026, 10, 27, 12), day = 86400000;
  t.after(() => m.close());
  const hours = await dashboardSeries(m.db, now-2*day, now-day, { now });
  assert.equal(hours.period, 3600); assert.equal(hours.rows.length, 25);
  const months = await dashboardSeries(m.db, 0, now, { now });
  assert.equal(months.period, 86400); assert.equal(months.rows.length, 91);
  assert.deepEqual((await dashboardSeries(m.db, 0, now-120*day, { now })).rows, []);
});

test('Grafana reads the same protected, uncached metrics API and rejects invalid ranges', async t => {
  const app = createTextworld({ storagePath: ':memory:', metricsToken: 'fixture-read-only' });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1'), base = 'http://127.0.0.1:' + port + '/api/metrics?format=dashboard';
  const auth = { headers: { authorization: 'Bearer fixture-read-only' } };
  assert.equal((await fetch(base)).status, 404);
  for (const q of ['', '&since=1e20&before=2', '&since=3&before=2'])
    assert.equal((await fetch(base+q, auth)).status, 400);
  const at = Date.now();
  app.measurements.record(USAGE_SAMPLE); app.measurements.record('process.elapsed_ms', 60000); app.measurements.flush();
  const r = await fetch(base+'&since='+(at-60000)+'&before='+(at+1000), auth);
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const d = await r.json(); assert.ok(d.rows.some(row => row.publicWs === 0 && row.visibleMean === null));
});
