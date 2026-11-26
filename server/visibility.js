import { freshness, FRESHNESS } from '../shared/freshness.js';
import { VIEW_LIMITS } from '../shared/participant-rules.js';
import { cellKey, occupiedCell, wrap } from '../shared/world.js';
import { inkArea } from './density.js';

function badView() {
  return Object.assign(new Error('시야는 허용된 열·행 수와 면적 안의 정수 크기여야 합니다.'), {
    code: 'BAD_VIEW', status: 400,
  });
}

export function validateView(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'cols' && key !== 'rows')) throw badView();
  const cols = value.cols === undefined ? VIEW_LIMITS.defaultCols : value.cols;
  const rows = value.rows === undefined ? VIEW_LIMITS.defaultRows : value.rows;
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1
    || cols > VIEW_LIMITS.maxCols || rows > VIEW_LIMITS.maxRows || cols * rows > VIEW_LIMITS.maxArea) throw badView();
  return { cols, rows };
}

/** A participant may resize its view, but its cursor chooses the location. */
export function viewRectangle(world, peer, value) {
  const view = validateView(value);
  const cols = Math.min(view.cols, world.width), rows = Math.min(view.rows, world.height);
  return { x: wrap(peer.x - Math.floor(cols / 2), world.width),
    y: wrap(peer.y - Math.floor(rows / 2), world.height), cols, rows };
}

export function contains(view, x, y, world) {
  return wrap(x - view.x, world.width) < view.cols && wrap(y - view.y, world.height) < view.rows;
}

const cellRecord = cell => ({
  x: cell.x, y: cell.y, text: cell.text, width: cell.width ?? 1,
  leadX: cell.leadX ?? null, version: cell.version,
});
const publicPeers = new WeakMap();
const peerRecord = peer => {
  const old = publicPeers.get(peer);
  if (old && old.x === peer.x && old.y === peer.y && old.name === peer.name && old.color === peer.color && old.id === peer.id) return old;
  const record = Object.freeze({ id: peer.id, name: peer.name, color: peer.color, x: peer.x, y: peer.y });
  publicPeers.set(peer, record);
  return record;
};

function glyphSpan(world, cell) {
  if (cell.width === 2) {
    const tail = world.getCell(wrap(cell.x + 1, world.width), cell.y);
    if (tail?.width === 0 && tail.leadX === cell.x && tail.version === cell.version) return [cell, tail];
  } else if (cell.width === 0) {
    const head = Number.isSafeInteger(cell.leadX) ? world.getCell(cell.leadX, cell.y) : null;
    if (head?.width === 2 && wrap(head.x + 1, world.width) === cell.x
      && head.y === cell.y && head.version === cell.version) return [head, cell];
    // A detached continuation cannot grant access to an unrelated distant head.
    return [];
  }
  return [cell];
}

function cellsInRectangle(world, rectangle, marks = []) {
  const now = world.now();
  const cells = new Map();
  // The loop is bounded by the accepted view, not by total world occupancy.
  // Clamp dimensions before iterating so a small torus never repeats addresses.
  for (let row = 0; row < rectangle.rows; row++) {
    const y = wrap(rectangle.y + row, world.height);
    for (let col = 0; col < rectangle.cols; col++) {
      const x = wrap(rectangle.x + col, world.width), cell = world.getCell(x, y);
      if (!occupiedCell(cell)) {
        if (cell && markVisible(freshness(cell.updatedAt, now)))
          marks.push({ x, y, version: cell.version });
        continue;
      }
      for (const member of glyphSpan(world, cell)) cells.set(cellKey(member.x, member.y), cellRecord(member));
    }
  }
  return cells;
}

export function visibleCells(world, peer, view = validateView()) {
  return [...cellsInRectangle(world, viewRectangle(world, peer, view)).values()];
}

function peersInRectangle(world, peer, rectangle, peers) {
  const visible = new Map([[peer.id, peerRecord(peer)]]);
  for (const other of peers) {
    if (other.id !== peer.id && contains(rectangle, other.x, other.y, world)) visible.set(other.id, peerRecord(other));
  }
  return [visible.get(peer.id), ...[...visible.values()].filter(other => other.id !== peer.id)
    .sort((a, b) => a.id.localeCompare(b.id))];
}

