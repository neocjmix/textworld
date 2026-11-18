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
