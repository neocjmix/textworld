import assert from 'node:assert/strict';
import test from 'node:test';
import { createCameraMotion } from '../public/camera-motion.js';

function harness(initial = { x: 0, y: 0 }) {
  let time = 0, nextId = 0, reduced = false;
  const frames = new Map(), positions = [];
  const motion = createCameraMotion({
    initial,
    onUpdate: position => positions.push({ ...position, time }),
    now: () => time,
    reducedMotion: () => reduced,
    requestFrame: callback => { frames.set(++nextId, callback); return nextId; },
    cancelFrame: id => frames.delete(id),
  });
  return {
    motion, positions,
    elapsed(ms) { time += ms; },
    frame(ms = 16, offset = 0) {
      time += ms;
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(time + offset);
    },
    finish(ms = 16) { for (let i = 0; motion.active && i < 200; i++) this.frame(ms); assert.equal(motion.active, false); },
    reduce(value) { reduced = value; },
    get queued() { return frames.size; },
  };
}

test('typing changes the destination immediately and the camera approaches without overshooting', () => {
  const h = harness({ x: 10, y: 8 });
  h.motion.setTarget({ x: 12, y: 9 }, { scale: { x: 9, y: 26 } });
  assert.deepEqual(h.motion.position, { x: 10, y: 8 });
  assert.deepEqual(h.motion.target, { x: 12, y: 9 });
  assert.equal(h.motion.active, true);
  h.frame(); assert.ok(h.motion.position.x > 10 && h.motion.position.x < 12);
  h.finish(); assert.deepEqual(h.motion.position, { x: 12, y: 9 });
  assert.ok(h.positions.every((p, i, all) => p.x <= 12 && p.y <= 9 && (!i || p.x >= all[i - 1].x)));
});

test('60 Hz and 120 Hz cameras have the same position at equal elapsed time', () => {
  const values = [8, 16, 32].map(interval => {
    const h = harness(); h.motion.setTarget({ x: 20, y: -10 }, { scale: { x: 9, y: 26 } });
    for (let i = 0; i < 160 / interval; i++) h.frame(interval);
    return h.motion.position;
  });
  for (const value of values) {
    assert.ok(Math.abs(value.x - values[0].x) < 1e-10);
    assert.ok(Math.abs(value.y - values[0].y) < 1e-10);
  }
});

test('continuous retargeting retains the current frame clock and a reversal does not jump', () => {
  const h = harness();
  h.motion.setTarget({ x: 10, y: 0 }); h.elapsed(8);
  h.motion.setTarget({ x: 20, y: 0 }); h.frame(8);
  assert.ok(Math.abs(h.motion.position.x - 20 * (1 - Math.exp(-16 / 80))) < 1e-10);
  const before = h.motion.position;
  h.motion.setTarget({ x: -10, y: 0 });
  assert.deepEqual(h.motion.position, before);
  h.frame(); assert.ok(h.motion.position.x < before.x);
  h.finish(); assert.deepEqual(h.motion.position, { x: -10, y: 0 });
});

test('torus seam targets use the nearby unwrapped copy in either direction', () => {
  const extent = { width: 128, height: 64 };
  for (const [start, destination, expected] of [
    [{ x: 127, y: 63 }, { x: 0, y: 0 }, { x: 128, y: 64 }],
    [{ x: 0, y: 0 }, { x: 127, y: 63 }, { x: -1, y: -1 }],
  ]) {
    const h = harness(start); h.motion.setTarget(destination, { extent });
    assert.deepEqual(h.motion.target, expected); h.finish();
    assert.deepEqual(h.motion.position, expected);
  }
});

test('keyboard resize preserves the old camera before approaching the new center without torus shortcuts', () => {
  const h = harness({ x: 4, y: -10 });
  // A viewport height decrease changes the desired camera by more than half a
  // small torus. Omitting extent preserves the intentional visual direction.
  h.motion.setTarget({ x: 4, y: 2 }, { scale: { x: 9, y: 26 }, timeConstant: 90 });
  assert.deepEqual(h.motion.position, { x: 4, y: -10 });
  h.frame(); assert.ok(h.motion.position.y > -10 && h.motion.position.y < 2);
  h.finish(); assert.deepEqual(h.motion.position, { x: 4, y: 2 });
});

test('fast sequential targets keep their direction across multiple torus laps while rendering lags', () => {
  const h = harness({ x: 30, y: 0 }), extent = { width: 32, height: 16 };
  for (let x = 31; x <= 110; x++) {
    h.motion.setTarget({ x: x % 32, y: 0 }, { extent });
    assert.equal(h.motion.target.x, x);
  }
  assert.equal(h.motion.position.x, 30);
  h.frame(); assert.ok(h.motion.position.x > 30 && h.motion.position.x < 110);
  h.finish(); assert.equal(h.motion.position.x, 110);
});

test('direct manipulation and jump bypass animation while cancellation freezes the visible position', () => {
  const h = harness();
  h.motion.setTarget({ x: 8, y: 3 }, { immediate: true });
  assert.deepEqual(h.motion.position, { x: 8, y: 3 }); assert.equal(h.queued, 0);
  h.motion.setTarget({ x: 20, y: 4 }); h.frame();
  const before = h.motion.position;
  h.motion.cancel(); h.frame(500);
  assert.deepEqual(h.motion.position, before); assert.deepEqual(h.motion.target, before);
  h.motion.jump({ x: -12, y: 90 }); assert.deepEqual(h.motion.position, { x: -12, y: 90 });
  assert.equal(h.queued, 0);
});

test('reduced motion applies immediately and also settles an already running transition', () => {
  const h = harness(); h.reduce(true);
  h.motion.setTarget({ x: 9, y: 7 });
  assert.deepEqual(h.motion.position, { x: 9, y: 7 }); assert.equal(h.motion.active, false);
  h.reduce(false); h.motion.setTarget({ x: 30, y: 8 }); h.frame(); h.reduce(true); h.frame();
  assert.deepEqual(h.motion.position, { x: 30, y: 8 }); assert.equal(h.motion.active, false);
});

test('suspension and stale RAF timestamps cannot restart or reverse a camera tail', () => {
  const h = harness(); h.motion.setTarget({ x: 20, y: 10 });
  h.frame(1, -5); assert.ok(h.motion.position.x > 0); assert.equal(h.motion.active, true);
  h.frame(1000); assert.deepEqual(h.motion.position, { x: 20, y: 10 });
  assert.equal(h.motion.active, false); assert.equal(h.queued, 0);
});

test('invalid coordinates or parameters cannot poison a running camera, and exposed positions are copies', () => {
  const h = harness(); h.motion.setTarget({ x: 2, y: 4 });
  assert.throws(() => h.motion.setTarget({ x: NaN, y: 1 }), TypeError);
  assert.throws(() => h.motion.setTarget({ x: 9, y: 1 }, { extent: { width: 0, height: 10 } }), RangeError);
  assert.throws(() => h.motion.setTarget({ x: 9, y: 1 }, { scale: { x: -1, y: 1 } }), RangeError);
  assert.throws(() => h.motion.setTarget({ x: 9, y: 1 }, { timeConstant: 0 }), RangeError);
  const exposed = h.motion.position; exposed.x = 900;
  const target = h.motion.target; target.y = 900;
  assert.deepEqual(h.motion.position, { x: 0, y: 0 });
  assert.deepEqual(h.motion.target, { x: 2, y: 4 });
  h.finish(); assert.deepEqual(h.motion.position, { x: 2, y: 4 });
});