export function visiblePeers(world, peer, view, peers = []) {
  return peersInRectangle(world, peer, viewRectangle(world, peer, view), peers).map(other => ({ ...other }));
}

const sameCell = (a, b) => a && a.x === b.x && a.y === b.y && a.text === b.text
  && a.width === b.width && a.leadX === b.leadX && a.version === b.version;
const sameRectangle = (a, b) => a && a.x === b.x && a.y === b.y && a.cols === b.cols && a.rows === b.rows;
const samePeer = (a, b) => a && a.id === b.id && a.name === b.name && a.color === b.color
  && a.x === b.x && a.y === b.y;
const markVisible = band => band === 'now' || band === 'recent' || band === 'minutes';
const freshnessUntil = Object.fromEntries(FRESHNESS.map(band => [band.name, band.until]));
const keyOf = cell => cellKey(cell.x, cell.y);
const byAddress = records => new Map(records.map(record => [keyOf(record), { ...record }]));
const byId = peers => new Map(peers.map(peer => [peer.id, { ...peer }]));

function visibleInk(cell, rectangle, world) {
  let count = 0;
  for (let k = 0; k < inkArea(cell); k++) {
    if (contains(rectangle, wrap(cell.x + k, world.width), cell.y, world)) count++;
  }
  return count;
}

// Enumerate A minus B as exposed columns in overlapping rows and full
// strips in new rows. A two-cell typing step reads two columns, including
// when either view wraps; unchanged overlapping rows are never traversed.
function visitExposed(a, b, world, visit) {
  const columns = [], outside = [];
  for (let col = 0; col < a.cols; col++) {
    const x = wrap(a.x + col, world.width);
    columns.push(x);
    if (wrap(x - b.x, world.width) >= b.cols) outside.push(x);
  }
  for (let row = 0; row < a.rows; row++) {
    const y = wrap(a.y + row, world.height);
    const xs = wrap(y - b.y, world.height) < b.rows ? outside : columns;
    for (const x of xs) visit(x, y);
  }
}

function smallMove(from, to, world) {
  const distance = (a, b, size) => Math.min(wrap(a - b, size), wrap(b - a, size));
  return from.cols === to.cols && from.rows === to.rows
    && distance(from.x, to.x, world.width) <= Math.min(16, from.cols)
    && distance(from.y, to.y, world.height) <= Math.min(16, from.rows);
}

function versionCounts(cells, marks) {
  const counts = new Map();
  for (const records of [cells, marks]) for (const { version } of records) {
    counts.set(version, (counts.get(version) || 0) + 1);
  }
  return counts;
}

// World commits replace cell records. One immutable public projection can be
// referenced by every subscribed socket's pending batch, even after overwrite.
const publicCells = new WeakMap();
function publicCell(cell) {
  if (!publicCells.has(cell)) publicCells.set(cell, Object.freeze(cellRecord(cell)));
  return publicCells.get(cell);
}

// A resize publishes a barrier to every socket in one turn. Share the immutable
// world projections for that turn; each observer still selects its own rectangle.
export function createSnapshotFrame(world, participants) {
  const now = world.now(), versions = new Map(), rows = [], spans = new WeakMap();
  const peers = participants.map(peer => Object.freeze(peerRecord(peer))).sort((a,b) => a.id.localeCompare(b.id));
  for (const source of world.cells.values()) {
    const row = rows[source.y] ??= [];
    row[source.x] = source;
  }
  function version(source) {
    let info = versions.get(source.version);
    if (!info) {
      const band = freshness(source.updatedAt, now);
      info = { band, stamp: source.updatedAt, color: world.authorColors.get(source.author) || '#314137' };
      versions.set(source.version, info);
    }
    return info;
  }
  return {
    version: cell => version(rows[cell.y][cell.x]),
    peers(self, rectangle) {
      const visible = [peerRecord(self)];
      for (const other of peers) if (other.id !== self.id && contains(rectangle, other.x, other.y, world)) visible.push(other);
      return visible;
    },
    cells(rectangle, marks) {
      const visible = new Map();
      for (let r = 0, y = rectangle.y; r < rectangle.rows; r++, y = (y+1) % world.height) {
        const row = rows[y];
        if (!row) continue;
        for (let c = 0, x = rectangle.x; c < rectangle.cols; c++, x = (x+1) % world.width) {
          const source = row[x];
          if (!source) continue;
          if (!occupiedCell(source)) {
            if (markVisible(version(source).band)) marks.push({ x, y, version:source.version });
            continue;
          }
          let span = spans.get(source);
          if (!span) {
            span = glyphSpan(world, source).map(member => [keyOf(member), publicCell(member)]);
            spans.set(source, span);
          }
          for (const [key, member] of span) visible.set(key, member);
        }
      }
      return visible;
    },
  };
}

