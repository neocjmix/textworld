import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthlyCost } from '../public/operating-cost-model.js';

const trial = JSON.parse(readFileSync(new URL('../docs/measurements/week-1000-2026-11-26.json', import.meta.url)));
const near = (actual, expected, tolerance = 1e-8) => assert.ok(
  Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test('at the calibration load, live traffic agrees with the 30-day conversion of the original trials', () => {
  for (const [plazaHours, name] of [[0, 'distributed'], [6, 'daily18hDistributed6hPlaza'], [24, 'plaza']]) {
    const estimate = monthlyCost({ concurrent: 1000, reduction: 1, peerDelivery: false, plazaHours });
    near(estimate.live, trial.weeklyProjection[name].usdByItem.webSocketEgress * 30 / 7, 0.01);
  }
});

test('the number of local recipient pairs grows by plaza and handles incomplete groups', () => {
  const options = { reduction: 1, peerDelivery: false, plazaHours: 24 };
  const excess = (concurrent, layout) => monthlyCost({ ...options, concurrent, layout }).live
    - monthlyCost({ ...options, concurrent, layout, plazaHours: 0 }).live;
  const one = excess(1000, 'single');
  near(excess(1000, 'neighborhoods'), one);
  near(excess(2000, 'neighborhoods'), 2 * one);
  near(excess(2000, 'single'), one * 500 * 499 / (250 * 249));
  near(excess(1004, 'neighborhoods'), one);
  near(excess(1500, 'neighborhoods'), one * (1 + 125 * 124 / (250 * 249)));
});

test('compression and paid relay savings affect live delivery only; time and visits use all 30 days', () => {
  const full = monthlyCost({ concurrent: 1000, reduction: 4, peerDelivery: false });
  const compact = monthlyCost({ concurrent: 1000, reduction: 8, peerDelivery: false });
  const shared = monthlyCost({ concurrent: 1000 });
  near(compact.live * 2, full.live);
  assert.ok(shared.live < compact.live);
  near(full.assets, shared.assets);
  near(full.server, shared.server);
  near(shared.total, shared.server + shared.assets + shared.live);
  assert.equal(shared.userHours, 720000);
  assert.equal(shared.visits, 2160000);
  near(shared.perThousandHours, shared.total / 720);
  near(shared.perThousandVisits, shared.total / 2160);
});

test('an empty world has only idle usage and an undefined per-user cost', () => {
  const zero = monthlyCost({ concurrent: 0 });
  near(zero.total, 1.2);
  near(zero.live + zero.assets, 0);
  assert.equal(zero.perThousandHours, null);
  assert.equal(zero.perThousandVisits, null);
  assert.throws(() => monthlyCost({ concurrent: -1 }), RangeError);
  assert.throws(() => monthlyCost({ concurrent: 1000, reduction: 0 }), RangeError);
  assert.throws(() => monthlyCost({ concurrent: NaN }), RangeError);
  assert.throws(() => monthlyCost({ concurrent: 1000, layout: 'unknown' }), TypeError);
});
