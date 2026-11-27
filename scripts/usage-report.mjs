import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ACTIONS, MODES, ROLES, SOURCES, USAGE_SAMPLE } from '../server/usage-patterns.js';
import { readMetrics } from './read-metrics.mjs';
import { empty, merge, summary } from '../shared/measurement.js';

const ratio = (n, d) => d > 0 ? n / d : null;
const sum = row => row?.sum ?? 0;
const count = row => row?.count ?? 0;
function distribution(row) {
  return { samples: count(row), mean: row?.mean ?? null, p95Upper: row?.p95Upper ?? null };
}

function sourceReport(metrics, source, elapsedMs) {
  const get = key => metrics.get('usage.' + source + '.' + key);
  const roles = Object.fromEntries(ROLES.map(role => [role, count(get('stay.' + role + '_ms'))]));
  const closed = Object.values(roles).reduce((a, b) => a + b, 0);
  const stayMs = ROLES.reduce((n, role) => n + sum(get('stay.' + role + '_ms')), 0);
  const modeMs = MODES.map(mode => sum(get('time.' + mode + '_ms')));
  const presentMs = modeMs.reduce((a, b) => a + b, 0);
  const actions = {};
  for (const action of [...ACTIONS, 'other']) {
    const busy = sum(get(action + '.busy')), limited = sum(get(action + '.limited'));
    actions[action] = { busy, limited };
    if (action !== 'other') {
      const accepted = sum(get(action + '.ok'));
      Object.assign(actions[action], { accepted, acceptedPerParticipantHour: ratio(3600000 * accepted, presentMs),
        gapMs: distribution(get(action + '.gap_ms')) });
    }
  }
  return {
    opened: sum(get('opened')), closed, closedRoles: roles, shortStayFraction: ratio(sum(get('short_stay')), closed),
    firstWriteFraction: ratio(roles.writer, closed), firstWriteMs: distribution(get('first_write_ms')),
    meanStayMs: ratio(stayMs, closed), participantHours: presentMs / 3600000,
    averageConcurrent: ratio(presentMs, elapsedMs),
    timeFraction: Object.fromEntries(MODES.map((mode, i) => [mode, ratio(modeMs[i], presentMs)])),
    actions, graphemesPerWrite: distribution(get('write_graphemes')),
    visibleOthers: distribution(get('visible_others')), viewCells: distribution(get('view_cells')),
    sharedViewFraction: ratio(sum(get('shared_view')), count(get('visible_others'))),
    admissionFull: sum(get('join_full')), admissionLimited: sum(get('join_limited')),
  };
}

function describe(metrics) {
  const get = key => metrics.get(key);
  const sampled = count(get(USAGE_SAMPLE)), elapsed = sum(get('process.elapsed_ms'));
  const row = { samples: sampled, measuredSeconds: elapsed / 1000 };
  if (!sampled) return row;
  row.sources = Object.fromEntries(SOURCES.map(s => [s, sourceReport(metrics, s, elapsed)]));
  const test = row.sources.playtest, testWire = sum(get('ws.playtest_wire_tx_bytes'));
  row.includesPlaytest = !!(test.opened || test.closed || test.participantHours || testWire || test.admissionFull || test.admissionLimited);
  const publicWire = sum(get('ws.wire_tx_bytes')) - testWire;
  const visibleMs = sum(get('client.reported.visible_ms')), hiddenMs = sum(get('client.reported.hidden_ms'));
  row.service = {
    reportedTabHours: (visibleMs + hiddenMs) / 3600000, reportedVisibleFraction: ratio(visibleMs, visibleMs + hiddenMs),
    sampledPeakPeers: get('world.peers')?.max ?? null, meanWorldArea: get('world.area')?.mean ?? null,
    meanDensity: get('density.actual')?.mean ?? null, growth: sum(get('topology.growth')), shrink: sum(get('topology.shrink')),
    averageCores: ratio(sum(get('process.cpu_ms')), elapsed), meanRssBytes: get('process.rss_bytes')?.mean ?? null,
    readyMs: distribution(get('delivery.ready_ms')), clientAckMs: distribution(get('client.reported.ack_ms')),
    admittedCandidates: distribution(get('overload.admitted_candidates')),
    refusedCandidates: distribution(get('overload.refused_candidates')),
    clientSubmitToDrawMs: distribution(get('client.reported.submit_to_draw_ms')),
    recipients: distribution(get('presence.recipients')), expirationLagMs: distribution(get('expiration.lag_ms')),
    publicWsBytes: publicWire, publicWsBytesPerParticipantHour: ratio(publicWire, row.sources.public_ws.participantHours),
    slowDisconnects: sum(get('ws.slow_disconnects')), collectorFailures: sum(get('metrics.failures')),
  };
  return row;
}

