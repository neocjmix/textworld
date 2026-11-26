import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewDelivery } from '../server/view-delivery.js';

function fixture(frameBytes) {
  const sent = [];
  const metrics = [];
  const delivery = createViewDelivery({
    intervalMs: 50, frameBytes,
    write(socket, data, fragmentBytes) {
      sent.push({ socket, message: JSON.parse(data), bytes: Buffer.byteLength(data), fragmentBytes });
      return true;
    },
    record: (name, value) => metrics.push({ name, value })
  });
  return { delivery, sent, metrics };
}

test('batch byte cap accounts for Korean UTF-8 and preserves every event across frames', () => {
  const { delivery, sent, metrics } = fixture(140);
  const views = Array.from({ length: 17 }, (_, i) => ({ type: 'view', i, text: '한글' }));
  for (const view of views) delivery.enqueue(1, view, performance.now());
  delivery.flush(1);
  assert.deepEqual(sent.flatMap(({ message }) => message.messages), views);
  assert(sent.length > 1);
  assert(sent.every(({ bytes }) => bytes <= 140));
  assert.equal(metrics.filter(({ name }) => name === 'delivery.ready_ms').length, views.length);
});

test('one large view flushes preceding batch and requests fragmentation without splitting a logical observation', () => {
  const { delivery, sent } = fixture(140);
  const one = { type: 'view', text: '가' };
  const large = { type: 'view', text: '한'.repeat(100) };
  for (const view of [one, large, one]) delivery.enqueue(1, view, performance.now());
  delivery.flush(1);
  assert.deepEqual(sent.map(({ message }) => message.messages ?? message), [[one], large, [one]]);
  assert.equal(sent[1].fragmentBytes, 140);
});

test('an idle subscriber receives the queued views on the timer and closed subscribers release queued work', async () => {
  const { delivery, sent, metrics } = fixture(1024);
  const view = { type: 'view' };
  delivery.enqueue(1, view, performance.now());
  delivery.enqueue(2, view, performance.now());
  delivery.drop(1);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(sent.map(({socket}) => socket), [2]);
  assert.deepEqual(metrics.filter(m => m.name === 'delivery.undelivered_events').map(m => m.value), [1]);
});

test('a busy flush yields to input, while snapshot barriers, new events and departures preserve order', async () => {
  const sent = [], turns = [];
  let clock = 0;
  const delivery = createViewDelivery({ intervalMs: 5, sliceMs: 4, now: () => clock,
    record() {},
    write(socket, data) {
      clock += 5;
      sent.push({ socket, events: JSON.parse(data).messages });
      turns.push('send:' + socket);
      if (socket === 1) setImmediate(() => {
        turns.push('input');
        delivery.flush(2); // The snapshot barrier drains the old revision first.
        delivery.enqueue(2, { type: 'view', revision: 2 }, clock);
        delivery.drop(3);
      });
      return true;
    },
  });
  for (const socket of [1, 2, 3]) delivery.enqueue(socket, { type: 'view', revision: 1 }, clock);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(turns, ['send:1', 'input', 'send:2', 'send:2']);
  assert.deepEqual(sent, [
    { socket: 1, events: [{ type: 'view', revision: 1 }] },
    { socket: 2, events: [{ type: 'view', revision: 1 }] },
    { socket: 2, events: [{ type: 'view', revision: 2 }] },
  ]);
});
