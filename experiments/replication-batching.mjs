// Protocol experiment and deterministic workload model, NOT a Textworld server
// or a distributed throughput benchmark. No production endpoint is contacted.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';

const checks = [];
const check = (name, run) => { run(); checks.push(name); console.log(`PASS ${name}`); };
const bytes = value => Buffer.byteLength(value);

// A stream is one partition incarnation. No global sequence across the world.
// Production needs bounded durable replication before acknowledging acceptance.
class BatchLog {
  constructor(stream, { maxFrameBytes = 16_384, retainedFrames = 256 } = {}) {
    this.stream = stream;
    this.maxFrameBytes = maxFrameBytes;
    this.retainedFrames = retainedFrames;
    this.sequence = 0;
    this.publishedSequence = 0;
    this.pending = [];
    this.history = [];
  }
  encode(records) {
    return `{"stream":${JSON.stringify(this.stream)},"from":${records[0].seq},"to":${records.at(-1).seq},"events":[${records.map(r => r.json).join(',')}]}`;
  }
  append(value) {
    const event = { ...value, seq: this.sequence + 1 };
    const record = { seq: event.seq, json: JSON.stringify(event) };
    record.bytes = bytes(record.json);
    assert.ok(bytes(this.encode([record])) <= this.maxFrameBytes, 'reject oversize before acceptance');
    this.sequence = event.seq;
    this.pending.push(record);
    return event;
  }
  flush() {
    const frames = [];
    let records = [], recordBytes = 0;
    const finish = () => {
      if (!records.length) return;
      const wire = this.encode(records);
      assert.ok(bytes(wire) <= this.maxFrameBytes);
      frames.push({ from: records[0].seq, to: records.at(-1).seq, wire });
      records = []; recordBytes = 0;
    };
    for (const record of this.pending) {
      // Exact envelope length for the proposed range, without re-encoding the
      // entire growing array on every append. Each event JSON is built once.
      const header = bytes(`{"stream":${JSON.stringify(this.stream)},"from":${records[0]?.seq ?? record.seq},"to":${record.seq},"events":[]}`);
      if (records.length && header + recordBytes + record.bytes + records.length > this.maxFrameBytes) finish();
      records.push(record); recordBytes += record.bytes;
    }
    finish();
    this.pending = [];
    this.history.push(...frames);
    this.history = this.history.slice(-this.retainedFrames);
    if (frames.length) this.publishedSequence = frames.at(-1).to;
    return frames;
  }
  resume(after) {
    assert.ok(Number.isInteger(after) && after >= 0 && after <= this.publishedSequence);
    const oldest = this.history[0]?.from ?? this.publishedSequence + 1;
    if (after < oldest - 1) return { type: 'reset-required', oldest, latest: this.publishedSequence };
    return { type: 'replay', frames: this.history.filter(frame => frame.to > after) };
  }
}

class Receiver {
  constructor() { this.head = new Map(); this.events = []; }
  accept(wire) {
    const frame = JSON.parse(String(wire));
    assert.equal(frame.events.length, frame.to - frame.from + 1);
    frame.events.forEach((event, i) => assert.equal(event.seq, frame.from + i));
    const previous = this.head.get(frame.stream) ?? 0;
    if (frame.from > previous + 1) throw new Error('gap: request replay; do not advance');
    if (frame.to <= previous) return;
    this.events.push(...frame.events.filter(event => event.seq > previous));
    this.head.set(frame.stream, frame.to);
  }
}

const fixture = () => {
  const log = new BatchLog('region-1/owner-1', { maxFrameBytes: 512 });
  const events = Array.from({ length: 60 }, (_, i) => log.append({
    actor: i % 5, inputSeq: Math.floor(i / 5) + 1, cell: 0,
    text: ['한', '글', '中', 'A', '🙂'][i % 5], cursor: [i % 64, 0],
  }));
  return { log, events, frames: log.flush() };
};

