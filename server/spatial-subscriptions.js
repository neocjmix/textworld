import { contains, viewRectangle } from './visibility.js';

const TILE_SIZE = 16;
const tileKey = (column, row) => column + ',' + row;
const tile = (x, y) => tileKey(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));

// A bounded slot bitset gives an exact tile union without walking the crowd.
// Hex conversion avoids one BigInt allocation per participant when counting.
function bitCount(bits) {
  const digits = bits.toString(16), counts = '0112122312232334';
  let count = 0;
  for (let i = 0; i < digits.length; i++) {
    const code = digits.charCodeAt(i);
    count += counts.charCodeAt(code <= 57 ? code - 48 : code - 87) - 48;
  }
  return count;
}

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
    this.subscriberBits = new Map();
    this.freeSlots = [];
    this.nextSlot = 0;
  }

  subscribe(key, actor, bit) {
    add(this.subscribers, key, actor);
    this.subscriberBits.set(key, (this.subscriberBits.get(key) ?? 0n) | bit);
  }

  unsubscribe(key, actor, bit) {
    remove(this.subscribers, key, actor);
    if (this.subscribers.has(key)) this.subscriberBits.set(key, this.subscriberBits.get(key) & ~bit);
    else this.subscriberBits.delete(key);
  }

  update(actor) {
    const old = this.registrations.get(actor);
    if (actor.closed) {
      if (old) {
        this.registrations.delete(actor);
        remove(this.positions, old.tile, actor);
        for (const key of old.tiles) this.unsubscribe(key, actor, old.bit);
        this.freeSlots.push(old.slot);
      }
      return old;
    }
    const slot = old?.slot ?? this.freeSlots.pop() ?? this.nextSlot++;
    const bit = old?.bit ?? (1n << BigInt(slot));
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
      for (const key of old?.tiles || []) if (!tiles.has(key)) this.unsubscribe(key, actor, bit);
      for (const key of tiles) if (!old?.tiles.has(key)) this.subscribe(key, actor, bit);
    }
    this.registrations.set(actor, { x, y, view, tile: position, tiles, epoch: this.world.epoch, slot, bit });
    return old;
  }

  collect(point, output) {
    const candidates = this.subscribers.get(tile(point.x, point.y));
    if (!candidates) return;
    for (const actor of candidates) {
      if (!output.has(actor) && contains(this.registrations.get(actor).view, point.x, point.y, this.world)) output.add(actor);
    }
  }

  // Admission unions tile bitsets, never the crowd itself. Edit footprints are
  // bounded by the existing atomic input limits; adjacent CJK halves count too.
  candidateCount(point, previous, affected) {
    const key = tile(point.x, point.y);
    if (affected?.length) {
      const keys = new Set([key]);
      if (previous) keys.add(tile(previous.x, previous.y));
      for (const cell of affected) for (const dx of [-1, 0, 1]) {
        keys.add(tile((cell.x + dx + this.world.width) % this.world.width, cell.y));
      }
      if (keys.size === 1) return this.subscribers.get(key)?.size ?? 0;
      let bits = 0n;
      for (const covered of keys) bits |= this.subscriberBits.get(covered) ?? 0n;
      return bitCount(bits);
    }
    const count = this.subscribers.get(key)?.size ?? 0;
    const before = previous && tile(previous.x, previous.y);
    if (!before || before === key) return count;
    return bitCount((this.subscriberBits.get(key) ?? 0n) | (this.subscriberBits.get(before) ?? 0n));
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
