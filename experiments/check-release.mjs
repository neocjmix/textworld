// Offline acceptance checks for the paired release fixtures. Keep failed runs
// as evidence. The optional 1,000-participant diagnostic does not set the cap.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = process.argv[2];
if (!directory) throw Error('Usage: node experiments/check-release.mjs DIRECTORY');
async function sample(name) {
  return JSON.parse(await readFile(resolve(directory, name + '.json'), 'utf8'));
}
function atMost(value, limit, label) {
  assert.ok(Number.isFinite(value) && value <= limit, label + ' = ' + value + ' (limit ' + limit + ')');
}

let releaseDigest;
for (const name of ['after-300-spread', 'after-300-plaza', 'hour-300']) {
  const run = await sample(name);
  assert.match(run.sourceDigest, /^[a-f0-9]{64}$/);
  releaseDigest ??= run.sourceDigest;
  assert.equal(run.sourceDigest, releaseDigest);
  assert.equal(run.peerCount, 300);
  assert.equal(run.liveClock, true);
  assert.equal(run.writers, 6);
  assert.equal(run.walkers, 24);
  assert.equal(run.seconds, name === 'hour-300' ? 3600 : 360);
  assert.ok(run.offeredSeconds >= run.seconds - 0.01);
  assert.equal(run.setupErrors, 0);
  assert.ok(run.sent > 0 && run.sent === run.accepted);
  assert.deepEqual(run.errs, {});
  assert.equal(run.arrivals, Math.round(run.seconds / 4));
  for (const key of ['unexpectedCloses', 'pendingAfterDrain', 'revisionGaps', 'revisionRegressions', 'basisMismatches']) {
    assert.equal(run[key], 0, name + ': ' + key);
  }
  assert.ok(run.otherDecodeCount > 0 && run.topologyPatches > 0 && run.expiryCount > 0);
  atMost(run.scheduledAckP95Ms, 150, name + ' scheduled ACK p95 (ms)');
  atMost(run.otherDecodeP95Ms, 150, name + ' remote decode p95 (ms)');
  atMost(run.readyP95Ms, 100, name + ' ready p95 (ms)');
  atMost(run.rejoinP95Ms, 1000, name + ' rejoin p95 (ms)');
  if (name === 'hour-300') {
    assert.ok(run.audits.sameRevision + run.audits.advancedOnRead >= 200);
    assert.deepEqual(run.audits.differences, {});
    atMost(run.expiryAgeP95Ms, 200000, 'expiry age p95 (ms)');
    assert.ok(run.quiet.seconds >= 480);
    for (const key of ['ink', 'historyRows', 'operationRows']) assert.equal(run.quiet[key], 0, key);
  }
  console.log('PASS', name);
}

const surge = await sample('surge-300');
assert.equal(surge.sourceDigest, releaseDigest);
assert.ok(surge.accepted > 0 && surge.errs.WORLD_BUSY > 0);
assert.equal(surge.sent, surge.accepted + surge.errs.WORLD_BUSY);
assert.deepEqual(Object.keys(surge.errs), ['WORLD_BUSY']);
assert.equal(surge.unexpectedCloses, 0);
assert.equal(surge.pendingAfterDrain, 0);
assert.deepEqual(surge.audits.differences, {});
const recovery = surge.slices.at(-1);
assert.equal(recovery.pending, 0);
atMost(recovery.ackP95, 150, 'post-surge ACK p95 (ms)');
console.log('PASS crowded surge and recovery');

const { results: [fixed] } = await sample('fixed-300');
assert.equal(fixed.sourceDigest, releaseDigest);
assert.equal(fixed.peers, 300);
assert.ok(fixed.remoteObserved > 0);
assert.equal(fixed.viewRecords, fixed.expectedViewRecords);
for (const key of ['uncorrelatedWriteAcks', 'missingVisibleWriteDeliveries', 'outsideViewWriteDeliveries', 'ownMissing', 'revisionGaps']) {
  assert.equal(fixed[key], 0, key);
}
console.log('PASS fixed-view observation contract');