export function usageReport(rows, { period, since, before }) {
  const groups = new Map(), covered = new Set();
  for (const row of rows) {
    if (row.period !== period || row.bucket < since || row.bucket > before) continue;
    const key = JSON.stringify([row.bucket, row.revision]);
    if (!groups.has(key)) groups.set(key, { bucket: row.bucket, revision: row.revision, metrics: new Map() });
    groups.get(key).metrics.set(row.metric, row.value);
  }
  const result = [], totals = new Map();
  for (const { bucket, revision, metrics } of groups.values()) {
    const row = { utc: new Date(bucket).toISOString(), revision, ...describe(metrics) };
    result.push(row);
    if (!row.sources) continue;
    covered.add(bucket);
    const key = JSON.stringify([revision, row.includesPlaytest]);
    if (!totals.has(key)) totals.set(key, { revision, buckets: 0, metrics: new Map() });
    const total = totals.get(key);
    total.buckets++;
    for (const [name, value] of metrics) {
      if (!total.metrics.has(name)) total.metrics.set(name, empty());
      merge(total.metrics.get(name), value);
    }
  }
  result.sort((a, b) => a.utc.localeCompare(b.utc) || a.revision.localeCompare(b.revision));
  const step = period * 1000, expected = Math.floor(before / step) - Math.ceil(since / step) + 1;
  return { period, since: new Date(since).toISOString(), before: new Date(before).toISOString(),
    expectedBuckets: expected, coveredBuckets: covered.size,
    totals: [...totals.values()].map(({ revision, buckets, metrics }) => ({ revision, buckets,
      ...describe(new Map([...metrics].map(([key, h]) => [key, summary(h)]))) })), buckets: result };
}

const format = (n, places = 0) => n == null ? '—' : n.toFixed(places);
const percent = n => n == null ? '—' : (n * 100).toFixed(0) + '%';
function printReport(report) {
  console.log('UTC ' + report.since + ' ~ ' + report.before + ' | ' + report.period + '초 구간 중 계측 ' +
    report.coveredBuckets + '/' + report.expectedBuckets + '개. —는 표본 없음. 지연은 p95 상한(ms).');
  const lines = [];
  for (const row of [...report.totals, ...report.buckets]) {
    if (!row.sources) continue;
    for (const [source, s] of Object.entries(row.sources)) {
      if (source !== 'public_ws' && !(s.opened || s.closed || s.participantHours || s.admissionFull || s.admissionLimited)) continue;
      const rejected = Object.values(s.actions).reduce((n, a) => n + a.busy + a.limited, 0);
      lines.push({ 'UTC 시작': row.utc?.slice(0, 16) ?? ('합계 ' + row.buckets + '구간'), '배포': row.revision.slice(0, 7), '채널': source,
        '측정초': format(row.measuredSeconds), '시험혼재': row.includesPlaytest ? '예' : '',
        '평균동접': format(s.averageConcurrent, 2), '종료': s.closed, '첫글률': percent(s.firstWriteFraction),
        '관찰/이동/편집': MODES.map(mode => percent(s.timeFraction[mode])).join('/'),
        '타인보임': percent(s.sharedViewFraction), '쓰기/이동/삭제': [s.actions.write, s.actions.move, s.actions.erase].map(a => a.accepted).join('/'),
        '행동429': rejected, '서버준비': format(row.service.readyMs.p95Upper),
        'CPU코어': format(row.service.averageCores, 3) });
    }
  }
  if (lines.length) console.table(lines);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { period: { type: 'string', default: '3600' }, hours: { type: 'string' },
    until: { type: 'string' }, file: { type: 'string' }, base: { type: 'string' }, json: { type: 'boolean' } } });
  const period = Number(values.period), hours = Number(values.hours ?? (period === 60 ? 1 : period === 86400 ? 720 : 24));
  if (![60, 3600, 86400].includes(period) || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 90)
    throw Error('period는 60, 3600, 86400 중 하나이며 hours는 0 초과 2160 이하여야 합니다.');
  const file = values.file ? JSON.parse(await readFile(values.file, 'utf8')) : null;
  const before = values.until ? Date.parse(values.until) : Date.parse(file?.exportedAt ?? new Date().toISOString());
  if (!Number.isFinite(before)) throw Error('until은 ISO 시각이어야 합니다.');
  const since = (Math.floor(before / (1000 * period)) + 1 - Math.ceil(hours * 3600 / period)) * period * 1000;
  const data = file ?? await readMetrics({ base: values.base, period, since, before });
  if (data.enabled === false) throw Error('서버 계측 저장소가 비활성 상태입니다.');
  const report = usageReport(data.rows, { period, since, before });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}
