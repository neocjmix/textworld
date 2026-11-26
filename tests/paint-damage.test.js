import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaintDamage, visibleInstances } from '../public/paint-damage.js';

const item = (key, paint, x = 20, y = 20) => ({ key, paint, bounds: { x, y, width: 18, height: 28 } });
test('damage covers previous and new glyph/cursor footprints without invalidating unchanged pixels', () => {
  const damage = createPaintDamage();
  const plan = (items, key = 'camera') => damage.plan(items, key, 800, 600, 1.25);
  assert.equal(plan([item('a', '한')]).full, true);
  assert.equal(plan([item('a', '한')]).fraction, 0);
  const overwrite = plan([item('a', 'A')]);
  assert.equal(overwrite.full, false);
  assert(overwrite.includes(item('old', '').bounds));
  assert(overwrite.fraction < .01);
  const moved = plan([item('b', 'A', 300)]);
  assert(moved.includes(item('old', '').bounds));
  assert(moved.includes(item('new', '', 300).bounds));
  assert.equal(moved.includes(item('untouched', '', 600).bounds), false);
  assert(plan([]).includes(item('deleted', '', 300).bounds));
  assert.equal(plan([], 'new font/camera/viewport/world').full, true);
  damage.invalidate(); assert.equal(plan([], 'new font/camera/viewport/world').full, true);
});
test('dense damage is bounded, clips to viewport and aligns fractional DPR to physical pixels', () => {
  const damage = createPaintDamage(), size = [800, 600, 1.25];
  damage.plan([], 'a', ...size);
  let result = damage.plan([item('a', 1, -10, -10)], 'a', ...size);
  assert.equal(result.regions[0].x, 0); assert.equal(result.regions[0].y, 0);
  assert.equal(result.regions[0].width * 1.25 % 1, 0);
  result = damage.plan(Array.from({ length: 100 }, (_, i) => item(String(i), i, i * 5, i * 4)), 'a', ...size);
  assert.equal(result.full, true); assert.equal(result.fraction, 1);
});
test('wrapped instances preserve small-world repetition, negative coordinates and boundary leads', () => {
  assert.deepEqual([...visibleInstances(1, 16, -17, 33)], [-15, 1, 17, 33]);
  assert.deepEqual([...visibleInstances(15, 16, -1, 13)], [-1]);
  assert.deepEqual([...visibleInstances(15, 128, 10, 14)], []);
});
