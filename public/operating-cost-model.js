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
