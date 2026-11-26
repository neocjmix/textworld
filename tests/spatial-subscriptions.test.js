import test from 'node:test';
import assert from 'node:assert/strict';
import { SpatialSubscriptions } from '../server/spatial-subscriptions.js';
import { contains, viewRectangle } from '../server/visibility.js';

test('spatial subscriptions match exact wrapping views through moves, departures and resizes', () => {
  const world = { width: 61, height: 35, epoch: 1 };
  const index = new SpatialSubscriptions(world);
  const actors = [
    [0, 0, 5, 3], [58, 31, 13, 11], [16, 16, 1, 1], [24, 18, 61, 35],
  ].map(([x, y, cols, rows], id) => ({
    peer: { x, y, id }, observer: { view: { cols, rows } },
  }));
  for (const actor of actors) index.update(actor);
  function verify() {
    const active = actors.filter(actor => !actor.closed);
    const rectangles = new Map(active.map(actor => [actor, viewRectangle(world, actor.peer, actor.observer.view)]));
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const actual = new Set();
        index.collect({ x, y }, actual);
        const expected = active.filter(actor => contains(rectangles.get(actor), x, y, world));
        assert.deepEqual(actual, new Set(expected));
        assert.ok(index.candidateCount({ x, y }) >= expected.length);
        const previous = { x: (x + 19) % world.width, y: (y + 7) % world.height };
        const union = active.filter(actor => contains(rectangles.get(actor), x, y, world)
          || contains(rectangles.get(actor), previous.x, previous.y, world));
        const bound = index.candidateCount({ x, y }, previous);
        assert.ok(bound >= union.length && bound <= active.length, 'both ends are covered without exceeding the population');
        assert.equal(index.candidateCount({ x, y }, { x, y }), index.candidateCount({ x, y }));
      }
    }
    for (const actor of active) {
      const expected = active.filter(other => contains(rectangles.get(actor), other.peer.x, other.peer.y, world));
      assert.deepEqual(new Set(index.peersFor(actor)), new Set(expected.map(other => other.peer)));
    }
  }
  verify();
  actors[1].peer.x = 18;
  const previous = index.update(actors[1]);
  assert.equal(previous.x, 58);
  actors[2].closed = true;
  index.update(actors[2]);
  verify();
  Object.assign(world, { width: 43, height: 33, epoch: 2 });
  for (const actor of actors) index.update(actor);
  verify();
});

test('edit admission includes an off-origin CJK half and a distant replacement footprint', () => {
  const world = { width: 128, height: 64, epoch: 1 };
  const index = new SpatialSubscriptions(world);
  for (let id = 0; id < 1000; id++) index.update({ peer: { id, x: 16, y: 32 }, observer: { view: { cols: 1, rows: 1 } } });
  const origin = { x: 15, y: 32 };
  assert.equal(index.candidateCount(origin), 0, 'the old origin-only estimate misses the entire audience');
  assert.equal(index.candidateCount(origin, undefined, [origin]), 1000, 'an overwritten wide glyph may extend across the tile edge');
  assert.equal(index.candidateCount({x:0,y:32},{x:64,y:32},[{x:16,y:32}]), 1000, 'the middle of an edit can have an audience absent at both cursor endpoints');
});

test('admission counts overlapping tile subscribers once through departure, slot reuse and resize', () => {
  const world = { width: 256, height: 128, epoch: 1 };
  const index = new SpatialSubscriptions(world);
  const actors = Array.from({ length: 1000 }, (_, id) => ({
    peer: { id, x: id < 500 ? 16 : 160, y: 32 }, observer: { view: { cols: 32, rows: 20 } },
  }));
  for (const actor of actors) index.update(actor);
  const point = { x: 15, y: 32 }, previous = { x: 16, y: 32 };
  assert.equal(index.candidateCount(point, previous, [point]), 500,
    'a CJK boundary must not charge one audience twice');
  assert.equal(index.candidateCount(point, previous), 500, 'movement shares the same audience');
  assert.equal(index.candidateCount(point, previous, [point, {x:160,y:32}]), 1000,
    'disjoint subscribers still add to the total');
  for (const actor of actors.slice(0, 100)) { actor.closed = true; index.update(actor); }
  assert.equal(index.candidateCount(point, previous, [point]), 400);
  for (const actor of actors.slice(0, 100)) { actor.closed = false; actor.peer.x = 160; index.update(actor); }
  assert.equal(index.candidateCount(point, previous, [point]), 400, 'reused slots do not resurrect subscriptions');
  Object.assign(world, { width: 32, height: 16, epoch: 2 });
  for (const actor of actors) { actor.peer.x %= 32; actor.peer.y %= 16; index.update(actor); }
  assert.equal(index.candidateCount({x:15,y:0}, {x:16,y:0}, [{x:31,y:0}]), 1000);
  for (const actor of actors) { actor.closed = true; index.update(actor); }
  assert.equal(index.candidateCount({x:15,y:0}, {x:16,y:0}, [{x:31,y:0}]), 0);
});
