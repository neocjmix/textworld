/** Relative last-change age; no wall-clock timestamps leave the server. */
export const FRESHNESS = Object.freeze([
  { name: 'now', until: 15000, opacity: 1 },
  { name: 'recent', until: 60000, opacity: .82 },
  { name: 'minutes', until: 300000, opacity: .62 },
  { name: 'earlier', until: 3600000, opacity: .42 },
  { name: 'old', until: Infinity, opacity: .25 },
]);
export const EXPIRY_AGE_MS = 3600000;
export function freshness(updatedAt, now) {
  if (!Number.isFinite(updatedAt)) return 'old';
  const age = Math.max(0, now - updatedAt);
  return FRESHNESS.find(band => age < band.until).name;
}
export function freshnessStyle(name) { return FRESHNESS.find(band => band.name === name) || FRESHNESS.at(-1); }
