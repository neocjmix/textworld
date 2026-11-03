// Synthetic *engine* load, not public participant traffic or a capacity promise.
// Real SQLite, geometry, wide glyphs, expiry and fake wall-clock time.
import { World } from '../server/world.js';
import { inkArea } from '../server/density.js';
import { expire } from '../server/expiration.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function densityExperiment({ WorldClass = World, writers = 1, rate = 10, seconds = 480, stopAt = Infinity, legacy = false } = {}) {
  let now = 0, random = 42;
  const next = size => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return Math.floor(random / 4294967296 * size); };
  const world = new WorldClass({ width: 32, height: 16, now: () => now });
  const peers = Array.from({ length: writers }, () => ({ x: 0, y: 0 }));
  const samples = [], elapsed = [];
  try {
    for (let t = 1; t <= seconds; t++) {
      now = t * 1000;
      if (t <= stopAt) for (let i = 0; i < writers; i++) {
        // Seeded scattered paragraphs include repeated overwrites at high load.
        const peer = peers[i]; peer.x = next(world.width); peer.y = next(world.height);
        world.applyWrite({ author: 'writer' + i, id: t + '-' + i, epoch: world.epoch,
          ...peer, text: '한'.repeat(rate) });
      }
      if (t % 5 === 0) expire(world);
      const started = performance.now();
      const change = !legacy || t % 10 === 0 ? world.adapt(t <= stopAt ? peers : [], { seed: t }) : {};
      elapsed.push(performance.now() - started);
      const occupied = world.ink ?? [...world.cells.values()].reduce((sum, cell) => sum + inkArea(cell), 0);
      samples.push({ t, area: world.width * world.height, width: world.width, height: world.height,
        occupied, density: occupied / (world.width * world.height), changed: !!change.changed,
        lost: change.lostTextCells || 0, broken: change.brokenAdjacencies || 0 });
    }
    const steady = samples.filter(s => s.t > seconds - 120), sorted = elapsed.sort((a,b) => a-b);
    return { summary: { writers, rate, seconds, stopAt: Number.isFinite(stopAt) ? stopAt : null, legacy,
      peakDensity: Math.max(...samples.map(s => s.density)), secondsAboveBand: samples.filter(s => s.density > .125).length,
      final: samples.at(-1), steadyDensityMin: Math.min(...steady.map(s => s.density)), steadyDensityMax: Math.max(...steady.map(s => s.density)),
      steadyResizes: steady.filter(s => s.changed).length, resizes: samples.filter(s => s.changed).length,
      lostCells: samples.reduce((n,s) => n+s.lost,0), brokenAdjacencies: samples.reduce((n,s) => n+s.broken,0),
      adaptP95Ms: sorted[Math.floor(sorted.length*.95)], adaptMaxMs: sorted.at(-1) }, samples };
  } finally { world.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const legacy = process.argv.includes('--baseline');
  // To compare the previous revision: git show cb35fa2:server/world.js >
  // artifacts/baseline-world.mjs, changing only './topology.js' to '../server/topology.js'.
  const WorldClass = legacy ? (await import('../artifacts/baseline-world.mjs')).World : World;
  const cases = process.argv.includes('--quick') ? [{ writers: 1, rate: 10 }] : [
    { writers: 1, rate: 10 }, { writers: 10, rate: 5 }, { writers: 2, rate: 10, seconds: 600, stopAt: 240 }];
  const results = [];
  for (const scenario of cases) { const result = densityExperiment({ ...scenario, legacy, WorldClass }); results.push(result); console.log(JSON.stringify(result.summary)); }
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(`artifacts/density-${legacy ? 'before' : 'after'}.json`, JSON.stringify(results));
}
