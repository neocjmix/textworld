import { ACTIONS, MODES, ROLES, SOURCES, USAGE_SAMPLE } from './usage-patterns.js';

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

export function describeUsage(metrics) {
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
