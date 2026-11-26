import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createTextworld } from '../server/index.js';
import { connect } from './ws-client.js';

test('a full world keeps established input live and reuses one seat across transports', async t => {
  const app = createTextworld({ storagePath: ':memory:', maxParticipants: 2 });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1');
  const url = 'http://127.0.0.1:' + port;
  const socketUrl = 'ws://127.0.0.1:' + port + '/ws';
  const writer = connect(socketUrl), reader = connect(socketUrl);
  await Promise.all([writer, reader].map(client => client.next(m => m.type === 'snapshot')));
  const join = () => fetch(url + '/api/agents/v1/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const before = app.world.usedColors.size;
  const refused = await join();
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get('retry-after'), '5');
  assert.equal((await refused.json()).error.code, 'WORLD_FULL');
  const extra = new WebSocket(socketUrl);
  extra.on('error', () => {});
  const [, response] = await once(extra, 'unexpected-response');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  response.resume(); extra.terminate();
  assert.equal(app.world.usedColors.size, before);
  writer.send({ type: 'input', id: 'at-capacity', sequence: 1, epoch: 1, action: { kind: 'type', text: '함' } });
  await writer.next(m => m.type === 'ack' && m.id === 'at-capacity');
  await reader.next(m => m.type === 'view' && m.observation.cells.some(c => c.text === '함'));
  const closed = once(reader.socket, 'close');
  reader.socket.close(); await closed;
  assert.equal((await join()).status, 201);
  const health = await (await fetch(url + '/health')).json();
  assert.equal(health.peers, health.capacity);
});
