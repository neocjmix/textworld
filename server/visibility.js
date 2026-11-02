import { VIEW_LIMITS } from '../shared/participant-rules.js';
import { cellKey, occupiedCell, wrap } from '../shared/world.js';

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
const peerRecord = peer => ({
  id: peer.id, name: peer.name, color: peer.color, x: peer.x, y: peer.y,
});

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

function cellsInRectangle(world, rectangle) {
  const cells = new Map();
  // The loop is bounded by the accepted view, not by total world occupancy.
  // Clamp dimensions before iterating so a small torus never repeats addresses.
  for (let row = 0; row < rectangle.rows; row++) {
    const y = wrap(rectangle.y + row, world.height);
    for (let col = 0; col < rectangle.cols; col++) {
      const x = wrap(rectangle.x + col, world.width), cell = world.getCell(x, y);
      if (!occupiedCell(cell)) continue;
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
  return peersInRectangle(world, peer, viewRectangle(world, peer, view), peers);
}

const sameCell = (a, b) => a && a.x === b.x && a.y === b.y && a.text === b.text
  && a.width === b.width && a.leadX === b.leadX && a.version === b.version;
const sameRectangle = (a, b) => a && a.x === b.x && a.y === b.y && a.cols === b.cols && a.rows === b.rows;
const samePeers = (a, b) => a && a.length === b.length && a.every((peer, index) => {
  const other = b[index];
  return peer.id === other.id && peer.name === other.name && peer.color === other.color
    && peer.x === other.x && peer.y === other.y;
});

function observationCost(world, rectangle, current, old, sameWorld) {
  let cost = 0;
  const previouslyVisible = (x, y) => sameWorld
    && (contains(old.view, x, y, world) || old.cells.has(cellKey(x, y)));
  // Empty addresses convey information too. Count the entire primary view,
  // then its occupied, adjacent glyph halves without double-counting either.
  for (let row = 0; row < rectangle.rows; row++) {
    const y = wrap(rectangle.y + row, world.height);
    for (let col = 0; col < rectangle.cols; col++) {
      const x = wrap(rectangle.x + col, world.width);
      if (!previouslyVisible(x, y)) cost++;
    }
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
    this.charge = charge; this.revision = 0; this.last = null;
  }

  setView(view) {
    this.view = validateView(view);
    return { ...this.view };
  }

  read(peers = [], { since, force = false } = {}) {
    const { world, peer } = this, old = this.last, previousRevision = this.revision;
    const rectangle = viewRectangle(world, peer, this.view);
    const current = cellsInRectangle(world, rectangle);
    const localPeers = peersInRectangle(world, peer, rectangle, peers);
    const cells = [], forget = [];
    for (const [key, cell] of current) if (!sameCell(old?.cells.get(key), cell)) cells.push(cell);
    if (old) for (const [key, cell] of old.cells) if (!current.has(key)) forget.push({ x: cell.x, y: cell.y });
    const sameWorld = old && old.epoch === world.epoch && old.width === world.width && old.height === world.height;
    // A rejected observation must not advance the baseline or its revision.
    // Retry therefore charges for exactly the still-unseen addresses again.
    this.charge(observationCost(world, rectangle, current, old, sameWorld));
    const changed = !sameWorld || !sameRectangle(old?.view, rectangle) || cells.length || forget.length || !samePeers(old?.peers, localPeers);
    if (changed) this.revision++;
    const reset = force || !sameWorld || since !== previousRevision;
    // Snapshots own their records: mutation of a response cannot corrupt the
    // comparison baseline or manufacture observations in the next response.
    this.last = { epoch: world.epoch, width: world.width, height: world.height,
      view: { ...rectangle }, cells: new Map([...current].map(([key, cell]) => [key, { ...cell }])),
      peers: localPeers.map(other => ({ ...other })) };
    return { revision: this.revision, reset: !!reset, view: rectangle,
      cells: reset ? [...current.values()] : cells, forget: reset ? [] : forget, peers: localPeers };
  }
}
