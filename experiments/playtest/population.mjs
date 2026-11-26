import { createHistogram } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { randomSource, roles } from './scenario.mjs';

const lines = [
  '여기에서 작은 글자를 따라 한 바퀴 걸어 봅니다. 옆줄에서는 무슨 일이 일어날까요?',
  '지금 보이는 글은 바람이 지나가듯 조금씩 옅어집니다. 저는 다음 줄로 내려갈게요.',
  '천천히 걸으면 같은 자리를 두 번 지나기도 해요. 만나면 옆에 한 글자 남겨 주세요.',
  '건너편에 다른 색 커서가 보여요. 여기서 잠시 쉬었다가 다음 길을 찾아가요.',
];
const names = { writers: '글쓴이', walkers: '산책자', readers: '독자' };
const zeroCounts = () => ({ writers: 0, walkers: 0, readers: 0 });

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
  const text = line.slice(actor.offset, actor.offset + 3);
  actor.offset += text.length;
  return { kind: 'type', text };
}

export class Population {
  constructor(port, plan, stop) {
    this.url = 'ws://127.0.0.1:' + port + '/ws';
    this.plan = plan;
    this.stop = stop;
    this.actors = new Set();
    this.random = randomSource(plan.seed);
    this.nextAdmission = 0;
    this.botMs = 0;
    this.latency = createHistogram();
    this.departures = {};
    this.stats = { attempts: 0, joined: 0, peak: 0, sent: 0, ack: 0, rejected: 0, unconfirmed: 0, rateLimited: 0,
      receivedBytes: 0, transportErrors: 0 };
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
      ackP95Ms: this.latency.count ? this.latency.percentile(95) / 1000 : null };
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
    const socket = new WebSocket(this.url, { handshakeTimeout: 4000 });
    const actor = { number, role, socket, random, born: now, expires: now + 1000 * (min + random() * (max - min)),
      ready: false, steps: 0, sequence: 0, due: now, line: number, offset: 0 };
    this.actors.add(actor);
    actor.closed = new Promise(resolve => socket.once('close', () => {
      clearTimeout(actor.forceClose);
      if (actor.pending) this.stats.unconfirmed++;
      this.botMs += performance.now() - actor.born;
      this.actors.delete(actor);
      const reason = actor.leaving || 'disconnected';
      this.departures[reason] = (this.departures[reason] || 0) + 1;
      resolve();
    }));
    socket.on('error', () => { this.stats.transportErrors++; });
    socket.on('unexpected-response', (_request, res) => {
      if (res.statusCode === 429) {
        this.stats.rateLimited++;
        const delay = Number(res.headers['retry-after']) || 1;
        this.nextAdmission = Math.max(this.nextAdmission, performance.now() + delay * 1000);
      }
      res.resume();
      this.retire(actor, 'admission-refused');
    });
    socket.on('message', raw => {
      this.stats.receivedBytes += raw.length;
      if (this.stats.receivedBytes >= this.plan.budget.receivedMiB * 1048576) this.stop('byte-budget');
      const message = JSON.parse(raw);
      for (const entry of message.type === 'batch' ? message.messages : [message]) this.receive(actor, entry);
    });
  }

  receive(a, m) {
    if (m.type === 'snapshot') {
      a.epoch = m.world.epoch;
      a.position = m.peers.find(p => p.id === m.selfId);
      if (!a.ready && !a.leaving) {
        a.ready = true;
        this.stats.joined++;
        this.stats.peak = Math.max(this.stats.peak, [...this.actors].filter(p => p.ready && !p.leaving).length);
        a.socket.send(JSON.stringify({ type: 'hello', name: names[a.role] + ' ' + a.number,
          view: { cols: 48, rows: 20 }, batchVersion: 1 }));
      }
    } else if (m.type === 'error') {
      if (m.status === 429) {
        this.stats.rateLimited++;
        a.due = Math.max(a.due, performance.now() + (m.retryAfterMs || 1000));
      }
      if (a.pending && m.id === a.pending.id) {
        this.stats.rejected++;
        a.pending = null;
      }
    } else if (m.type === 'ack' && a.pending && m.id === a.pending.id) {
      this.latency.record(Math.max(1, Math.round((performance.now() - a.pending.at) * 1000)));
      this.stats.ack++;
      a.position = m.cursor ?? a.position;
      a.pending = null;
    }
  }

  tick(now, phase) {
    if (this.busyMs(now) >= this.plan.budget.botMinutes * 60000) return this.stop('bot-minute-budget');
    const reserved = zeroCounts();
    for (const a of this.actors) {
      if (a.leaving) continue;
      if (now >= a.expires) this.retire(a, 'lifetime');
      else if (a.pending && now - a.pending.at >= 6000) this.retire(a, 'ack-timeout');
      else if (!a.ready && now - a.born >= 6000) this.retire(a, 'join-timeout');
      else reserved[a.role]++;
    }
    for (const a of this.actors) {
      if (a.leaving) continue;
      if (reserved[a.role] > phase[a.role]) {
        reserved[a.role]--;
        this.retire(a, 'target-reduced');
        continue;
      }
      if (!a.ready || a.pending || a.due > now) continue;
      const action = nextAction(a, phase.writing);
      if (!action) { a.due = Infinity; continue; }
      const id = String(++a.sequence);
      a.pending = { id, at: now };
      a.socket.send(JSON.stringify({ type: 'input', id, sequence: a.sequence, epoch: a.epoch, action }));
      this.stats.sent++;
      a.due = now + phase.actionIntervalMs * (.8 + .6 * a.random()) * (a.role === 'walkers' ? 1.6 : 1);
    }
    const missing = roles.find(role => reserved[role] < phase[role]);
    if (!missing || now < this.nextAdmission || this.actors.size >= phase.writers + phase.walkers + phase.readers) return;
    if (this.stats.attempts >= this.plan.budget.admissions) return this.stop('admission-budget');
    this.admit(missing, now);
    this.nextAdmission = now + 350;
  }

  async close() {
    const remaining = [...this.actors];
    for (const a of remaining) this.retire(a, 'end');
    await Promise.all(remaining.map(a => a.closed));
  }
}
