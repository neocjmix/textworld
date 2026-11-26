import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHistogram } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { ObservationAudit } from './observation-audit.mjs';
import { randomSource as random } from './playtest/scenario.mjs';
import { decodeWire } from '../shared/wire.js';

// Loopback-only, open-loop release workload. The target revision may be a separate checkout.
const [peerArg, durationArg, plazaArg, filename] = process.argv.slice(2);
const count = Number(peerArg),
  seconds = Number(durationArg),
  plazaFraction = Number(plazaArg);
if (
  !Number.isInteger(count) ||
  count < 10 ||
  count > 1000 ||
  !Number.isInteger(seconds) ||
  seconds < 10 ||
  seconds > 3600 ||
  !Number.isFinite(plazaFraction) ||
  plazaFraction < 0 ||
  plazaFraction > 1 ||
  !filename
) {
  throw Error(
    'Usage: node experiments/release-capacity.mjs PEERS(10..1000) SECONDS(10..3600) PLAZA_FRACTION(0..1) OUTPUT.json'
  );
}
const readerStride = seconds > 900 ? 16 : 1;
const quietSeconds = Number(process.env.CAPACITY_QUIET_SECONDS || 0);
if (!Number.isInteger(quietSeconds) || quietSeconds < 0 || quietSeconds > 600) throw Error('Invalid quiet period');
const writers = Number(process.env.CAPACITY_WRITERS ?? Math.max(1, Math.round(count * 0.02))),
  walkers = Math.round(count * 0.08);
