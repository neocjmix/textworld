import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTextworld, networkKey } from '../server/index.js';
import { connect, hasCell, hasPeer, observationOf } from './ws-client.js';

async function fixture(t, options = {}) {
  const app = createTextworld({ storagePath: ':memory:', trustProxy: false, ...options });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const join = async ({ view, position } = {}) => {
    const client = connect(`ws://127.0.0.1:${address.port}/ws`);
    await client.next(message => message.type === 'snapshot');
    if (view) client.send({ type: 'view', ...view });
    if (position) client.send({ type: 'move', epoch: app.world.epoch, ...position });
    if (view || position) await client.sync();
    return client;
  };
  return { app, join };
}

const write = (client, id, text, values = {}) => {
  const peer = client.state.peers.find(peer => peer.id === client.state.selfId);
  client.send({ type: 'write', id, epoch: client.state.world.epoch, x: peer.x, y: peer.y, text, ...values });
};

test('WebSocket snapshots, sync, view changes and presence disclose only the current bounded view', async t => {
  const { app, join } = await fixture(t);
  app.world.resize(1024, 512);
  app.world.applyWrite({ author: 'private-provenance', id: 'near', epoch: app.world.epoch, x: 512, y: 256, text: 'N' });
  app.world.applyWrite({ author: 'private-provenance', id: 'far', epoch: app.world.epoch, x: 2, y: 2, text: 'SECRET' });
  const a = await join();
  assert.equal(a.state.cells.get('512,256').text, 'N');
  assert.equal(a.state.cells.has('2,2'), false);
  assert.ok(a.state.view.cols <= 320 && a.state.view.rows <= 128);
  for (const cell of a.state.cells.values()) {
    assert.equal('author' in cell, false); assert.equal('group' in cell, false); assert.equal('updatedAt' in cell, false);
  }
  const snapshot = await a.sync();
  assert.equal('seq' in snapshot, false); assert.equal('seq' in snapshot.world, false);
  assert.equal(snapshot.cells.some(cell => cell.x === 2), false);
  a.send({ type: 'view', cols: 1024, rows: 512 });
  await a.next(message => message.type === 'error' && message.code === 'BAD_VIEW');
  const b = await join();
  await a.next(message => hasPeer(message, b.state.selfId));
  const after = a.messages.length;
  await b.locate(2, 2, app.world.epoch);
  await a.next(message => message.type === 'view' && !hasPeer(message, b.state.selfId), after);
  assert.equal(b.state.cells.get('2,2').text, 'S');
  assert.equal(a.state.peers.some(peer => peer.id === b.state.selfId), false);
  const beforeHiddenWrite = a.messages.length;
  write(b, 'hidden-change', 'X');
  await b.next(message => message.type === 'ack' && message.id === 'hidden-change');
  const fresh = await a.sync();
  assert.equal(fresh.cells.some(cell => cell.text === 'X'), false);
  assert.equal(a.messages.slice(beforeHiddenWrite).filter(message => message.type === 'view').length, 0, 'a hidden write must not cause a visible event');
  assert.equal(JSON.stringify(a.messages).includes('SECRET'), false);
});

test('remote writes and arbitrary native clear footprints cannot bypass the presence cursor', async t => {
  const { app, join } = await fixture(t), client = await join({ view: { cols: 128, rows: 64 } });
  const peer = client.state.peers.find(peer => peer.id === client.state.selfId);
  app.world.applyWrite({ author: 'other', id: 'seed', epoch: 1, x: 10, y: 10, text: 'K' });
  const before = app.world.snapshot();
  write(client, 'remote', 'X', { x: 10, y: 10 });
  await client.next(message => message.type === 'error' && message.id === 'remote' && message.code === 'OUT_OF_REACH');
  write(client, 'remote-clear', 'Y', { clear: [{ x: 10, y: 10 }] });
  await client.next(message => message.type === 'error' && message.id === 'remote-clear' && message.code === 'OUT_OF_REACH');
  assert.deepEqual(app.world.snapshot(), before);
  assert.deepEqual(client.state.peers.find(p => p.id === client.state.selfId), peer);
});

test('one oversized 20000-character WebSocket write is rejected without partial input', async t => {
  const { app, join } = await fixture(t), client = await join();
  write(client, 'oversized', 'A'.repeat(20000));
  const error = await client.next(message => message.type === 'error' && message.id === 'oversized');
  assert.equal(error.status, 413); assert.equal(error.code, 'TOO_LARGE');
  assert.equal(app.world.seq, 0); assert.equal(app.world.cells.size, 0);
});

