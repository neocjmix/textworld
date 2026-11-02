import { cellKey, occupiedCell, wrap } from '../shared/world.js';

// Seeded so one small event record can reproduce a plan; never store per-cell maps.
function generator(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function axis(oldSize, newSize, costs, random) {
  const delta = newSize - oldSize, mapping = new Int32Array(oldSize);
  if (!delta) { for (let i = 0; i < oldSize; i++) mapping[i] = i; return { mapping, seams: 0 }; }
  const count = Math.abs(delta), bands = Math.min(16, count, oldSize);
  const phase = Math.floor(random() * oldSize), remainderStart = Math.floor(random() * bands);
  const edits = new Uint16Array(oldSize);
  for (let band = 0; band < bands; band++) {
    const candidates = [];
    for (let n = Math.floor(band * oldSize / bands); n < Math.floor((band + 1) * oldSize / bands); n++) {
      const index = wrap(n + phase, oldSize);
      candidates.push({ index, score: costs(index, delta > 0), tie: random() });
    }
    candidates.sort((a, b) => a.score - b.score || a.tie - b.tie);
    const quota = Math.floor(count / bands) + Number(wrap(band - remainderStart, bands) < count % bands);
    const best = candidates.filter(c => c.score === candidates[0].score);
    for (let n = 0; n < quota; n++) {
      if (delta < 0) edits[candidates[n].index] = 1;
      else {
        // Within each stratum prefer blank gaps; replacement permits varied
        // spacing even when doubling (one slot at every gap would form a grid).
        edits[best[Math.floor(random() * best.length)].index]++;
      }
    }
  }
  let offset = 0, seams = 0;
  for (let i = 0; i < oldSize; i++) {
    if (edits[i]) seams++;
    if (delta > 0) { offset += edits[i]; mapping[i] = i + offset; }
    else if (edits[i]) { mapping[i] = -1; offset++; }
    else mapping[i] = i - offset;
  }
  return { mapping, seams };
}
function survivor(mapping, index) {
  for (let n = 0; n < mapping.length; n++) {
    const value = mapping[wrap(index + n, mapping.length)];
    if (value !== -1) return value;
  }
  throw new Error('Topology must retain at least one cell.');
}
export function remesh(cells, from, to, seed) {
  const random = generator(seed), occupied = new Uint8Array(from.width * from.height);
  for (const c of cells.values()) if (c.width === 0 || c.text?.trim()) occupied[c.y * from.width + c.x] = 1;
  const horizontal = [], vertical = [], intermediate = new Uint8Array(to.width * from.height);
  let horizontalSeams = 0, verticalSeams = 0;
  for (let y = 0; y < from.height; y++) {
    const result = axis(from.width, to.width, (x, inserting) => occupied[y * from.width + x]
      + (inserting ? occupied[y * from.width + wrap(x - 1, from.width)] : 0), random);
    horizontal.push(result.mapping); horizontalSeams += result.seams;
    for (let x = 0; x < from.width; x++) if (result.mapping[x] !== -1) intermediate[y * to.width + result.mapping[x]] = occupied[y * from.width + x];
  }
  for (let x = 0; x < to.width; x++) {
    const result = axis(from.height, to.height, (y, inserting) => intermediate[y * to.width + x]
      + (inserting ? intermediate[wrap(y - 1, from.height) * to.width + x] : 0), random);
    vertical.push(result.mapping); verticalSeams += result.seams;
  }
  const point = (x, y) => {
    const nx = horizontal[y][x];
    if (nx === -1) return null;
    const ny = vertical[nx][y];
    return ny === -1 ? null : { x: nx, y: ny };
  };
  const cursor = ({ x, y }) => {
    x = survivor(horizontal[wrap(y, from.height)], wrap(x, from.width));
    y = survivor(vertical[x], wrap(y, from.height));
    return { x, y };
  };
  const result = new Map(), wide = [], reserved = new Set();
  let before = 0;
  for (const cell of cells.values()) {
    if (!occupiedCell(cell)) continue;
    before++;
    if (cell.width === 0) continue;
    const location = point(cell.x, cell.y);
    if (!location) continue;
    if (cell.width === 2) {
      const oldTail = cells.get(cellKey(wrap(cell.x + 1, from.width), cell.y));
      if (oldTail?.width !== 0 || oldTail.leadX !== cell.x || oldTail.version !== cell.version
        || !point(oldTail.x, oldTail.y)) continue;
      wide.push({ cell, oldTail, location });
    } else result.set(cellKey(location.x, location.y), { ...cell, ...location });
    reserved.add(cellKey(location.x, location.y));
  }
  for (const { cell, oldTail, location } of wide) {
    const tail = { x: wrap(location.x + 1, to.width), y: location.y };
    if (reserved.has(cellKey(tail.x, tail.y))) {reserved.delete(cellKey(location.x, location.y));continue;}
    result.set(cellKey(location.x, location.y), { ...cell, ...location });
    result.set(cellKey(tail.x, tail.y), { ...oldTail, ...tail, leadX: location.x });
    reserved.add(cellKey(tail.x, tail.y));
  }
  return { cells: result, cursor, summary: { seed, strategy: 'scattered-strata-v1',
    horizontalSeams, verticalSeams, survivingCells: result.size, destroyedCells: before - result.size } };
}
