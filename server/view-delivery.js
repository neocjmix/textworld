import { encodeView } from './encode-view.js';

// Limit time and bytes independently. A single large view (e.g. after a pan)
// stays one application message, split into ordinary WebSocket continuations.
const prefix = '{"type":"batch","messages":[';
const suffix = ']}';
const envelopeBytes = Buffer.byteLength(prefix + suffix);

export function createViewDelivery({ write, record, intervalMs = 50, frameBytes = 64 * 1024, now = () => performance.now() }) {
  const pending = new Map();
  let timer;

  function flush(socket) {
    const queue = pending.get(socket);
    if (!queue) return;
    pending.delete(socket);
    if (!pending.size) {
      clearTimeout(timer);
      timer = undefined;
    }
    const encoded = prefix + queue.parts.join(',') + suffix;
    if (write(socket, encoded)) {
      const ready = now();
      for (const start of queue.starts) reportDelay(ready - start);
      record('delivery.batch_events', queue.parts.length);
    } else record('delivery.undelivered_events', queue.parts.length);
  }

  function reportDelay(ms) {
    record('delivery.ready_ms', ms);
    record('delivery.over_100ms', Number(ms > 100));
  }

  function enqueue(socket, message, started) {
    const encoded = encodeView(message);
    const bytes = Buffer.byteLength(encoded);
    let queue = pending.get(socket);
    if (queue && queue.bytes + 1 + bytes > frameBytes) {
      flush(socket);
      queue = undefined;
    }
    if (bytes + envelopeBytes > frameBytes) {
      if (write(socket, encoded, frameBytes)) reportDelay(now() - started);
      else record('delivery.undelivered_events', 1);
      return;
    }
    if (!queue) {
      queue = { parts: [], starts: [], bytes: envelopeBytes };
      pending.set(socket, queue);
    }
    queue.bytes += bytes + Number(queue.parts.length > 0);
    queue.parts.push(encoded);
    queue.starts.push(started);
    if (!timer) {
      timer = setTimeout(() => {
        for (const client of pending.keys()) flush(client);
      }, intervalMs);
      timer.unref();
    }
  }

  function drop(socket) {
    const queue = pending.get(socket);
    if (queue) record('delivery.undelivered_events', queue.parts.length);
    pending.delete(socket);
    if (!pending.size) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return { enqueue, flush, drop };
}