test('abnormal WebSocket input frequency reports 429 and accepts a retry only after replenishment', async t => {
  let clock = 0;
  const { app, join } = await fixture(t, { policyNow: () => clock });
  const client = await join({ view: { cols: 128, rows: 64 } });
  write(client, 'burst', 'A'.repeat(64));
  await client.next(message => message.type === 'ack' && message.id === 'burst');
  write(client, 'too-fast', 'B');
  const error = await client.next(message => message.type === 'error' && message.id === 'too-fast');
  assert.equal(error.status, 429); assert.equal(error.code, 'RATE_LIMITED');
  assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 84);
  assert.deepEqual(error.cursor, { x: 0, y: 32 });
  assert.equal(app.world.seq, 1); assert.equal(app.world.getCell(0, 32), undefined);
  clock += error.retryAfterMs;
  write(client, 'too-fast', 'B');
  const ack = await client.next(message => message.type === 'ack' && message.id === 'too-fast');
  assert.equal(ack.seq, 2); assert.equal(app.world.getCell(0, 32).text, 'B');
});

test('network write budgets survive socket disconnection and prevent reconnect burst resets', async t => {
  const { app, join } = await fixture(t, { policyNow: () => 0 });
  for (let index = 0; index < 2; index++) {
    const client = await join({ view: { cols: 128, rows: 64 } });
    write(client, `burst-${index}`, String(index).repeat(64));
    await client.next(message => message.type === 'ack' && message.id === `burst-${index}`);
    const closed = new Promise(resolve => client.socket.once('close', resolve)); client.socket.close(); await closed;
  }
  const reconnected = await join({ view: { cols: 128, rows: 64 } });
  write(reconnected, 'third-burst', 'C');
  const error = await reconnected.next(message => message.type === 'error' && message.id === 'third-burst');
  assert.equal(error.status, 429); assert.ok(error.retryAfterMs >= 42);
  assert.equal(app.world.seq, 2); assert.equal(app.world.getCell(64, 32).text, '1');
});

test('normal CJK native replacement and wide-glyph backspace remain atomic under the shared policy', async t => {
  const { app, join } = await fixture(t), a = await join(), b = await join();
  write(a, 'jamo', 'ㅎ');
  await a.next(message => message.type === 'ack' && message.id === 'jamo');
  write(a, 'composed', '한', { x: 64, y: 32, clear: [{ x: 64, y: 32 }, { x: 65, y: 32 }] });
  await b.next(message => hasCell(message, 64, 32, '한', 2));
  assert.equal(app.world.getCell(64, 32).width, 2); assert.equal(app.world.getCell(65, 32).width, 0);
  const after = b.messages.length;
  a.send({ type: 'erase', id: 'backspace', intent: 'backspace', epoch: 1, x: 64, y: 32 });
  const ack = await a.next(message => message.type === 'ack' && message.id === 'backspace');
  const update = await b.next(message => message.type === 'view' && message.observation.forget.length === 2, after);
  assert.deepEqual(ack.cursor, { x: 64, y: 32 });
  assert.deepEqual(update.observation.forget, [{ x: 64, y: 32 }, { x: 65, y: 32 }]);
  assert.equal(app.world.getCell(64, 32).text, ''); assert.equal(app.world.getCell(65, 32).text, '');
  assert.ok(app.world.getCell(64, 32).version === 3 && app.world.getCell(65, 32).version === 3);
});

test('failed WebSocket handshakes release presence and session slots while retaining creation costs', async t => {
  let clock = 0;
  const { app, join } = await fixture(t, { policyNow: () => clock });
  const { port } = app.server.address(), base = `http://127.0.0.1:${port}`;
  const invalidHandshake = () => new Promise((resolve, reject) => {
    const request = http.request(`${base}/ws`, { agent: false, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'invalid-key',
    } }, response => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, retryAfter: response.headers['retry-after'] }));
    });
    request.once('error', reject); request.end();
  });
  for (let index = 0; index < 8; index++) {
    assert.equal((await invalidHandshake()).status, 400);
  }
  const limited = await invalidHandshake();
  assert.equal(limited.status, 429); assert.ok(Number(limited.retryAfter) >= 1);
  assert.equal((await (await fetch(`${base}/health`)).json()).peers, 0, 'failed upgrades must not leave ghost presence');
  clock += 1000;
  const client = await join();
  assert.equal(client.state.peers.length, 1, 'the refunded session slot must admit a normal connection');
  assert.equal((await (await fetch(`${base}/health`)).json()).peers, 1);
});

test('network identity ignores spoofed forwarded headers locally and groups IPv6 privacy addresses', () => {
  const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });
  assert.equal(networkKey(req('::FFFF:192.0.2.20')), '192.0.2.20');
  assert.equal(networkKey(req('::ffff:192.0.2.20', { 'x-forwarded-for': '198.51.100.10', 'x-real-ip': '203.0.113.3' })), '192.0.2.20');
  assert.equal(networkKey(req('127.0.0.1', { 'x-real-ip': '203.0.113.3' }), 'railway'), '203.0.113.3');
  assert.equal(networkKey(req('127.0.0.1', { 'x-real-ip': '203.0.113.3, 198.51.100.2' }), 'railway'), '127.0.0.1');
  assert.equal(networkKey(req('2001:db8:1234:5678::1')), networkKey(req('2001:0db8:1234:5678:abcd:ffff:2222:3333')));
  assert.notEqual(networkKey(req('2001:db8:1234:5678::1')), networkKey(req('2001:db8:1234:5679::1')));
});