check('lossless batches keep every same-cell overwrite and every cursor position', () => {
  const { events, frames } = fixture(), receiver = new Receiver();
  frames.forEach(frame => receiver.accept(frame.wire));
  assert.deepEqual(receiver.events, events);
  assert.ok(frames.length > 1);
  assert.ok(frames.every(frame => bytes(frame.wire) <= 512));
});
check('duplicate and overlapping replay does not apply an event twice', () => {
  const { events, frames, log } = fixture(), receiver = new Receiver();
  receiver.accept(frames[0].wire);
  log.resume(frames[0].to - 1).frames.forEach(frame => receiver.accept(frame.wire));
  frames.forEach(frame => receiver.accept(frame.wire));
  assert.deepEqual(receiver.events, events);
});
check('a missing frame is detected; replay recovers all events without skipping', () => {
  const { events, frames, log } = fixture(), receiver = new Receiver();
  receiver.accept(frames[0].wire);
  assert.throws(() => receiver.accept(frames[2].wire), /gap/);
  assert.equal(receiver.head.get(log.stream), frames[0].to);
  log.resume(frames[0].to).frames.forEach(frame => receiver.accept(frame.wire));
  assert.deepEqual(receiver.events, events);
});
check('bounded history reports a gap explicitly instead of silently claiming complete delivery', () => {
  const log = new BatchLog('short', { retainedFrames: 2 });
  log.append({ value: 0 });
  assert.deepEqual(log.resume(0), { type: 'replay', frames: [] }, 'unpublished records are pending, not a lost history');
  log.flush();
  for (let i = 1; i < 5; i++) { log.append({ value: i }); log.flush(); }
  assert.equal(log.history.length, 2);
  assert.equal(log.resume(0).type, 'reset-required');
  assert.equal(log.resume(3).type, 'replay');
});
check('different partitions can be interleaved without a global ordering barrier', () => {
  const a = new BatchLog('a/1'), b = new BatchLog('b/1'), receiver = new Receiver();
  a.append({ text: '가' }); b.append({ text: '나' });
  receiver.accept(b.flush()[0].wire); receiver.accept(a.flush()[0].wire);
  assert.deepEqual([...receiver.head.entries()].sort(), [['a/1', 1], ['b/1', 1]]);
});
check('latest-state coalescing is different from lossless batching', () => {
  const events = [{ cell: 0, value: '가' }, { cell: 0, value: '나' }, { cell: 1, value: 'B' }];
  const latest = new Map(events.map(event => [event.cell, event]));
  assert.equal(latest.size, 2);
  assert.equal(events.length, 3);
  assert.equal(latest.get(0).value, '나');
  // Same final cells, but the first accepted write is absent. This must not be
  // described as delivering all events, and is not the selected baseline.
});

