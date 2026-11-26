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

test('release estimates reproduce the sustained 300-person workload and both spatial endpoints', async () => {
  const { releaseCost, releaseProfile } = await import('../public/operating-cost-model.js');
  const { readFile } = await import('node:fs/promises');
  for (const [scenario, plazaHours, key, file] of [
    ['steady', 6, 'hour', 'hour-300'],
    ['mix', 0, 'spread', 'after-300-spread'],
    ['mix', 24, 'plaza', 'after-300-plaza'],
  ]) {
    const path = new URL('../docs/measurements/initial-release-2026-11-26/' + file + '.json', import.meta.url);
    const sample = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Math.abs(releaseProfile[key].bytesPerSecond - sample.serverBytesPerSecond) < 0.001);
    assert.ok(Math.abs(releaseProfile[key].cores - sample.serverCores) < 1e-6);
    assert.ok(Math.abs(releaseProfile[key].rssGiB - sample.meanRssGiB) < 1e-6);
    const result = releaseCost({ scenario, plazaHours });
    near(result.live, releaseProfile[key].bytesPerSecond * 2592000 / 1e9 * 0.05);
    near(result.memory, releaseProfile[key].rssGiB * 1024 ** 3 / 1e9 * 43200 * 0.000231);
    near(result.assets, result.visits * (releaseProfile.mapBytes + 0.2 * releaseProfile.fontBytes) / 1e9 * 0.05);
    near(result.week, result.total * 7 / 30);
    near(result.total, result.live + result.server + result.assets);
    near(result.unit, result.total * 1000 / (300 * 720));
  }
  const coldPage = new URL('../docs/measurements/initial-release-2026-11-26/public-assets-742a32f.json', import.meta.url);
  const { assets } = JSON.parse(await readFile(coldPage, 'utf8'));
  const bytes = Object.entries(assets);
  assert.equal(releaseProfile.mapBytes, bytes.filter(([path]) => !path.endsWith('.woff2')).reduce((sum, [, n]) => sum + n, 0));
  assert.equal(releaseProfile.fontBytes, bytes.filter(([path]) => path.endsWith('.woff2')).reduce((sum, [, n]) => sum + n, 0));
  const spread = releaseCost({ scenario: 'mix', plazaHours: 0 });
  const crowded = releaseCost({ scenario: 'mix', plazaHours: 24 });
  near(releaseCost({ scenario: 'mix', plazaHours: 6 }).total, 0.75 * spread.total + 0.25 * crowded.total);
  near(releaseCost({ sessionMinutes: 40 }).assets, releaseCost().assets / 2);
  assert.throws(() => releaseCost({ sessionMinutes: 0 }), RangeError);
  assert.throws(() => releaseCost({ coldFontShare: 1.01 }), RangeError);
});
