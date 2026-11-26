// USD for 30 days at 1,000 concurrent users. Rounded from the separately
// observed 45 s distributed run and 192 s plaza run (including churn).
// See docs/measurements/week-1000-2026-11-26.json.
const reference = Object.freeze({
  distributedLive: 519.62,
  plazaLive: 1136.72,
  distributedServer: 18.92,
  plazaServer: 29.78,
  plazaSize: 250,
});
const monthHours = 30 * 24;
const sessionMinutes = 20;
const gibibyte = 1024 ** 3;
const egressPerGiB = 0.05;

// Effective paid bytes include cached assets that still incur delivery charges.
const paidAssetBytesPerVisit = (48 + 0.20 * 384) * 1024;
const idleServerUsd = 1.20;
const variableComputeShare = 0.5;
const orderedPairs = people => people * Math.max(0, people - 1);

function requireRange(name, value, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(name + ' is outside the modeled range');
  }
}

// Extra local deliveries depend on who shares whose view. A 251st visitor in
// the neighborhoods scenario starts a new plaza and sees no one there yet.
function plazaPairIndex(people, layout) {
  const { plazaSize } = reference;
  const baseline = orderedPairs(plazaSize);
  if (layout === 'single') return orderedPairs(people) / baseline;
  const plazas = Math.floor(people / plazaSize);
  return plazas + orderedPairs(people - plazas * plazaSize) / baseline;
}

export function monthlyCost({
  concurrent, layout = 'neighborhoods', reduction = 8, peerDelivery = true,
  plazaShare = 0.25, plazaHours = 6,
}) {
  requireRange('concurrent', concurrent, 0, Number.MAX_SAFE_INTEGER);
  requireRange('reduction', reduction, 1, Number.MAX_SAFE_INTEGER);
  requireRange('plazaShare', plazaShare, 0, 1);
  requireRange('plazaHours', plazaHours, 0, 24);
  if (!['neighborhoods', 'single'].includes(layout) || typeof peerDelivery !== 'boolean') {
    throw new TypeError('Unknown delivery or plaza scenario');
  }
  const scale = concurrent / 1000;
  const plazaExposure = plazaHours / 24 * plazaPairIndex(concurrent * plazaShare, layout);
  // Remaining spend at an equivalent egress price, including paid seeds,
  // relay and repairs. These are scenario assumptions, not ICE success rates.
  const distributedPaidShare = peerDelivery ? 0.65 : 1;
  const plazaExtraPaidShare = peerDelivery ? 0.35 : 1;
  const extraLive = reference.plazaLive - reference.distributedLive;
  const live = (reference.distributedLive * scale * distributedPaidShare
    + extraLive * plazaExposure * plazaExtraPaidShare) / reduction;
  const userHours = monthHours * concurrent;
  const visits = userHours * 60 / sessionMinutes;
  const assets = visits * paidAssetBytesPerVisit / gibibyte * egressPerGiB;
  const extraServer = reference.plazaServer - reference.distributedServer;
  const server = idleServerUsd + variableComputeShare * (
    (reference.distributedServer - idleServerUsd) * scale + extraServer * plazaExposure);
  const total = server + assets + live;
  return {
    total, server, assets, live, userHours, visits,
    perThousandHours: userHours ? total * 1000 / userHours : null,
    perThousandVisits: visits ? total * 1000 / visits : null,
  };
}

// Observed release inputs. Source: docs/measurements/initial-release-2026-11-26.
export const releaseProfile = Object.freeze({
  "concurrent": 300,
  "hour": {
    "bytesPerSecond": 552489.677,
    "cores": 0.1156264,
    "rssGiB": 0.4155079
  },
  "spread": {
    "bytesPerSecond": 457268.188,
    "cores": 0.1261353,
    "rssGiB": 0.3585399
  },
  "plaza": {
    "bytesPerSecond": 2512764.11,
    "cores": 0.2240979,
    "rssGiB": 0.6189078
  },
  "mapBytes": 123350,
  "fontBytes": 5315944,
  "volumeGiB": 0.0332113
});

// Resource measurements are available at 300 concurrent participants. The
// historical model above estimates other population sizes with its own assumptions.
export function releaseCost({
  scenario = 'steady', plazaHours = 6, sessionMinutes = 20, coldFontShare = 0.2,
} = {}) {
  requireRange('plazaHours', plazaHours, 0, 24);
  requireRange('sessionMinutes', sessionMinutes, 1, 1440);
  requireRange('coldFontShare', coldFontShare, 0, 1);
  if (!['steady', 'mix'].includes(scenario)) throw new TypeError('Unknown release scenario');

  const plazaFraction = plazaHours / 24;
  const { hour, spread, plaza, concurrent, volumeGiB, mapBytes, fontBytes } = releaseProfile;
  function average(metric) {
    if (scenario === 'steady') return hour[metric];
    return spread[metric] * (1 - plazaFraction) + plaza[metric] * plazaFraction;
  }

  const minutes = monthHours * 60;
  // Railway's resource API reports the 8,000,000,000-byte limit as 8 GB.
  const gigabyte = 1e9;
  const live = average('bytesPerSecond') * minutes * 60 / gigabyte * 0.05;
  const cpu = average('cores') * minutes * 0.000463;
  const memory = average('rssGiB') * gibibyte / gigabyte * minutes * 0.000231;
  const server = cpu + memory + volumeGiB * gibibyte / gigabyte * minutes * 0.000003472222222;
  const visits = concurrent * minutes / sessionMinutes;
  const assets = visits * (mapBytes + coldFontShare * fontBytes) / gigabyte * 0.05;
  const total = live + server + assets;
  return {
    total, live, server, assets, cpu, memory, visits,
    week: total * 7 / 30,
    unit: total * 1000 / (monthHours * concurrent),
  };
}