function observationCost(world, rectangle, current, old, sameWorld) {
  let cost = 0;
  const previouslyVisible = (x, y) => sameWorld
    && (contains(old.view, x, y, world) || old.cells.has(cellKey(x, y)));
  // Empty addresses convey information too. Count the entire primary view,
  // then its occupied, adjacent glyph halves without double-counting either.
  if (!sameWorld) cost = rectangle.rows * rectangle.cols;
  else if (!sameRectangle(old.view, rectangle)) {
    visitExposed(rectangle, old.view, world, (x, y) => {
      if (!old.cells.has(cellKey(x, y))) cost++;
    });
  }
  for (const cell of current.values()) {
    if (!contains(rectangle, cell.x, cell.y, world) && !previouslyVisible(cell.x, cell.y)) cost++;
  }
  return cost;
}

/**
 * One bounded baseline per participant; this is not a global event log.
 * Read only after the final action of an HTTP turn. A stale revision receives
 * the current view, never the accumulated observations of intermediate moves.
 */
export class Observer {
  constructor({ world, peer, view, charge = () => {} }) {
    this.world = world; this.peer = peer; this.view = validateView(view);
    this.nextFreshnessAt = Infinity;
    this.charge = charge; this.revision = 0; this.last = null;
  }

  setView(view) {
    this.view = validateView(view);
    return { ...this.view };
  }

