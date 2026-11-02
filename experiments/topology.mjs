// Reproducible counterexamples, not a benchmark of production resize code.
import assert from 'node:assert/strict';

const mod = (n, d) => ((n % d) + d) % d;
const oldWidth = 32;
const runs = [Array.from({ length: 8 }, (_, i) => mod(28 + i, oldWidth)),
  Array.from({ length: 8 }, (_, i) => 4 + i)];
const glyphs = runs.flat();
assert.equal(new Set(glyphs).size, glyphs.length);

function measure(name, width, project) {
  const mapped = glyphs.map(project);
  const brokenPairs = runs.reduce((sum, run) => sum + run.slice(1).filter((x, i) =>
    mod(project(x) - project(run[i]), width) !== 1).length, 0);
  return { name, width, glyphs: glyphs.length,
    collisions: glyphs.length - new Set(mapped).size,
    brokenConsecutivePairs: brokenPairs,
    movedAddresses: glyphs.filter((x) => project(x) !== x).length };
}

const resize = [
  measure('integer modulus: grow', 40, (x) => mod(x, 40)),
  measure('normalized remap: grow', 40, (x) => Math.floor(x * 40 / 32)),
  measure('insert empty strip [12,20): grow', 40, (x) => x >= 12 ? x + 8 : x),
  measure('integer modulus: shrink', 24, (x) => mod(x, 24)),
  measure('normalized remap: shrink', 24, (x) => Math.floor(x * 24 / 32)),
  measure('remove empty strip [12,20): shrink', 24, (x) => x >= 20 ? x - 8 : x),
];
assert.equal(resize[0].brokenConsecutivePairs, 1);
assert.equal(resize[3].collisions, 4);
assert.equal(resize[5].collisions, 0);
assert.equal(resize[5].brokenConsecutivePairs, 0);

const normalizedGps = (lon, width) => Math.floor(mod(lon + 180, 360) / 360 * width);
const sampleLongitudes = [-179, -120, -60, 0, 60, 120, 179];
const gps = sampleLongitudes.map((longitude) => ({ longitude,
  before: normalizedGps(longitude, 32),
  afterGrowth: normalizedGps(longitude, 40),
  stableAtlas: normalizedGps(longitude, 24) }));
assert.equal(gps.filter((p) => p.before !== p.afterGrowth).length, 6);
assert.equal(normalizedGps(-180, 32), normalizedGps(180, 32));

// Equal-area vs equirectangular latitude bands: derivative describes cell area.
const latitude = [0, 30, 60, 80].map((degrees) => ({ degrees,
  equirectangularRelativeCellArea: Number(Math.cos(degrees * Math.PI / 180).toFixed(3)),
  equalAreaRelativeCellArea: 1 }));

console.log(JSON.stringify({ fixture: 'Two 8-cell horizontal runs, one crosses seam; empty columns 12..19',
  resize, gps, latitude }, null, 2));