if (!Number.isSafeInteger(writers) || writers < 1 || writers + walkers >= count) throw Error('Invalid writer count');
const surge = process.env.CAPACITY_SURGE === '1';
const q = (samples, fraction) => {
  const values = [...samples].sort((a, b) => a - b);
  return values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
};
const int = (rng, n) => Math.floor(rng() * n);
function rolesAndPositions(hotFraction) {
  const rng = random(147741),
    order = random(299),
    hot = new Set();
  const people = [];
  for (const [first, last] of [
    [0, writers],
    [writers, writers + walkers],
    [writers + walkers, count],
  ]) {
    const indices = Array.from({ length: last - first }, (_, index) => index + first);
    for (let j = indices.length - 1; j > 0; j--) {
      const k = int(order, j + 1);
      [indices[j], indices[k]] = [indices[k], indices[j]];
    }
    for (const i of indices.slice(0, Math.round(indices.length * hotFraction))) hot.add(i);
  }
  for (let i = 0; i < count; i++) {
    rng();
    const onPlaza = hot.has(i);
    const ux = int(rng, 512),
      uy = int(rng, 256),
      hx = 240 + int(rng, 33),
      hy = 120 + int(rng, 17);
    people.push({
      i,
      x: onPlaza ? hx : ux,
      y: onPlaza ? hy : uy,
      hot: onPlaza,
      view: i % 4 === 0 ? { cols: 150, rows: 50 } : { cols: 52, rows: 40 },
    });
  }
  return people;
}
function workload(seconds) {
  const rng = random(6669),
    events = [],
    total = seconds * 1000;
  for (let i = 0; i < writers; i++) {
    for (let t = rng() * 333, n = 0; t < total; t += (1000 / 3) * (0.72 + 0.56 * rng()), n++)
      events.push({
        t,
        i,
        action: {
          kind: 'type',
          text: n % 12 === 11 ? '\n' : n % 5 === 4 ? ' ' : ['한', '글', 'a', '中', '🙂', '가'][n % 6],
        },
      });
  }
  for (let i = writers; i < writers + walkers; i++) {
    for (let t = -10000 + rng() * 10000; t < total; t += 10000 * (0.85 + 0.3 * rng())) {
      const dx = rng() < 0.5 ? 2 : -2,
        dy = int(rng, 3) - 1;
      for (let k = 0; k < 5; k++) {
        const time = t + k * 50;
        if (time >= 0 && time < total)
          events.push({ t: time, i, action: { kind: 'move', dx, dy, newOrigin: true } });
      }
    }
  }
  let arrival = 0;
  for (let t = 600; t < total; t += 1200000 / count) {
    events.push({ t, i: writers + walkers + (arrival++ % (count - writers - walkers)), replace: true });
  }
  const scheduled = surge ? events.filter(e => e.i >= writers || e.i < Math.max(1, Math.round(count*.02))
    || (e.t >= total/3 && e.t < total*2/3)) : events;
  return scheduled.sort((a, b) => a.t - b.t);
}
async function sample(label, hotFraction, liveClock, seconds) {
  const server = fork(
    fileURLToPath(new URL('./capacity.mjs', import.meta.url)),
    ['--server', JSON.stringify({ liveClock, aged: true, layout: 'uniform', maxParticipants: count })],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
  );
  function ipc(kind) {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timeout);
        server.off('exit', exit);
        server.off('message', listen);
      };
      const listen = (m) => {
        if (m.kind === kind) {
          done();
          resolve(m);
        }
      };
      const exit = (c) => {
        done();
        reject(Error('server exit ' + c));
      };
      const timeout = setTimeout(() => {
        done();
        reject(Error('server timeout ' + kind));
      }, 60000);
      server.on('message', listen);
      server.once('exit', exit);
    });
  }
  const authorIds = new Set(),
    slices = [];
  const sockets = new Map(),
    people = rolesAndPositions(hotFraction),
    all = [],
    pending = new Map(),
    sentWrites = new Map(),
    errs = {};
  const acks = [],
    sendLags = [],
    offerAcks = [],
    churnTimes = [];
  let recording = false,
    bytes = 0,
    baseSeq = Infinity,
    expectedCloses = 0,
    unexpectedCloses = 0,
    gaps = 0,
    regressions = 0,
    topologyPatches = 0,
    basisMismatches = 0,
    resets = 0,
    wireRecords = 0,
    arrivals = 0,
    sent = 0,
    accepted = 0;
  let setupError = 0,
    placementRetries = 0,
    bytesNewViews = 0;
  const audits = {sameRevision:0, advancedOnRead:0, differences:{}};
  const auditSlots = new Set(seconds > 900 || surge ? [writers+walkers, Math.floor(count/3), Math.floor(2*count/3), count-1] : []);
  const clock = () => performance.now();
  const ready = await ipc('ready');
  async function connect(i) {
    const p = people[i],
      ws = new WebSocket('ws://127.0.0.1:' + ready.port + '/ws', {
        localAddress: '127.0.' + Math.floor(i / 250) + '.' + ((i % 250) + 2),
        handshakeTimeout: 10000,
      });
    const c = { ws, i, seq: 0, epoch: 1, connected: false, seen: new Map() };
    if (auditSlots.has(i)) c.audit = new ObservationAudit(audits);
    all.push(c);
    sockets.set(i, c);
    const joined = Promise.withResolvers();
    const timer = setTimeout(() => joined.reject(Error('connection setup timeout ' + i)), 15000);
    let retryTimer;
    const place = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', id: 'place',
        sequence: ++c.seq, epoch: c.epoch, action: { kind: 'goto', x: p.x, y: p.y, newOrigin: true } }));
    };
    ws.on('error', (e) => {
      if (!c.connected) joined.reject(e);
      else if (recording) errs[e.code || 'transport'] = (errs[e.code || 'transport'] || 0) + 1;
    });
    ws.on('close', () => {
      if (!c.connected) joined.reject(Error('connection closed before placement ' + i));
      if (recording) {
        if (c.replaced) expectedCloses++;
        else unexpectedCloses++;
      }
    });
    ws.on('message', (data) => {
      if (recording) bytes += data.length;
      const envelope = decodeWire(JSON.parse(data));
      for (const m of envelope.type === 'batch' ? envelope.messages : [envelope]) {
        c.audit?.receive(m);
        if (m.type === 'snapshot') {
          if (recording && m.basis) {
            topologyPatches++;
            if (m.basis.epoch !== c.epoch || m.basis.revision !== c.rev) basisMismatches++;
          }
          c.epoch = m.world.epoch;
          c.rev = m.viewRevision;
          if (i < writers) authorIds.add(m.selfId);
          if (!c.hello) {
            c.hello = true;
            if (recording) bytesNewViews += data.length;
            ws.send(JSON.stringify({ type: 'hello', batchVersion: 1, wireVersion: process.env.CAPACITY_COMPACT === '0' ? 0 : 1, topologyDelta: 1, view: p.view }));
            place();
          } else if (recording) resets++;
        } else if (m.type === 'view') {
          const o = m.observation;
          if (recording) {
            wireRecords++;
            if (!o.reset && c.epoch === m.world.epoch && c.rev !== undefined && o.revision > c.rev + 1) gaps++;
            if (c.epoch === m.world.epoch && c.rev !== undefined && o.revision < c.rev) regressions++;
            if (o.reset) resets++;
            if (
              i >= writers + walkers &&
              i % readerStride === 0 &&
              c.connected &&
              o.partial &&
              !o.reset &&
              o.peers?.some((p) => authorIds.has(p.id))
            ) {
              for (const cell of o.cells || [])
                if (cell.version > baseSeq && cell.text && !c.seen.has(cell.version))
                  c.seen.set(cell.version, clock());
            }
          }
          c.rev = o.revision;
          c.epoch = m.world.epoch;
        } else if (m.type === 'ack' && m.id === 'place') {
          c.connected = true;
          clearTimeout(timer);
          joined.resolve();
        } else if (m.type === 'ack') {
          const input = pending.get(m.id);
          if (!input) continue;
          pending.delete(m.id);
          accepted++;
          const at = clock();
          acks.push(at - input.at);
          offerAcks.push(at - input.due);
          if (input.kind === 'type' && Number.isSafeInteger(m.seq)) sentWrites.set(m.seq, { i, at: input.at });
        } else if (m.type === 'error') {
          if (m.id === 'place' && m.status === 429) {
            placementRetries++;
            retryTimer = setTimeout(place, Math.max(100, m.retryAfterMs || 250) + i % 61);
            continue;
          }
          if (recording) errs[m.code] = (errs[m.code] || 0) + 1;
          else setupError++;
          if (m.id === 'place') joined.reject(Error(m.code + ' for ' + i));
          if (m.id) pending.delete(m.id);
        }
      }
    });
    try {
      await joined.promise;
    } catch (error) {
      ws.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(retryTimer);
    }
  }
  try {
    const joinStart = clock();
    for (let i = 0; i < count; i += 8) await Promise.all(people.slice(i, i + 8).map((p) => connect(p.i)));
    const setupSecs = (clock() - joinStart) / 1e3;
    await sleep(700);
    const health = await (await fetch('http://127.0.0.1:' + ready.port + '/health')).json();
    if (health.peers !== count) throw Error('did not establish ' + count + ' connections ' + health.peers);
    console.log(label, 'connected', health.peers, 'setupSec', setupSecs.toFixed(2), 'world', health.world);
    const capacityCheck = await new Promise((resolve, reject) => {
      const probe = new WebSocket('ws://127.0.0.1:' + ready.port + '/ws', { localAddress: '127.127.127.2', handshakeTimeout: 5000 });
      probe.on('error', reject);
      probe.once('open', () => { probe.terminate(); reject(Error('capacity admitted one participant too many')); });
      probe.once('unexpected-response', (_request, response) => {
        const result = { connected: health.peers, limit: health.capacity, excessStatus: response.statusCode,
          retryAfterSeconds: Number(response.headers['retry-after']) };
        response.resume();
        if (result.excessStatus !== 503 || !(result.retryAfterSeconds > 0)) reject(Error('capacity refusal is not retryable: ' + JSON.stringify(result)));
        else resolve(result);
        probe.terminate();
      });
    });
    const started = ipc('started');
    server.send({ kind: 'start' });
    baseSeq = (await started).seq;
    const events = workload(seconds),
      churn = [];
    const start = clock();
    recording = true;
    let segmentStart = start,
      segmentBytes = 0,
      segmentAcks = 0;
    for (const evt of events) {
      const due = start + evt.t,
        dt = due - clock();
      if (dt >= 1) await sleep(dt);
      const now = clock();
      if (now - segmentStart >= 30000) {
        const interval = {
          elapsed: Math.round((now - start) / 1000),
          bytesPerSecond: ((bytes - segmentBytes) * 1000) / (now - segmentStart),
          ackP95: q(acks.slice(segmentAcks), 0.95),
          pending: pending.size,
          cumulativeSent: sent, cumulativeAccepted: accepted, cumulativeBusy: errs.WORLD_BUSY || 0,
          ...(auditSlots.size ? { audits: { sameRevision: audits.sameRevision, advancedOnRead: audits.advancedOnRead,
            differences: { ...audits.differences } }, unexpectedCloses, revisionGaps: gaps, basisMismatches } : {}),
        };
        if (slices.length % 2 === 1) for (const slot of auditSlots) {
          const observer = sockets.get(slot);
          if (!observer?.connected || observer.replaced || observer.ws.readyState !== WebSocket.OPEN) continue;
          observer.audit.requested = true;
          observer.ws.send(JSON.stringify({type:'sync'}));
        }
        slices.push(interval);
        console.log(label, 'slice', JSON.stringify(interval));
        segmentBytes = bytes;
        segmentAcks = acks.length;
        segmentStart = now;
      }
      const c = sockets.get(evt.i);
      if (evt.replace) {
        c.replaced = true;
        const released = c.ws.readyState === WebSocket.CLOSED ? Promise.resolve() : once(c.ws, 'close');
        c.ws.close();
        const t = clock();
        churn.push(
          released
            .then(() => connect(evt.i))
            .then(() => {
              arrivals++;
              churnTimes.push(clock() - t);
            })
            .catch((e) => {
              errs['rejoin_' + e.message] = (errs['rejoin_' + e.message] || 0) + 1;
            })
        );
      } else {
        const seq = ++c.seq,
          id = evt.i + ':' + seq,
          at = clock();
        sent++;
        sendLags.push(at - due);
        pending.set(id, { at, due, kind: evt.action.kind });
        c.ws.send(JSON.stringify({ type: 'input', id, sequence: seq, epoch: c.epoch, action: evt.action }));
      }
    }
    await sleep(Math.max(0, start + seconds * 1000 - clock()));
    const endOffer = clock() - start,
      pendingAtEnd = pending.size,
      offeredBytes = bytes;
    await Promise.all(churn);
    for (let k = 0; k < 200 && pending.size; k++) await sleep(20);
    await sleep(220);
    const reported = ipc('finished');
    server.send({ kind: 'finish' });
    const m = await reported;
    recording = false;
    const elapsedMs = clock() - start;
    const remote = createHistogram();
    for (const c of all)
      for (const [version, viewAt] of c.seen) {
        const write = sentWrites.get(version);
        if (write && write.i !== c.i) remote.record(Math.max(1, Math.round((viewAt - write.at) * 1000)));
      }
    const metric = (k) => m.metrics[k] || {};
    const result = {
      revision: process.env.CAPACITY_REVISION,
      sourceDigest: ready.sourceDigest,
      runtime: ready.runtime,
      profiled: !!process.env.CAPACITY_PROFILE,
      label,
      hotFraction,
      liveClock,
      alignedClock: process.env.CAPACITY_ALIGNED_CLOCK === '1',
      slices,
      baseline: '6000 individual glyphs aged 0-180 seconds, 75% fullwidth, 8% occupied',
      seconds,
      peerCount: health.peers,
      capacityCheck,
      writers,
      walkers,
      staticReaders: count - writers - walkers,
      hotUsers: people.filter((p) => p.hot).length,
      hotWriters: people.slice(0, writers).filter((p) => p.hot).length,
      hotWalkers: people.slice(writers, writers + walkers).filter((p) => p.hot).length,
      setupSecs,
      setupErrors: setupError,
      placementRetries,
      worldStart: health.world,
      worldEnd: m.world,
      inkEnd: m.ink,
      offeredSeconds: endOffer / 1e3,
      elapsedSeconds: elapsedMs / 1e3,
      arrivals,
      expectedCloses,
      unexpectedCloses,
      errs,
      sent,
      accepted,
      pendingAtEnd,
      pendingAfterDrain: pending.size,
      receivedBytes: bytes,
      offeredBytes,
      initialSnapshotBytesDuringChurn: bytesNewViews,
      viewRecords: wireRecords,
      revisionGaps: gaps,
      revisionRegressions: regressions,
      topologyPatches,
      basisMismatches,
      audits,
      resets,
      bytesPerSecond: bytes / (m.elapsedMs / 1000),
      serverBytesPerSecond: (m.metrics['ws.wire_tx_bytes'] || metric('ws.tx_bytes')).sum / (m.elapsedMs / 1000),
      wireBytesMeasured: !!m.metrics['ws.wire_tx_bytes'],
      logicalBytesPerSecond: metric('ws.tx_bytes').sum / (m.elapsedMs / 1000),
      compression: process.env.CAPACITY_COMPRESSION === '1',
      compressionThreshold: Number(process.env.CAPACITY_COMPRESSION_THRESHOLD || 1024),
      actionRate: Number(process.env.CAPACITY_ACTION_RATE || 240), actionBurst: Number(process.env.CAPACITY_ACTION_BURST || 192),
      compact: process.env.CAPACITY_COMPACT !== '0',
      ackP95Ms: q(acks, 0.95),
      scheduledAckP95Ms: q(offerAcks, 0.95),
      generatorP95Ms: q(sendLags, 0.95),
      maxGeneratorMs: sendLags.reduce((max, n) => Math.max(max, n), 0),
      rejoinP95Ms: q(churnTimes, 0.95),
      surge,
      readerStride,
      otherDecodeP99Ms: remote.count ? remote.percentile(99) / 1000 : null,
      ackP99Ms: q(acks, 0.99),
      rejoinP99Ms: q(churnTimes, 0.99),
      otherDecodeP95Ms: remote.count ? remote.percentile(95) / 1000 : null,
      otherDecodeCount: remote.count,
      readyP95Ms: m.readyP95Ms,
      readyCount: m.readyCount,
      expiryAgeP95Ms: m.expirationAgeP95Ms,
      expiryAgeMaxMs: m.expirationAgeMaxMs,
      metrics: Object.fromEntries(
        Object.entries(m.metrics)
          .filter(([name]) =>
            [
              'topology.ms',
              'topology.local_preserved',
              'topology.local_reset',
              'topology.slice_ms',
              'observer.ms',
              'presence.ms',
              'expiration.ms',
              'ws.slow_disconnects', 'overload.actions',
              'activity.peer_ms',
              'delivery.undelivered_events',
              'delivery.sync_requests',
              'ws.wire_tx_bytes', 'ws.tx_bytes', 'encoding.records', 'encoding.reused', 'encoding.compactViews',
            ].includes(name)
          )
          .map(([name, h]) => [name, { sum: h.sum, max: h.max, count: h.count, p95Upper: h.p95Upper }])
      ),
      serverCores: m.cpuMs / m.elapsedMs,
      meanRssGiB:
        m.storage
          .slice(1)
          .reduce(
            (sum, row, i) =>
              sum + ((row.rssBytes + m.storage[i].rssBytes) / 2) * (row.elapsedMs - m.storage[i].elapsedMs),
            0
          ) /
        (m.storage.at(-1).elapsedMs - m.storage[0].elapsedMs) /
        1024 ** 3,
      serverRssGiB: m.rssBytes / 1024 ** 3,
      eventLoopP99: m.eventLoopP99Ms,
      meanDispatchRecipients: metric('presence.recipients').mean,
      over100: metric('delivery.over_100ms').mean,
      peakBufferedBytes: metric('ws.buffered_bytes').max,
      expiryCount: m.expiredGlyphs,
      topologyGrowth: m.metrics['topology.growth']?.sum || 0,
      topologyShrink: m.metrics['topology.shrink']?.sum || 0,
      serveInitialMs: setupSecs * 1000,
      storage: m.storage,
      epochs: m.world.epoch - health.world.epoch,
    };
    if (quietSeconds) {
      await sleep(quietSeconds * 1000);
      const response = ipc('quiet');
      server.send({ kind: 'quiet' });
      result.quiet = { seconds: quietSeconds, ...(await response).sample };
    }
    await writeFile(filename, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    recording = false;
    for (const c of all) c.ws.removeAllListeners('message');
    if (server.connected) {
      const exited = once(server, 'exit');
      server.send({ kind: 'stop' });
      const timeout = setTimeout(() => server.kill('SIGKILL'), 9000);
      await exited;
      clearTimeout(timeout);
    }
    for (const c of all) c.ws.terminate();
  }
}
await sample(filename, plazaFraction, true, seconds);
