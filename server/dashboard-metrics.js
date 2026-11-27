import { setImmediate as yieldToWorld } from 'node:timers/promises';
import { merge, summary } from '../shared/measurement.js';
import { MODES, ROLES, SOURCES, USAGE_SAMPLE } from './usage-patterns.js';
import { describeUsage } from './usage-summary.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const columns = [
  USAGE_SAMPLE, 'process.elapsed_ms', 'process.cpu_ms', 'process.rss_bytes',
  'delivery.ready_ms', 'client.reported.ack_ms', 'client.reported.submit_to_draw_ms',
  'ws.wire_tx_bytes', 'ws.playtest_wire_tx_bytes', 'usage.public_ws.visible_others',
  'usage.public_ws.short_stay', 'usage.public_ws.write.busy', 'usage.public_ws.write.limited',
  ...ROLES.map(role => 'usage.public_ws.stay.' + role + '_ms'),
  ...SOURCES.flatMap(source => MODES.map(mode => 'usage.' + source + '.time.' + mode + '_ms')),
];

// A rollout may leave two partial revisions in the same calendar bucket. Only
// merge instrumented revisions, and merge their histograms before computing p95.
const placeholders = columns.map(() => '?').join(',');
const selectBucket = 'SELECT m.metric, m.value FROM measurements m WHERE m.period=? AND m.bucket=?' +
  ' AND m.metric IN (' + placeholders + ') AND EXISTS (SELECT 1 FROM measurements coverage' +
  ' WHERE (coverage.bucket,coverage.period,coverage.revision)=(m.bucket,m.period,m.revision) AND coverage.metric=?)';

function point(time, rows) {
  const metrics = new Map();
  for (const { metric, value } of rows) {
    const h = JSON.parse(value), prior = metrics.get(metric);
    metrics.set(metric, prior ? merge(prior, h) : h);
  }
  if (!metrics.size) return { time };
  for (const [name, h] of metrics) metrics.set(name, summary(h));
  const { sources, service, measuredSeconds } = describeUsage(metrics);
  const ws = sources.public_ws;
  return {
    time, publicWs: ws.averageConcurrent, agents: sources.agent_api.averageConcurrent,
    playtest: sources.playtest.averageConcurrent, visibleMean: ws.visibleOthers.mean,
    visibleMax: metrics.get('usage.public_ws.visible_others')?.max ?? null,
    busyWrites: ws.actions.write.busy, limitedWrites: ws.actions.write.limited,
    ackP95: service.clientAckMs.p95Upper, drawP95: service.clientSubmitToDrawMs.p95Upper,
    readyP95: service.readyMs.p95Upper, observing: ws.timeFraction.observing,
    moving: ws.timeFraction.moving, editing: ws.timeFraction.editing,
    firstWrite: ws.firstWriteFraction, shortStay: ws.shortStayFraction,
    cpu: service.averageCores, rss: service.meanRssBytes,
    publicTx: measuredSeconds > 0 ? service.publicWsBytes / measuredSeconds : null,
  };
}

export async function dashboardSeries(db, from, to, { now = Date.now(), cancelled = () => false } = {}) {
  const start = Math.max(from, now - 90 * DAY), end = Math.min(to, now);
  const minuteCutoff = Math.floor((now - 6 * HOUR) / 60000) * 60000;
  const hourCutoff = Math.floor((now - 30 * DAY) / HOUR) * HOUR;
  const period = start >= minuteCutoff ? 60 : start >= hourCutoff && end - start <= 14 * DAY ? 3600 : 86400;
  const result = { period, rows: [] };
  if (start > end) return result;
  const step = period * 1000, read = db.prepare(selectBucket);
  let yieldAt = performance.now() + 3;
  for (let bucket = Math.floor(start / step) * step; bucket <= end; bucket += step) {
    if (cancelled()) break;
    result.rows.push(point(new Date(bucket).toISOString(), read.all(period, bucket, ...columns, USAGE_SAMPLE)));
    if (performance.now() >= yieldAt) {
      await yieldToWorld();
      yieldAt = performance.now() + 3;
    }
  }
  return result;
}
