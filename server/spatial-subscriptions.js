import { contains, viewRectangle } from './visibility.js';

const TILE_SIZE = 16;
const tileKey = (column, row) => column + ',' + row;
const tile = (x, y) => tileKey(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));

function axisTiles(start, length, worldSize) {
  const tiles = new Set();
  let position = start;
  while (length > 0) {
    const index = Math.floor(position / TILE_SIZE);
    tiles.add(index);
    const next = Math.min(worldSize, (index + 1) * TILE_SIZE);
    length -= next - position;
    position = next === worldSize ? 0 : next;
  }
  return tiles;
}

function tilesIn(view, world) {
  const result = new Set();
  const columns = axisTiles(view.x, view.cols, world.width);
  for (const row of axisTiles(view.y, view.rows, world.height)) {
    for (const column of columns) result.add(tileKey(column, row));
  }
  return result;
}

function add(index, key, actor) {
  let members = index.get(key);
  if (!members) index.set(key, members = new Set());
  members.add(actor);
}

function remove(index, key, actor) {
  const members = index.get(key);
  members.delete(actor);
  if (!members.size) index.delete(key);
}

// The same tiles index public cursor positions and view subscriptions separately.
// Candidates are checked against their exact wrapping rectangle before delivery.
export class SpatialSubscriptions {
  constructor(world) {
    this.world = world;
    this.positions = new Map();
    this.subscribers = new Map();
    this.registrations = new Map();
  }

  update(actor) {
    const old = this.registrations.get(actor);
    if (actor.closed) {
      if (old) {
        this.registrations.delete(actor);
        remove(this.positions, old.tile, actor);
        for (const key of old.tiles) remove(this.subscribers, key, actor);
      }
      return old;
    }
    const { x, y } = actor.peer;
    const view = viewRectangle(this.world, actor.peer, actor.observer.view);
    const position = tile(x, y);
    if (old?.tile !== position) {
      if (old) remove(this.positions, old.tile, actor);
      add(this.positions, position, actor);
    }
    let tiles = old?.tiles;
    if (!old || old.epoch !== this.world.epoch || old.view.x !== view.x || old.view.y !== view.y ||
        old.view.cols !== view.cols || old.view.rows !== view.rows) {
      tiles = tilesIn(view, this.world);
      for (const key of old?.tiles || []) if (!tiles.has(key)) remove(this.subscribers, key, actor);
      for (const key of tiles) if (!old?.tiles.has(key)) add(this.subscribers, key, actor);
    }
    this.registrations.set(actor, { x, y, view, tile: position, tiles, epoch: this.world.epoch });
    return old;
  }

  collect(point, output) {
    const candidates = this.subscribers.get(tile(point.x, point.y));
    if (!candidates) return;
    for (const actor of candidates) {
      if (!output.has(actor) && contains(this.registrations.get(actor).view, point.x, point.y, this.world)) output.add(actor);
    }
  }

  peersFor(actor) {
    const registration = this.registrations.get(actor);
    const result = [];
    for (const key of registration.tiles) {
      for (const other of this.positions.get(key) || []) {
        if (contains(registration.view, other.peer.x, other.peer.y, this.world)) result.push(other.peer);
      }
    }
    return result;
  }
}
