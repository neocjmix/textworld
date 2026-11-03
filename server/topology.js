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
function axis(oldSize, newSize, costs, random, seam) {
  const delta = newSize - oldSize, mapping = new Int32Array(oldSize);
  if (!delta) { for (let i = 0; i < oldSize; i++) mapping[i] = i; return { mapping, seams: 0 }; }
  const count = Math.abs(delta);
  const candidates = Array.from({length: oldSize}, (_, index) => ({ index, score: costs(index, delta > 0), tie: random() }));
  candidates.sort((a, b) => a.score - b.score || a.tie - b.tie);
  const edits = new Uint16Array(oldSize);
  if (seam !== undefined) {
    if (count !== 1 || seam < 0 || seam >= oldSize) throw new Error('Invalid planned seam');
    edits[seam] = 1;
  } else if (delta < 0) {
    for (let n = 0; n < count; n++) edits[candidates[n].index] = 1;
  } else {
    const best = candidates.filter(c => c.score === candidates[0].score);
    for (let n = 0; n < count; n++) edits[best[Math.floor(random() * best.length)].index]++;
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
export function remesh(cells, from, to, seed, { seams } = {}) {
  const random = generator(seed), occupied = new Uint8Array(from.width * from.height);
  for (const c of cells.values()) if (c.width === 0 || c.text?.trim()) occupied[c.y * from.width + c.x] = 1;
  const horizontal = [], vertical = [], intermediate = new Uint8Array(to.width * from.height);
  let horizontalSeams = 0, verticalSeams = 0;
  for (let y = 0; y < from.height; y++) {
    const result = axis(from.width, to.width, (x, inserting) => occupied[y * from.width + x]
      + (inserting ? occupied[y * from.width + wrap(x - 1, from.width)] : 0), random, seams?.axis === 'width' ? seams.values[y] : undefined);
    horizontal.push(result.mapping); horizontalSeams += result.seams;
    for (let x = 0; x < from.width; x++) if (result.mapping[x] !== -1) intermediate[y * to.width + result.mapping[x]] = occupied[y * from.width + x];
  }
  for (let x = 0; x < to.width; x++) {
    const result = axis(from.height, to.height, (y, inserting) => intermediate[y * to.width + x]
      + (inserting ? intermediate[wrap(y - 1, from.height) * to.width + x] : 0), random, seams?.axis === 'height' ? seams.values[x] : undefined);
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
  // Test actual remapping, including row/column shear, rather than assuming a
  // blank-looking insertion or deletion keeps neighbouring text together.
  const actualLocation = cell => {
    let location = point(cell.x, cell.y);
    if (cell.width === 0) {
      const head = cells.get(cellKey(cell.leadX, cell.y));
      const headLocation = head && point(head.x, head.y);
      if (headLocation) location = { x: wrap(headLocation.x + 1, to.width), y: headLocation.y };
    }
    const mapped = location && result.get(cellKey(location.x, location.y));
    return mapped && mapped.version === cell.version && mapped.text === cell.text && mapped.width === cell.width ? location : null;
  };
  let mappingMismatches = 0, brokenAdjacencies = 0;
  for (const cell of cells.values()) {
    if (!occupied[cell.y * from.width + cell.x]) continue;
    const location = actualLocation(cell);
    if (!location) { mappingMismatches++; continue; }
    for (const [dx, dy] of [[1,0],[0,1]]) {
      const x = wrap(cell.x + dx, from.width), y = wrap(cell.y + dy, from.height);
      if (!occupied[y * from.width + x]) continue;
      const neighbour = actualLocation(cells.get(cellKey(x, y)));
      if (!neighbour || neighbour.x !== wrap(location.x + dx, to.width) || neighbour.y !== wrap(location.y + dy, to.height)) brokenAdjacencies++;
    }
  }
  const afterTextCells = [...result.values()].filter(cell => cell.width === 0 || cell.text?.trim()).length;
  const beforeTextCells = occupied.reduce((total, bit) => total + bit, 0);
  const lostTextCells = Math.max(0, beforeTextCells - afterTextCells);
  const preservesText = mappingMismatches === 0 && brokenAdjacencies === 0;
  return { cells: result, cursor, preservesText, summary: { seed, strategy: seams ? 'coordinated-blank-v3' : 'scattered-blank-v2',
    horizontalSeams, verticalSeams, lostTextCells, brokenAdjacencies, survivingCells: result.size, destroyedCells: before - result.size } };
}

// Exact one-cell search over a cyclic sequence of rows (or columns). A seam
// can change between neighbouring lines only across positions where no text
// touches vertically; this preserves every occupied neighbour and wide glyph.
export function findBlankSeams(cells, world, direction, delta, seed) {
  const length = direction === 'width' ? world.width : world.height;
  const lines = direction === 'width' ? world.height : world.width;
  // Bounded synchronous work: larger worlds keep the existing random search.
  if (length > 48 || lines > 64) return { status: 'too-large' };
  const filled = Array.from({ length: lines }, () => new Uint8Array(length));
  for (const c of cells.values()) if (c.width === 0 || c.text?.trim()) {
    const line = direction === 'width' ? c.y : c.x, pos = direction === 'width' ? c.x : c.y;
    filled[line][pos] = 1;
  }
  const random = generator(seed), candidates = filled.map(row => {
    const values = [];
    for (let a = 0; a < length; a++) {
      const safe = delta > 0 ? !(row[a] && row[wrap(a - 1, length)]) : !row[a];
      if (safe) values.push({ a, priority: delta > 0 ? row[a] + row[wrap(a - 1, length)] : 0, tie: random() });
    }
    values.sort((a, b) => a.priority - b.priority || a.tie - b.tie);
    return values.map(v => v.a);
  });
  if (candidates.some(row => row.length === 0)) return { status: 'impossible' };
  const prefix = filled.map((row, i) => {
    const prev = filled[wrap(i - 1, lines)], sums = new Uint16Array(length + 1);
    for (let x = 0; x < length; x++) sums[x + 1] = sums[x] + (row[x] && prev[x] ? 1 : 0);
    return sums;
  });
  const compatible = (line, a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b), shift = delta > 0 ? 0 : 1;
    return prefix[line][hi + shift] === prefix[line][lo + shift];
  };
  for (const first of candidates[0]) {
    // Track whether the seam has varied: a single straight stripe is not a
    // valid scattered change, even if it would preserve all text.
    let prior = new Set([first]); const parents = [null];
    for (let line = 1; line < lines && prior.size; line++) {
      const next = new Set(), parent = new Int32Array(length * 2).fill(-1);
      for (const a of candidates[line]) for (const state of prior) {
        const b = state % length, varied = state >= length || a !== first;
        if (!compatible(line, a, b)) continue;
        const code = a + (varied ? length : 0);
        if (parent[code] === -1) { next.add(code); parent[code] = state; }
      }
      parents.push(parent); prior = next;
    }
    if (parents.length !== lines) continue;
    for (const last of prior) if (last >= length && compatible(0, first, last % length)) {
      const values = new Array(lines); let state = last;
      for (let line = lines - 1; line > 0; line--) { values[line] = state % length; state = parents[line][state]; }
      values[0] = first;
      return { status: 'found', axis: direction, values };
    }
  }
  return { status: 'impossible' };
}
