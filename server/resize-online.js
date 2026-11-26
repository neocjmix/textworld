import { randomInt } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { cellKey, occupiedCell, wrap } from '../shared/world.js';
import { inkArea } from './density.js';
import { ResizeStaging, releaseRetired } from './resize-staging.js';

// Automatic density changes move one contiguous band per row or column.
// Direct administrative/test resize() still supports arbitrary scattered cuts.
function bandGeometry(from, to, seams) {
  const across = seams.axis === 'width';
  const oldSize = from[seams.axis], newSize = to[seams.axis], delta = newSize - oldSize;
  const locate = (x,y,i) => across ? { x:i, y } : { x, y:i };
  const cutAt = (x,y) => seams.values[across ? y : x];
  function point(x,y) {
    const p = across ? x : y, cut = cutAt(x,y);
    if (delta < 0 && p >= cut && p < cut - delta) return null;
    return locate(x,y,p < cut ? p : p + delta);
  }
  function inverse(x,y) {
    const p = across ? x : y, cut = cutAt(x,y);
    if (delta > 0 && p >= cut && p < cut + delta) return null;
    return locate(x,y,p < cut ? p : p - delta);
  }
  function cursor({x,y}) {
    x = wrap(x,from.width); y = wrap(y,from.height);
    return point(x,y) ?? locate(x,y,wrap(cutAt(x,y),newSize));
  }
  // A single band per line changes its translation only once. The interval
  // must lie entirely on the same surviving side on every intersecting line.
  function translates(bounds, dx, dy) {
    const shift = across ? dx : dy;
    if ((across ? dy : dx) !== 0 || (shift !== 0 && shift !== delta)) return false;
    const first = across ? bounds.x : bounds.y;
    const end = first + (across ? bounds.cols : bounds.rows);
    const startLine = across ? bounds.y : bounds.x;
    const endLine = startLine + (across ? bounds.rows : bounds.cols);
    for (let line = startLine; line < endLine; line++) {
      const cut = seams.values[line];
      if (shift === 0 ? end > cut : first < cut + Math.max(0, -delta)) return false;
    }
    return true;
  }
  return { point, inverse, cursor, translates };
}

// Mirror the remesher's CJK head reservation, then tail placement in x order.
// A row is rebuilt from current authoritative cells after *every* intervening
// commit touching its input, including a tail whose head crosses a column seam.
function mapRow(world, geometry, width, y) {
  const slots = Array(width), wide = [];
  for (let x = 0; x < width; x++) {
    const source = geometry.inverse(x,y);
    if (!source) continue;
    const cell = world.getCell(source.x,source.y);
    if (!occupiedCell(cell) || cell.width === 0) continue;
    if (cell.width === 2) {
      const tail = world.getCell(source.x+1,source.y);
      if (tail?.width !== 0 || tail.leadX !== source.x || tail.version !== cell.version || !geometry.point(tail.x,tail.y)) continue;
      wide.push({ x, tail });
    }
    slots[x] = { ...cell, x, y };
  }
  for (const { x, tail } of wide) {
    const tx = wrap(x+1,width);
    if (slots[tx]) slots[x] = undefined;
    else slots[tx] = { ...tail, x:tx, y, leadX:x };
  }
  return slots.filter(Boolean);
}

function rowSummary(world, geometry, cells, to, y) {
  const mapped = cell => {
    if (!cell) return null;
    let location;
    if (cell.width === 0) {
      const head = geometry.point(cell.leadX,cell.y);
      if (head) location = { x:wrap(head.x+1,to.width), y:head.y };
    } else location = geometry.point(cell.x,cell.y);
    const result = location && cells.get(cellKey(location.x,location.y));
    return result?.version === cell.version && result.width === cell.width && result.text === cell.text ? result : null;
  };
  let occupied = 0, broken = 0, mismatches = 0;
  for (let x = 0; x < world.width; x++) {
    const cell = world.getCell(x,y);
    if (!occupiedCell(cell)) continue;
    occupied++;
    // Whitespace contributes neither ink nor protected adjacencies.
    if (!inkArea(cell) && !(cell.width === 0 && inkArea(world.getCell(cell.leadX,y)))) continue;
    const location = mapped(cell);
    if (!location) { mismatches++; continue; }
    for (const [dx,dy] of [[1,0],[0,1]]) {
      const other = world.getCell(x+dx,y+dy);
      if (!inkArea(other) && !(other?.width === 0 && inkArea(world.getCell(other.leadX,other.y)))) continue;
      const neighbour = mapped(other);
      if (!neighbour || neighbour.x !== wrap(location.x+dx,to.width) || neighbour.y !== wrap(location.y+dy,to.height)) broken++;
    }
  }
  return { occupied, broken, mismatches };
}

async function choose(world, job, seed, control, from) {
  const worker = new Worker(new URL('./resize-worker.js',import.meta.url), { workerData:{ from, seed, control } });
  job.worker = worker;
  // Clone small messages so V8 never serializes a large world in one turn.
  // Commits replace immutable cell records; this array is a point-in-time view.
  const snapshot = Array.from(world.cells.values());
  const result = new Promise((resolve,reject) => {
    worker.once('message',resolve);
    worker.once('error',reject);
    worker.once('exit', code => { if (job.cancelled) resolve(null); else if (code) reject(new Error(`Resize worker exited (${code})`)); });
  });
  result.catch(() => {}); // Copying below can still be yielding when the worker fails.
  try {
    for (let i = 0; i < snapshot.length && !job.cancelled; i += 512) {
      worker.postMessage(snapshot.slice(i,i+512));
      await yieldTurn();
    }
    if (!job.cancelled) worker.postMessage(null);
    return await result;
  } finally {
    await worker.terminate();
    job.worker = null;
  }
}

