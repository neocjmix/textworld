import { createHistogram } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { randomSource, roles } from './scenario.mjs';
import { graphemes } from '../../shared/world.js';
import { decodeWire, WIRE_VERSION } from '../../shared/wire.js';

const lines = [
  '여기에서 작은 글자를 따라 한 바퀴 걸어 봅니다. 옆줄에서는 무슨 일이 일어날까요?',
  '지금 보이는 글은 바람이 지나가듯 조금씩 옅어집니다. 저는 다음 줄로 내려갈게요.',
  '천천히 걸으면 같은 자리를 두 번 지나기도 해요. 만나면 옆에 한 글자 남겨 주세요.',
  '건너편에 다른 색 커서가 보여요. 여기서 잠시 쉬었다가 다음 길을 찾아가요.',
].map(graphemes);
const names = { writers: '글쓴이', walkers: '산책자', readers: '독자' };
const zeroCounts = () => ({ writers: 0, walkers: 0, readers: 0 });

function pauseWeight(text) {
  if (text === '\n') return 4;
  if (/[.!?。！？]/u.test(text)) return 3;
  if (text === ' ') return 2.6;
  return 1;
}
// Keep the old three-grapheme writer's average output while shifting time
// from the middle of words to the boundaries between them.
const corpus = lines.flatMap(line => [...line, '\n']);
const meanWeight = corpus.reduce((sum, text) => sum + pauseWeight(text), 0) / corpus.length;
const jitter = (random, fraction) => 1 + (2 * random() - 1) * fraction;

function restAfter(actor, action, phase, spread) {
  let rest = phase.actionIntervalMs * 1.1;
  if (actor.role === 'walkers') rest *= 1.6;
  else if (actor.role === 'writers' && phase.writing === 'new-cells') {
    rest *= pauseWeight(action.text ?? '') / (3 * meanWeight);
  }
  return Math.max(100, rest * actor.pace * jitter(actor.random, spread));
}

function nextAction(actor, pattern) {
  if (actor.steps++ === 0) {
    return { kind: 'move', dx: actor.number % 23 - 11, dy: (actor.number * 7) % 19 - 9, newOrigin: true };
  }
  if (actor.role === 'readers') return null;
  if (actor.role === 'walkers') {
    return { kind: 'move', dx: actor.random() < .5 ? -2 : 2, dy: Math.floor(actor.random() * 3) - 1, newOrigin: true };
  }
  if (pattern === 'overwrite') {
    return actor.steps % 2 ? { kind: 'home' } : { kind: 'type', text: actor.random() < .5 ? '별' : '빛' };
  }
  const line = lines[actor.line % lines.length];
  if (actor.offset >= line.length) {
    actor.line++;
    actor.offset = 0;
    return { kind: 'type', text: '\n' };
  }
  return { kind: 'type', text: line[actor.offset++] };
}

export class Population {
  constructor(port, plan, stop, credential, wake) {
    this.url = 'ws://127.0.0.1:' + port + '/ws';
    this.headers = credential ? { authorization: 'Bearer ' + credential } : {};
    this.plan = plan;
    this.stop = stop;
    this.wake = wake;
    this.spread = plan.jitterRatio ?? .3;
    this.actors = new Set();
    this.random = randomSource(plan.seed);
    this.nextAdmission = 0;
    this.botMs = 0;
    this.latency = createHistogram();
    this.typingGaps = createHistogram();
    this.departures = {};
    this.stats = { attempts: 0, joined: 0, peak: 0, sent: 0, ack: 0, rejected: 0, unconfirmed: 0, rateLimited: 0,
      receivedBytes: 0, receivedWireBytes: 0, transportErrors: 0, writtenGraphemes: 0 };
  }

  counts() {
    const active = zeroCounts();
    for (const a of this.actors) if (a.ready && !a.leaving) active[a.role]++;
    return active;
  }

  busyMs(now) {
    let total = this.botMs;
    for (const a of this.actors) total += now - a.born;
    return total;
  }

  report() {
    return { ...this.stats, active: this.counts(), departures: { ...this.departures },
      botMinutes: this.busyMs(performance.now()) / 60000,
      ackP95Ms: this.latency.count ? this.latency.percentile(95) / 1000 : null,
      typingGapP50Ms: this.typingGaps.count ? this.typingGaps.percentile(50) / 1000 : null,
      typingGapP95Ms: this.typingGaps.count ? this.typingGaps.percentile(95) / 1000 : null };
  }

  retire(a, reason) {
    if (a.leaving) return;
    a.leaving = reason;
    if (a.socket.readyState === WebSocket.OPEN) a.socket.close(1000);
    else if (a.socket.readyState === WebSocket.CONNECTING) a.socket.terminate();
    a.forceClose = setTimeout(() => a.socket.terminate(), 750);
  }

