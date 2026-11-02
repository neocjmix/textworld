/** Relative last-change age; no wall-clock timestamps leave the server. */
export const FRESHNESS = Object.freeze([
  { name: 'now', until: 15000, ink: '#214c35', background: '#f3cf77', underline: '#9b6515' },
  { name: 'recent', until: 60000, ink: '#284735', background: '#f2e1aa', underline: '#b89b50' },
  { name: 'minutes', until: 300000, ink: '#314137', background: '#f0eed9', underline: '#c8c6a3' },
  { name: 'earlier', until: 3600000, ink: '#314137' },
  { name: 'old', until: Infinity, ink: '#59665c' },
]);
export function freshness(updatedAt, now) {
  if (!Number.isFinite(updatedAt)) return 'old';
  const age = Math.max(0, now - updatedAt);
  return FRESHNESS.find(band => age < band.until).name;
}
export function freshnessStyle(name) { return FRESHNESS.find(band => band.name === name) || FRESHNESS.at(-1); }