function rowNumbers(size) { return new Set(Array.from({length:size},(_,i) => i)); }
export function adaptOnline(world, getPeers, { cooldown, seed = randomInt(0,2**32), record = () => {} } = {}) {
  if (world.resizeJob) return world.resizeJob.done;
  const control = world.densityController.decide({ now:world.now(), occupied:world.ink, width:world.width, height:world.height, lastResize:world.lastResize, cooldown });
  if (control.reason !== 'due') return Promise.resolve(control);
  const from = { width:world.width, height:world.height }, epoch = world.epoch;
  const job = { cancelled:false, capture() {}, worker:null };
  world.resizeJob = job;
  job.done = (async () => {
    let staging;
    try {
      // A post-commit error may have interrupted retirement on the last tick.
      await releaseRetired(world.db,job,yieldTurn);
      if (job.cancelled) return { ...control, reason:'superseded' };
      const selected = await choose(world,job,seed,control,from);
      if (job.cancelled || world.epoch !== epoch) return { ...control, reason:'superseded' };
      if (!selected) return { ...control, reason:'limit' };
      const { to, seams } = selected, geometry = bandGeometry(from,to,seams);
      const rows = Array(to.height), cells = new Map(), summaries = Array(from.height);
      const dirty = rowNumbers(to.height), unchecked = rowNumbers(from.height);
      let ink = 0;
      function checkRow(y) {
        unchecked.add(y);
        unchecked.add(wrap(y-1,from.height));
      }
      job.capture = changes => {
        for (const cell of changes) {
          checkRow(cell.y);
          for (const dx of [-1,0,1]) {
            const location = geometry.point(wrap(cell.x+dx,from.width),cell.y);
            if (location) dirty.add(location.y);
          }
        }
      };
      staging = new ResizeStaging(world.db);
      while (dirty.size || unchecked.size) {
        if (job.cancelled || world.epoch !== epoch) return { ...control, reason:'superseded' };
        const started = performance.now();
        if (dirty.size) {
          world.db.exec('BEGIN IMMEDIATE');
          try {
            for (const y of dirty) {
              dirty.delete(y);
              for (const old of rows[y] ?? []) {
                staging.remove.run(old.x,y);
                cells.delete(cellKey(old.x,y));
                ink -= inkArea(old);
              }
              rows[y] = mapRow(world,geometry,to.width,y);
              for (const cell of rows[y]) {
                staging.put(cell);
                cells.set(cellKey(cell.x,y),cell);
                ink += inkArea(cell);
              }
              // A CJK collision can also affect the old row of a mapped
              // neighbour. One coherent band has at most two source rows.
              if (seams.axis === 'width') checkRow(y);
              else {
                if (y < from.height) checkRow(y);
                const other = y - (to.height-from.height);
                if (other >= 0 && other < from.height) checkRow(other);
              }
              if (performance.now()-started >= 4) break;
            }
            world.db.exec('COMMIT');
          } catch (error) { world.db.exec('ROLLBACK'); throw error; }
        } else {
          for (const y of unchecked) {
            unchecked.delete(y);
            summaries[y] = rowSummary(world,geometry,cells,to,y);
            if (performance.now()-started >= 4) break;
          }
        }
        record('topology.slice_ms',performance.now()-started);
        if (dirty.size || unchecked.size) await yieldTurn();
      }
      // New activity or expiry can reverse the requested direction while the
      // worker is planning. Never apply a now-obsolete shrink/growth step.
      const current = world.densityController.decide({ now:world.now(), occupied:world.ink,
        width:world.width, height:world.height, lastResize:world.lastResize, cooldown });
      if (current.reason !== 'due' || current.mode !== control.mode) return { ...current, reason:'superseded' };
      // No yield between catching up to current writes and the atomic swap.
      const occupied = summaries.reduce((n,row) => n+row.occupied,0);
      const broken = summaries.reduce((n,row) => n+row.broken,0);
      const lost = world.ink - ink;
      const cuts = seams.values.length * (to[seams.axis] < from[seams.axis] ? from[seams.axis]-to[seams.axis] : 1);
      const prepared = { ...geometry, cells, ink, install:() => staging.install(), summary:{
        seed:selected.seed, strategy:seams.strategy, lostTextCells:Math.max(0,lost), brokenAdjacencies:broken,
        horizontalSeams:seams.axis === 'width' ? cuts : 0, verticalSeams:seams.axis === 'height' ? cuts : 0,
        survivingCells:cells.size, destroyedCells:occupied-cells.size } };
      const result = world.resize(to.width,to.height,getPeers(),{ ...selected, prepared });
      job.capture = () => {};
      await releaseRetired(world.db,job,yieldTurn);
      return { ...control, ...result, preservation:!broken && summaries.every(row => !row.mismatches) ? 'text' : 'forced' };
    } finally {
      job.capture = () => {};
      try { await staging?.discard(job,yieldTurn); }
      finally { world.resizeJob = null; }
    }
  })();
  return job.done;
}
export async function stopResize(world) {
  const job = world.resizeJob;
  if (!job) return;
  job.cancelled = true;
  await job.worker?.terminate();
  await job.done;
}
