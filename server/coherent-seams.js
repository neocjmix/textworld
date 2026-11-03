import { wrap } from '../shared/world.js';
import { inkArea } from './density.js';

function randomSource(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** A seeded, cyclic low-damage band. Neighbouring lines choose their seams
 * together, so a paragraph translates as a unit instead of shearing each row.
 * Linear-time distance transforms bound each search to O(world area).
 * This is an optimizer, never a veto: even a full torus returns a plan. */
export function coherentSeams(cells, world, direction, delta, seed) {
  const length = world[direction], lines = direction === 'width' ? world.height : world.width;
  const count = Math.abs(delta), positions = delta > 0 ? length : length - count + 1;
  const filled = Array.from({ length: lines }, () => new Uint8Array(length));
  const tails = Array.from({ length: lines }, () => new Uint8Array(length));
  for (const cell of cells.values()) if (inkArea(cell)) {
    for (let k = 0; k < inkArea(cell); k++) {
      const x = wrap(cell.x + k, world.width), y = cell.y;
      filled[direction === 'width' ? y : x][direction === 'width' ? x : y] = 1;
      if (k && direction === 'width') tails[y][x] = 1;
    }
  }
  const random = randomSource(seed), startLine = Math.floor(random() * lines);
  const lossWeight = world.width * world.height * 4 + 1;
  const energies = [], transitions = [];
  for (let i = 0; i < lines; i++) {
    const row = filled[i], prev = filled[wrap(i - 1, lines)];
    const sums = new Uint32Array(length + 1), shared = new Uint32Array(length + 1);
    for (let p = 0; p < length; p++) { sums[p + 1] = sums[p] + row[p]; shared[p + 1] = shared[p] + (row[p] && prev[p] ? 1 : 0); }
    const energy = new Float64Array(positions), transition = new Float64Array(positions);
    for (let p = 0; p < positions; p++) {
      // Protect glyphs first, then adjacent text, then nearby whitespace.
      const lost = delta < 0 ? sums[p + count] - sums[p] : 0;
      energy[p] = lost * lossWeight + (delta > 0 && row[p] && row[wrap(p - 1, length)] ? 1 : 0)
        + (delta > 0 && tails[i][p] ? lossWeight : 0)
        + .01 * (row[wrap(p - 1, length)] + row[p] + row[wrap(p - 2, length)] + row[wrap(p + (delta < 0 ? count : 1), length)])
        + random() * .0001;
      transition[p] = shared[p + (delta < 0 ? count : 0)] + p * .001;
    }
    energies.push(energy); transitions.push(transition);
  }
  const first = energies[startLine];
  // Try different low-cost anchors on successive seeds; the closing edge is
  // scored too. No special role is assigned to coordinate zero.
  const minimum = Math.min(...first);
  const choices = Array.from({ length: positions }, (_, p) => p).filter(p => first[p] < minimum + .001);
  const anchor = choices[Math.floor(random() * choices.length)];
  let prior = new Float64Array(positions).fill(Infinity); prior[anchor] = first[anchor];
  const parents = [];
  for (let step = 1; step < lines; step++) {
    const line = (startLine + step) % lines, distance = transitions[line];
    const next = new Float64Array(positions), parent = new Int32Array(positions);
    let best = Infinity, source = -1;
    for (let p = 0; p < positions; p++) {
      if (prior[p] - distance[p] < best) { best = prior[p] - distance[p]; source = p; }
      next[p] = best + distance[p]; parent[p] = source;
    }
    best = Infinity; source = -1;
    for (let p = positions - 1; p >= 0; p--) {
      if (prior[p] + distance[p] < best) { best = prior[p] + distance[p]; source = p; }
      if (best - distance[p] < next[p]) { next[p] = best - distance[p]; parent[p] = source; }
      next[p] += energies[line][p];
    }
    parents.push(parent); prior = next;
  }
  let end = 0, best = Infinity;
  const closing = transitions[startLine];
  for (let p = 0; p < positions; p++) {
    const cost = prior[p] + Math.abs(closing[p] - closing[anchor]);
    if (cost < best) { best = cost; end = p; }
  }
  const values = new Array(lines);
  for (let step = lines - 1; step > 0; step--) {
    values[(startLine + step) % lines] = end; end = parents[step - 1][end];
  }
  values[startLine] = anchor;
  if (values.every(value => value === anchor)) {
    // A straight stripe is not a dispersed seam. Put its smallest possible
    // bend in the least damaging location, preferably entirely in whitespace.
    let bend;
    for (let line = 0; line < lines; line++) for (let p = 0; p < positions; p++) {
      if (p === anchor) continue;
      const next = (line + 1) % lines;
      const cost = energies[line][p] - energies[line][anchor]
        + Math.abs(transitions[line][p] - transitions[line][anchor])
        + Math.abs(transitions[next][p] - transitions[next][anchor]);
      if (!bend || cost < bend.cost) bend = { line, p, cost };
    }
    if (bend) values[bend.line] = bend.p;
  }
  return { axis: direction, values, strategy: 'coherent-band-v4' };
}
