import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanMotion } from '../public/inertia.js';

function harness({ reduced = false } = {}) {
  let time = 0, id = 0;
  const frames = new Map(), moves = [];
  const motion = createPanMotion({
    pan: (x, y) => moves.push({ x, y, time }),
    now: () => time,
    reducedMotion: () => reduced,
    requestFrame: callback => { frames.set(++id, callback); return id; },
    cancelFrame: key => frames.delete(key),
  });
  return {
    motion, moves,
    elapsed(ms) { time += ms; },
    frame(ms = 16, timestampOffset = 0) {
      time += ms;
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback(time + timestampOffset);
    },
    finish(ms = 16) { for (let i = 0; motion.active && i < 500; i++) this.frame(ms); assert.equal(motion.active, false); },
    total() { return moves.reduce((p, n) => ({ x: p.x + n.x, y: p.y + n.y }), { x: 0, y: 0 }); },
    reduce(value) { reduced = value; },
  };
}

test('a released flick continues in both axes, decelerates and settles', () => {
  const h = harness();
  h.motion.begin();
  for (let i = 0; i < 5; i++) { h.elapsed(16); h.motion.drag(16, -8); }
  assert.deepEqual(h.total(), { x: 80, y: -40 });
  h.motion.end(); assert.equal(h.motion.active, true);
  h.frame(); const first = h.moves.at(-1);
  h.frame(); const second = h.moves.at(-1);
  assert.ok(first.x > second.x && first.x > 0 && second.x > 0);
  assert.ok(first.y < second.y && second.y < 0);
  h.finish();
  const total = h.total();
  assert.ok(total.x > 250 && total.x < 305);
  assert.ok(Math.abs(total.y / total.x + .5) < 1e-9);
});

test('release after holding still does not coast, and a tap never moves', () => {
  const h = harness();
  h.motion.begin(); h.elapsed(16); h.motion.drag(32, 0);
  h.elapsed(100); h.motion.end(); h.frame();
  assert.deepEqual(h.total(), { x: 32, y: 0 });
  assert.equal(h.motion.active, false);
  h.motion.begin(); h.elapsed(20); h.motion.end(); h.frame();
  assert.deepEqual(h.total(), { x: 32, y: 0 });
});

test('new gesture and explicit cancellation stop all scheduled movement', () => {
  for (const interrupt of ['cancel', 'begin']) {
    const h = harness();
    h.motion.begin(); h.elapsed(16); h.motion.drag(32, 0); h.motion.end(); h.frame();
    h.motion[interrupt](); const before = h.total();
    h.frame(); h.frame(1000);
    assert.deepEqual(h.total(), before);
    assert.equal(h.motion.active, false);
  }
});

test('browser suspension discards inertia instead of producing a resume jump', () => {
  const h = harness();
  h.motion.begin(); h.elapsed(16); h.motion.drag(32, 0); h.motion.end(); h.frame();
  const before = h.total(); h.frame(1000);
  assert.deepEqual(h.total(), before);
  assert.equal(h.motion.active, false);
});

test('a frame timestamp earlier than pointer release does not cancel a new fling', () => {
  const h = harness();
  h.motion.begin(); h.elapsed(16); h.motion.drag(32, 0); h.motion.end();
  // Native RAF can report the frame start before the same-frame pointerup.
  h.frame(1, -5);
  assert.equal(h.motion.active, true);
  assert.ok(h.total().x > 32);
  h.finish();
});

test('frame rate changes do not change inertial distance materially', () => {
  const totals = [8, 16, 33].map(interval => {
    const h = harness(); h.motion.begin();
    h.elapsed(20); h.motion.drag(30, 15); h.elapsed(20); h.motion.drag(30, 15);
    h.motion.end(); h.finish(interval); return h.total().x;
  });
  assert.ok(Math.max(...totals) - Math.min(...totals) < 1);
});

test('wheel smoothing conserves supplied distance including native momentum and reversals', () => {
  const h = harness();
  const stream = [[48, 96], [24, 48], [12, 24], [6, 12], [3, 6], [-20, -10]];
  for (const [x, y] of stream) { h.motion.wheel(x, y); h.frame(12); }
  h.finish();
  const expected = stream.reduce((p, [x, y]) => ({ x: p.x + x, y: p.y + y }), { x: 0, y: 0 });
  assert.ok(Math.abs(h.total().x - expected.x) < 1e-9);
  assert.ok(Math.abs(h.total().y - expected.y) < 1e-9);
  const stopped = h.total(); h.frame(1000); assert.deepEqual(h.total(), stopped);
});

test('typing cancellation can discard pending wheel motion immediately', () => {
  const h = harness(); h.motion.wheel(120, 0); h.frame();
  h.motion.cancel(); const before = h.total(); h.frame(); h.frame(1000);
  assert.deepEqual(h.total(), before); assert.equal(h.motion.active, false);
});

test('reduced motion retains direct manipulation but disables inertial continuation', () => {
  const h = harness({ reduced: true });
  h.motion.begin(); h.elapsed(20); h.motion.drag(40, 0); h.motion.end(); h.frame();
  assert.deepEqual(h.total(), { x: 40, y: 0 });
  h.motion.wheel(10, -25);
  assert.deepEqual(h.total(), { x: 50, y: -25 }); assert.equal(h.motion.active, false);
});

test('large or invalid input cannot create unbounded inertial speed', () => {
  const h = harness(); h.motion.begin(); h.elapsed(16); h.motion.drag(10000, 0);
  h.motion.drag(NaN, 1); h.motion.wheel(Infinity, 1); h.motion.end();
  const direct = h.total().x; h.finish();
  assert.ok(h.total().x - direct < 665);
  assert.ok(Number.isFinite(h.total().x));
});