async function socketExperiment() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const sockets = [], receivers = [new Receiver(), new Receiver()];
  const errors = [];
  try {
    for (const receiver of receivers) {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
      sockets.push(socket);
      socket.on('message', wire => { try { receiver.accept(wire); } catch (error) { errors.push(error.message); } });
      await once(socket, 'open');
    }
    const log = new BatchLog('socket/1');
    const expected = [], latency = [], observedFrames = [];
    const started = performance.now();
    // Bursts arrive before each 50 ms observation tick. The input path does
    // not wait for subscriber ACKs. This is NOT an admission/durability test.
    for (let tick = 0; tick < 4; tick++) {
      for (let i = 0; i < 32; i++) expected.push(log.append({ actor: i, cell: 0, text: '한', cursor: [tick, i], acceptedAt: performance.now() - started }));
      await new Promise(resolve => setTimeout(resolve, 50));
      for (const frame of log.flush()) {
        observedFrames.push(frame);
        for (const event of JSON.parse(frame.wire).events) latency.push(performance.now() - started - event.acceptedAt);
        for (const socket of server.clients) socket.send(frame.wire);
      }
    }
    const deadline = performance.now() + 2_000;
    while (receivers.some(receiver => receiver.events.length !== expected.length) && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(errors, []);
    receivers.forEach(receiver => assert.deepEqual(receiver.events, expected));
    checks.push('two real loopback WebSocket clients receive all 128 accepted records in batches');
    console.log(`PASS ${checks.at(-1)}`);
    latency.sort((a, b) => a - b);
    return { clients: 2, recordsPerClient: expected.length, receivedPerClient: receivers.map(r => r.events.length),
      sharedFrames: observedFrames.length, frameDeliveries: observedFrames.length * 2,
      payloadBytesPerClient: observedFrames.reduce((sum, frame) => sum + bytes(frame.wire), 0),
      tickMs: 50, acceptToFlushP95Ms: latency[Math.ceil(latency.length * 0.95) - 1],
      errors, note: 'Local transport check, not application ACK latency, browser rendering or a capacity measurement.' };
  } finally {
    sockets.forEach(socket => socket.terminate());
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

// All viewers have the same bounded view in this work model. Different AOIs,
// TLS, admission, clipping, compression, control messages and initial snapshots
// are excluded. Byte counts are exact for this illustrative JSON schema only.
function workload({ viewers, active, rate = 2, durationMs = 2_000, tickMs = 50 }) {
  const events = [], ticks = new Map();
  for (let actor = 0; actor < active; actor++) {
    for (let j = 0; j < durationMs / 1_000 * rate; j++) {
      const at = (j + actor / active) * 1_000 / rate;
      events.push({ at, actor, inputSeq: j + 1, cell: (actor * 17 + j) % 1_920, text: '한', cursor: [(actor * 17 + j + 2) % 80, actor % 24] });
    }
  }
  events.sort((a, b) => a.at - b.at || a.actor - b.actor);
  for (const event of events) {
    const tick = Math.floor(event.at / tickMs);
    if (!ticks.has(tick)) ticks.set(tick, []);
    ticks.get(tick).push(event);
  }
  const log = new BatchLog('region/1'), expected = [], receiver = new Receiver();
  let singleBytes = 0, batchBytes = 0, batchFrames = 0, largestFrame = 0;
  for (const entries of ticks.values()) {
    for (const event of entries) {
      const accepted = log.append(event); expected.push(accepted);
      singleBytes += bytes(JSON.stringify({ stream: log.stream, from: accepted.seq, to: accepted.seq, events: [accepted] }));
    }
    for (const frame of log.flush()) {
      receiver.accept(frame.wire);
      batchBytes += bytes(frame.wire); batchFrames++;
      largestFrame = Math.max(largestFrame, bytes(frame.wire));
    }
  }
  assert.deepEqual(receiver.events, expected);
  return { viewers, active, actionsPerActiveSecond: rate, durationMs, tickMs,
    acceptedRecords: expected.length, verifiedRecordsPerReceiver: receiver.events.length,
    immediate: { sharedFrames: events.length, frameDeliveries: viewers * events.length, applicationBytes: viewers * singleBytes },
    batched: { sharedFrames: batchFrames, frameDeliveries: viewers * batchFrames, applicationBytes: viewers * batchBytes,
      nonemptyTicks: ticks.size, logicalTickDeliveries: viewers * ticks.size, largestFrameBytes: largestFrame },
    eventPayloadCopies: viewers * events.length };
}

const transport = await socketExperiment();
const fixedWriters = [100, 1_000, 10_000].map(viewers => workload({ viewers, active: 100 }));
const allWriters = [100, 1_000, 10_000].map(viewers => workload({ viewers, active: viewers }));
check('fixed writer count scales deliveries and bytes linearly with viewers in this model', () => {
  assert.equal(fixedWriters[2].batched.applicationBytes, fixedWriters[0].batched.applicationBytes * 100);
  assert.equal(fixedWriters[2].batched.frameDeliveries, fixedWriters[0].batched.frameDeliveries * 100);
});
check('batching retains all records; growing all-writer hotspots still grow event bytes per viewer', () => {
  assert.equal(allWriters[2].eventPayloadCopies, allWriters[0].eventPayloadCopies * 10_000);
  assert.ok(allWriters[2].batched.sharedFrames > allWriters[2].batched.nonemptyTicks, 'byte cap may split one logical tick into several frames');
});
const report = { at: new Date().toISOString(), kind: 'lossless batching protocol experiment + deterministic work model',
  passed: checks.length, checks, transport, fixedWriters, allWriters,
  assumptions: ['same bounded view for every receiver', 'all accepted observable records retained within each batch; no coalescing',
    '16 KiB application-frame cap; no whole-world sequence', '50 ms batching; no dependency on reader ACK for input processing'],
  limitations: ['not the production Textworld protocol or a distributed server', 'only two loopback WebSocket clients were actually connected',
    'large viewer counts multiply model bytes; they are NOT connected load-test users', 'no TLS, kernel framing, compression, CJK slot semantics, resizing, expiry, durable log, admission or browser test',
    'bounded replay requires an explicit reset on history loss; infinite lossless offline catchup is not provided',
    'not a CPU benchmark or scaling-efficiency measurement'] };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/replication-batching.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: checks.length, transport, fixedWriters, allWriters }, null, 2));