  admit(role, now) {
    const number = ++this.stats.attempts;
    const random = randomSource(Math.floor(this.random() * 0x100000000));
    const [min, max] = this.plan.lifetimeSeconds;
    const socket = new WebSocket(this.url, { handshakeTimeout: 4000, headers: this.headers });
    // Count compressed WebSocket frames independently of the decoded safety
    // budget. The operator ingress is loopback, so this is hypothetical egress.
    socket.on('open', () => socket._socket.on('data', data => { this.stats.receivedWireBytes += data.length; }));
    const actor = { number, role, socket, random, born: now, expires: now + 1000 * (min + random() * (max - min)),
      pace: jitter(random, this.spread / 2), ready: false, steps: 0, sequence: 0, due: Infinity, line: number, offset: 0 };
    this.actors.add(actor);
    actor.closed = new Promise(resolve => socket.once('close', () => {
      clearTimeout(actor.forceClose);
      if (actor.pending) this.stats.unconfirmed++;
      this.botMs += performance.now() - actor.born;
      this.actors.delete(actor);
      const reason = actor.leaving || 'disconnected';
      this.departures[reason] = (this.departures[reason] || 0) + 1;
      resolve();
      this.wake();
    }));
    socket.on('error', () => { this.stats.transportErrors++; });
    socket.on('unexpected-response', (_request, res) => {
      if (res.statusCode === 429 || res.statusCode === 503) {
        if (res.statusCode === 429) this.stats.rateLimited++;
        const delay = Number(res.headers['retry-after']) || 1;
        this.nextAdmission = Math.max(this.nextAdmission, performance.now() + delay * 1000 + 350 * this.spread * random());
      }
      res.resume();
      this.retire(actor, 'admission-refused');
    });
    socket.on('message', raw => {
      this.stats.receivedBytes += raw.length;
      if (this.stats.receivedBytes >= this.plan.budget.receivedMiB * 1048576) this.stop('byte-budget');
      const message = decodeWire(JSON.parse(raw));
      for (const entry of message.type === 'batch' ? message.messages : [message]) this.receive(actor, entry);
    });
  }

  receive(a, m) {
    if (m.type === 'snapshot') {
      a.epoch = m.world.epoch;
      a.position = m.patch ? m.input.state.cursor : m.peers.find(p => p.id === m.selfId);
      if (!a.ready && !a.leaving) {
        a.ready = true;
        a.due = performance.now() + 250 * jitter(a.random, this.spread);
        this.stats.joined++;
        this.stats.peak = Math.max(this.stats.peak, [...this.actors].filter(p => p.ready && !p.leaving).length);
        a.socket.send(JSON.stringify({ type: 'hello', name: names[a.role] + ' ' + a.number,
          view: { cols: 48, rows: 20 }, batchVersion: 1, topologyDelta: 1, wireVersion: WIRE_VERSION }));
        this.wake();
      }
    } else if (m.type === 'error') {
      const now = performance.now();
      if (a.pending && m.id === a.pending.id) {
        this.stats.rejected++;
        a.due = Math.max(a.due, now + a.pending.rest);
        a.pending = null;
      }
      if (m.status === 429) {
        this.stats.rateLimited++;
        a.due = Math.max(a.due, now + (m.retryAfterMs || 1000) + 350 * this.spread * a.random());
      }
      this.wake();
    } else if (m.type === 'ack' && a.pending && m.id === a.pending.id) {
      const now = performance.now();
      this.latency.record(Math.max(1, Math.round((now - a.pending.at) * 1000)));
      this.stats.ack++;
      if (a.pending.typed) this.stats.writtenGraphemes++;
      a.due = Math.max(a.due, now + a.pending.rest);
      a.position = m.cursor ?? a.position;
      a.pending = null;
      this.wake();
    }
  }

  tick(now, phase) {
    const remaining = this.plan.budget.botMinutes * 60000 - this.busyMs(now);
    if (remaining <= 0) return this.stop('bot-minute-budget');
    let next = this.actors.size ? now + remaining / this.actors.size : Infinity;
    const reserved = zeroCounts();
    for (const a of this.actors) {
      if (a.leaving) continue;
      if (now >= a.expires) this.retire(a, 'lifetime');
      else if (now >= a.exitAt) this.retire(a, 'target-reduced');
      else if (a.pending && now - a.pending.at >= 6000) this.retire(a, 'ack-timeout');
      else if (!a.ready && now - a.born >= 6000) this.retire(a, 'join-timeout');
      else if (a.exitAt === undefined) reserved[a.role]++;
    }
    for (const a of this.actors) {
      if (a.leaving) continue;
      if (a.exitAt === undefined && reserved[a.role] > phase[a.role]) {
        reserved[a.role]--;
        a.exitAt = now + 2500 * this.spread * a.random();
      }
      next = Math.min(next, a.expires);
      if (a.exitAt !== undefined) { next = Math.min(next, a.exitAt); continue; }
      if (!a.ready) { next = Math.min(next, a.born + 6000); continue; }
      if (a.pending) { next = Math.min(next, a.pending.at + 6000); continue; }
      if (a.due > now) { next = Math.min(next, a.due); continue; }
      const action = nextAction(a, phase.writing);
      if (!action) { a.due = Infinity; continue; }
      const id = String(++a.sequence);
      const typed = action.kind === 'type' && action.text !== '\n';
      if (typed) {
        if (a.lastTyped !== undefined) this.typingGaps.record(Math.max(1, Math.round((now - a.lastTyped) * 1000)));
        a.lastTyped = now;
      }
      a.pending = { id, at: now, typed, rest: restAfter(a, action, phase, this.spread) };
      a.socket.send(JSON.stringify({ type: 'input', id, sequence: a.sequence, epoch: a.epoch, action }));
      this.stats.sent++;
      next = Math.min(next, now + 6000);
    }
    const missing = roles.find(role => reserved[role] < phase[role]);
    if (!missing || this.actors.size >= phase.writers + phase.walkers + phase.readers) return next;
    if (now < this.nextAdmission) return Math.min(next, this.nextAdmission);
    if (this.stats.attempts >= this.plan.budget.admissions) return this.stop('admission-budget');
    this.admit(missing, now);
    this.nextAdmission = now + 350 + 700 * this.spread * this.random();
    return Math.min(next, this.nextAdmission, now + remaining / this.actors.size);
  }

  async close() {
    const remaining = [...this.actors];
    for (const a of remaining) this.retire(a, 'end');
    await Promise.all(remaining.map(a => a.closed));
  }
}