  relocate({ dx, dy, bounds }) {
    if (!this.last) return;
    const v = this.last.view;
    if (v.x < bounds.x || v.y < bounds.y || v.x + v.cols > bounds.x + bounds.cols || v.y + v.rows > bounds.y + bounds.rows) return;
    if (dx === 0 && dy === 0) {
      Object.assign(this.last, {epoch:this.world.epoch, width:this.world.width, height:this.world.height});
      return;
    }
    const moved = cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy,
      ...(Number.isInteger(cell.leadX) ? { leadX: cell.leadX + dx } : {}) });
    this.last = { ...this.last, epoch: this.world.epoch, width: this.world.width, height: this.world.height,
      view: moved(this.last.view), marks: byAddress([...this.last.marks.values()].map(moved)),
      peers: byId([...this.last.peers.values()].map(moved)),
      cells: new Map([...this.last.cells.values()].map(cell => { const next = moved(cell); return [cellKey(next.x, next.y), next]; })) };
  }

  /**
   * Synchronously capture one committed change before a later write or move.
   * The normal fixed-view path touches only its changed cells and one cursor.
   * Small moves inspect entering and leaving strips. The clock only changes
   * the versions already visible to this participant.
   */
  change({ cells = [], peer, removed = false }, getPeers = () => []) {
    const { world, last } = this;
    const view = viewRectangle(world, this.peer, this.view);
    const now = world.now();
    const moved = last && !sameRectangle(last.view, view);
    const ageDue = now >= this.nextFreshnessAt;
    if (!last || last.epoch !== world.epoch || (moved && !smallMove(last.view, view, world))) {
      const since = this.revision;
      const observation = this.read(getPeers(), { since });
      return observation.revision !== since || observation.reset ? observation : null;
    }

    const updates = [];
    let cost = 0;
    let inkDelta = 0;
    let addresses = cells;
    if (moved) {
      const dirty = new Map(cells.map(cell => [keyOf(cell), cell]));
      const include = (x, y) => dirty.set(cellKey(x, y), { x, y });
      const edge = (x, y) => {
        include(x, y);
        // Entering/leaving an edge can reveal or remove just the other half
        // of a glyph, even when that half never occupies a primary address.
        include(wrap(x - 1, world.width), y);
        include(wrap(x + 1, world.width), y);
      };
      visitExposed(view, last.view, world, (x, y) => {
        if (!last.cells.has(cellKey(x, y))) cost++;
        edge(x, y);
      });
      visitExposed(last.view, view, world, edge);
      addresses = dirty.values();
    }
    for (const address of addresses) {
      const key = keyOf(address);
      const oldCell = last.cells.get(key), oldMark = last.marks.get(key);
      const inside = contains(view, address.x, address.y, world);
      // A bulk expiration can mention distant cells in the same commit. Only
      // an adjacent valid CJK half can extend visibility outside the rectangle.
      if (!inside && !oldCell && !oldMark
        && !contains(view, address.x - 1, address.y, world)
        && !contains(view, address.x + 1, address.y, world)) continue;
      const source = world.getCell(address.x, address.y);
      let cell, mark;
      if (occupiedCell(source)) {
        const span = glyphSpan(world, source);
        if (span.length && (inside || span.some(member => contains(view, member.x, member.y, world)))) {
          cell = publicCell(source);
        }
      } else if (inside && source && markVisible(freshness(source.updatedAt, now))) {
        mark = { x: source.x, y: source.y, version: source.version };
      }
      if (oldCell) inkDelta -= visibleInk(oldCell, last.view, world);
      if (cell) inkDelta += visibleInk(cell, view, world);
      if ((cell ? sameCell(oldCell, cell) : !oldCell) && oldMark?.version === mark?.version) continue;
      if (cell && !inside && !oldCell && !contains(last.view, cell.x, cell.y, world)) cost++;
      updates.push({ key, oldCell, oldMark, cell, mark, source });
    }

    const updatedPeers = [], departed = [];
    if (moved) {
      const visible = peersInRectangle(world, this.peer, view, getPeers());
      const ids = new Set(visible.map(other => other.id));
      for (const other of visible) if (!samePeer(last.peers.get(other.id), other)) updatedPeers.push(other);
      for (const id of last.peers.keys()) if (!ids.has(id)) departed.push(id);
    } else if (peer) {
      const previous = last.peers.get(peer.id);
      if (!removed && contains(view, peer.x, peer.y, world)) {
        if (!samePeer(previous, peer)) updatedPeers.push(peerRecord(peer));
      } else if (previous) departed.push(peer.id);
    }
    const changed = moved || updates.length || updatedPeers.length || departed.length;
    if (!changed && !ageDue) return null;
    // A failed budget check must leave the revision and all cache maps intact.
    this.charge(cost);
    const delta = { partial: true, view, cells: [], forget: [], marks: [], unmark: [],
      freshness: {}, colors: {}, forgetVersions: [], peers: updatedPeers, departed };
    if (!last.counts) last.counts = versionCounts(last.cells.values(), last.marks.values());
    // Thousands of versions usually share only a few five-second timestamps.
    // Index their next band boundary once; only a due group needs its versions
    // visited. This is a private view cache, not a new timestamp on each cell.
    if (!last.ageGroups) {
      last.ageGroups = new Map();
      for (const [version, stamp] of last.times) {
        if (!Number.isFinite(stamp) || !last.counts.has(version)) continue;
        let group = last.ageGroups.get(stamp);
        if (!group) last.ageGroups.set(stamp, group = {
          at: stamp + freshnessUntil[last.freshness[version]], versions: new Set(),
        });
        group.versions.add(version);
      }
    }
    const lost = new Set();
    const release = version => {
      const remaining = last.counts.get(version) - 1;
      if (remaining) last.counts.set(version, remaining);
      else { last.counts.delete(version); lost.add(version); }
    };
    for (const { key, oldCell, oldMark, cell, mark, source } of updates) {
      const old = oldCell || oldMark;
      if (old) release(old.version);
      if (oldCell && !cell) { last.cells.delete(key); delta.forget.push({ x: oldCell.x, y: oldCell.y }); }
      if (cell) {
        last.cells.set(key, cell); delta.cells.push(cell);
      }
      if (oldMark && !mark) {
        last.marks.delete(key); delta.unmark.push({ x: oldMark.x, y: oldMark.y });
      }
      if (mark) { last.marks.set(key, mark); delta.marks.push({ ...mark }); }
      if (cell || mark) {
        const { version, updatedAt } = source;
        const band = freshness(updatedAt, now);
        if (!last.counts.has(version)) {
          delta.freshness[version] = band;
          delta.colors[version] = world.authorColors.get(source.author) || '#314137';
        }
        if (last.freshness[version] !== band) delta.freshness[version] = band;
        last.times.set(version, updatedAt);
        if (Number.isFinite(updatedAt)) {
          let group = last.ageGroups.get(updatedAt);
          if (!group) last.ageGroups.set(updatedAt, group = {
            at: updatedAt + freshnessUntil[band], versions: new Set(),
          });
          group.versions.add(version);
        }
        last.counts.set(version, (last.counts.get(version) || 0) + 1);
        last.freshness[version] = band;
        if (Number.isFinite(updatedAt)) this.nextFreshnessAt = Math.min(this.nextFreshnessAt,
          updatedAt + freshnessUntil[band]);
      }
    }
    if (ageDue) {
      this.nextFreshnessAt = Infinity;
      for (const [stamp, group] of last.ageGroups) {
        if (now >= group.at) {
          const band = freshness(stamp, now);
          for (const version of group.versions) {
            if (last.counts.has(version) && last.freshness[version] !== band) {
              delta.freshness[version] = band;
              last.freshness[version] = band;
            }
          }
          group.at = stamp + freshnessUntil[band];
        }
        this.nextFreshnessAt = Math.min(this.nextFreshnessAt, group.at);
      }
      for (const [key, mark] of last.marks) if (!markVisible(last.freshness[mark.version])) {
        last.marks.delete(key);
        delta.unmark.push({ x: mark.x, y: mark.y });
        release(mark.version);
      }
    }
    for (const version of lost) if (!last.counts.has(version)) {
      const stamp = last.times.get(version), group = last.ageGroups.get(stamp);
      if (group) {
        group.versions.delete(version);
        if (!group.versions.size) last.ageGroups.delete(stamp);
      }
      last.times.delete(version);
      delete last.freshness[version]; delete delta.freshness[version]; delete delta.colors[version];
      delta.forgetVersions.push(version);
    }
    if (!changed && !delta.unmark.length && !Object.keys(delta.freshness).length) return null;
    delta.revision = ++this.revision;
    last.view = view;
    this.ink += inkDelta;
    this.density = this.ink / (view.cols * view.rows);
    for (const other of updatedPeers) last.peers.set(other.id, Object.freeze(other));
    for (const id of departed) last.peers.delete(id);
    // Captured arrays can be held until a later flush, while the world advances.
    for (const value of Object.values(delta)) if (value && typeof value === 'object') Object.freeze(value);
    return Object.freeze(delta);
  }

  read(peers = [], { since, force = false, frame, topologyDelta, translated } = {}) {
    const { world, peer } = this, old = this.last, previousRevision = this.revision;
    const rectangle = viewRectangle(world, peer, this.view);
    const marks = [];
    // Automatic remeshing keeps occupied glyphs on a proven rigid patch and removes tombstones.
    const reuseCells = topologyDelta && translated && old?.epoch === world.epoch && sameRectangle(old.view, rectangle);
    const current = reuseCells ? old.cells : frame ? frame.cells(rectangle, marks) : cellsInRectangle(world, rectangle, marks);
    let ink = reuseCells ? this.ink : 0;
    if (!reuseCells) for (const cell of current.values()) ink += visibleInk(cell, rectangle, world);
    const now = world.now();
    const reuseAges = reuseCells && !old.marks.size && now < this.nextFreshnessAt;
    const ages = reuseAges ? old.freshness : {}, colors = {}, times = reuseAges ? old.times : new Map();
    let nextFreshnessAt = reuseAges ? this.nextFreshnessAt : Infinity;
    if (!reuseAges) for (const cell of [...current.values(), ...marks]) {
      if (times.has(cell.version)) continue;
      const source = frame ? null : world.getCell(cell.x, cell.y);
      const info = frame?.version(cell);
      const updatedAt = info ? info.stamp : source?.updatedAt;
      const band = info ? info.band : freshness(updatedAt, now);
      colors[cell.version] = info ? info.color : world.authorColors.get(source?.author) || '#314137';
      times.set(cell.version, updatedAt);
      ages[cell.version] = band;
      if (Number.isFinite(updatedAt)) nextFreshnessAt = Math.min(nextFreshnessAt, updatedAt + freshnessUntil[band]);
    }
    const localPeers = frame ? frame.peers(peer, rectangle) : peersInRectangle(world, peer, rectangle, peers);
    const cells = [], forget = [];
    if (!reuseCells) {
      for (const [key, cell] of current) if (!sameCell(old?.cells.get(key), cell)) cells.push(cell);
      if (old) for (const [key, cell] of old.cells) if (!current.has(key)) forget.push({ x: cell.x, y: cell.y });
    }
    const sameWorld = old && old.epoch === world.epoch && old.width === world.width && old.height === world.height;
    // A rejected observation must not advance the baseline or its revision.
    // Retry therefore charges for exactly the still-unseen addresses again.
    this.charge(reuseCells ? 0 : observationCost(world, rectangle, current, old, sameWorld));
    this.ink = ink;
    this.density = ink / (rectangle.cols * rectangle.rows);
    this.nextFreshnessAt = nextFreshnessAt;
    const changed = topologyDelta || !sameWorld || !sameRectangle(old?.view, rectangle) || cells.length || forget.length || old.marks.size !== marks.length
      || marks.some(mark => old.marks.get(keyOf(mark))?.version !== mark.version)
      || Object.keys(old.freshness).length !== Object.keys(ages).length
      || Object.entries(ages).some(([version, band]) => old.freshness[version] !== band)
      || old.peers.size !== localPeers.length || localPeers.some(peer => !samePeer(old.peers.get(peer.id), peer));
    if (changed) this.revision++;
    const reset = force || !sameWorld || since !== previousRevision;
    // Snapshots own their records: mutation of a response cannot corrupt the
    // comparison baseline or manufacture observations in the next response.
    this.last = { epoch: world.epoch, width: world.width, height: world.height,
      view: { ...rectangle }, marks: byAddress(marks), times, freshness: { ...ages },
      cells: frame ? current : byAddress([...current.values()]), peers: frame ? new Map(localPeers.map(other => [other.id, other])) : byId(localPeers), counts: null };
    if (topologyDelta && old) {
      const freshness = {}, newColors = {};
      if (!reuseAges) for (const [version, band] of Object.entries(ages)) {
        if (old.freshness[version] !== band) freshness[version] = band;
        if (!(version in old.freshness)) newColors[version] = colors[version];
      }
      return { partial:true, revision:this.revision, view:rectangle, cells, forget, marks,
        unmark:[...old.marks.values()].filter(mark => !this.last.marks.has(keyOf(mark))).map(({x,y}) => ({x,y})),
        freshness, colors:newColors, forgetVersions:reuseAges ? [] : Object.keys(old.freshness).filter(version => !(version in ages)),
        peers:localPeers.filter(other => !samePeer(old.peers.get(other.id), other)),
        departed:[...old.peers.keys()].filter(id => !this.last.peers.has(id)) };
    }
    return { revision: this.revision, reset: !!reset, view: rectangle,
      cells: reset ? [...current.values()] : cells, forget: reset ? [] : forget, marks: marks.map(mark => ({ ...mark })), freshness: ages, colors,
      peers: frame ? localPeers : localPeers.map(other => ({ ...other })) };
  }
}
