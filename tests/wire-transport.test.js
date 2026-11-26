import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createTextworld } from '../server/index.js';
import { decodeWire } from '../shared/wire.js';

for (const compressed of [false, true]) test(`wire accounting counts transmitted frames, compression=${compressed}`, async () => {
  const app = createTextworld({ storagePath: ':memory:', compression: true, now: () => 1_000_000 });
  let ws;
  try {
    for (let y = 23; y < 42; y++) app.world.applyWrite({ author: 'seed', id: String(y), epoch: 1,
      x: 32, y, text: '한글'.repeat(16) });
    const { port } = await app.listen(0, '127.0.0.1');
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: compressed });
    const [raw] = await once(ws, 'message');
    const snapshot = JSON.parse(raw);
    assert.equal(snapshot.type, 'snapshot'); assert(snapshot.cells.length > 800);
    assert.equal(ws.extensions.includes('permessage-deflate'), compressed);
    await new Promise(resolve => setTimeout(resolve, 30));
    const sum = name => app.measurements.pending.get(name)?.sum || 0;
    const wire = sum('ws.wire_tx_bytes'), logical = sum('ws.tx_bytes');
    assert(wire > 0 && logical > 0);
    assert.equal(app.playtestResources().publicWebSocketBytes, wire);
    if (compressed) assert(wire < logical * .3, `${wire} / ${logical}`);
    else assert(wire >= logical && wire < logical + 1000);
    const response = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', name: '한글', batchVersion: 1, wireVersion: 1, topologyDelta: 1 }));
    const [hello] = await response;
    assert.equal(JSON.parse(hello)[0], 'tw1');
    const batch = decodeWire(JSON.parse(hello));
    assert.equal(batch.type, 'batch');
    assert(batch.messages.some(m => m.observation.peers.some(peer => peer.name === '한글')));
    const reset = once(ws, 'message'); ws.send(JSON.stringify({ type: 'sync' }));
    assert.equal(decodeWire(JSON.parse((await reset)[0])).type, 'snapshot');
  } finally { ws?.terminate(); await app.close(); }
});
