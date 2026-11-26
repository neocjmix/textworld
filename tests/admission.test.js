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

test('one backpressured link closes with 1013 while its neighbor receives the next overwrite', async t => {
  const app = createTextworld({ storagePath: ':memory:', maxParticipants: 3 });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1');
  const url = 'ws://127.0.0.1:' + port + '/ws';
  const clients = [];
  for (let i=0; i<3; i++) {
    const client = connect(url);
    await client.next(m => m.type === 'snapshot');
    clients.push(client);
  }
  const [writer, reader, slow] = clients;
  const backpressured = [...app.wss.clients].at(-1);
  Object.defineProperty(backpressured, 'bufferedAmount', {get:() => 2 * 1024 * 1024});
  const closed = once(slow.socket, 'close');
  for (const [index, text] of ['하','늘'].entries()) {
    writer.send({ type:'write', id:'over-'+index, epoch:1, x:64, y:32, text });
    await writer.next(m => m.type === 'ack' && m.id === 'over-'+index);
    await reader.next(m => m.type === 'view' && m.observation.cells.some(c => c.text === text));
  }
  assert.equal((await closed)[0], 1013);
  const joined = connect(url);
  await joined.next(m => m.type === 'snapshot' && m.cells.some(c => c.text === '늘'));
});

test('aggregate action pressure refuses before a write, keeps the read stream and admits the next ordinal', async t => {
  let clock = 0;
  const app = createTextworld({storagePath:':memory:',policyNow:() => clock,actionRate:120,actionBurst:96});
  t.after(() => app.close());
  const {port} = await app.listen(0,'127.0.0.1');
  const url = 'ws://127.0.0.1:'+port+'/ws';
  const reader = connect(url), walker = connect(url);
  await Promise.all([reader,walker].map(client => client.next(m => m.type === 'snapshot')));
  for (const client of [reader,walker]) client.send({type:'hello',batchVersion:1});
  for (let n=1; n<=96; n++) walker.send({type:'input',epoch:1,id:'walk'+n,sequence:n,
    action:{kind:'move',dx:n%2 ? 1 : -1,dy:0,newOrigin:true}});
  await walker.next(m => m.type === 'ack' && m.id === 'walk96');
  const seq = app.world.seq;
  reader.send({type:'input',id:'first',sequence:1,epoch:1,action:{kind:'type',text:'雨'}});
  const busy = await reader.next(m => m.type === 'error' && m.id === 'first');
  assert.equal(busy.code,'WORLD_BUSY'); assert.equal(busy.status,429);
  assert.ok(busy.retryAfterMs>0); assert.equal(app.world.seq,seq);
  clock += busy.retryAfterMs;
  reader.send({type:'input',id:'again',sequence:2,epoch:1,action:{kind:'type',text:'雨'}});
  await reader.next(m => m.type === 'ack' && m.id === 'again');
  await walker.next(m => m.type === 'batch' && m.messages.some(v => v.observation.cells.some(c => c.text === '雨')));
  assert.equal(app.world.seq,seq+1);
});

test('edits and movement both pay for their crowd before taking effect', async t => {
  let clock = 0;
  const app = createTextworld({
    storagePath: ':memory:', policyNow: () => clock, actionRate: 120, actionBurst: 96,
    identifyNetwork: req => req.headers['x-test-network'] || 'walker',
  });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1');
  const writer = connect('ws://127.0.0.1:' + port + '/ws');
  await writer.next(m => m.type === 'snapshot');
  writer.send({ type: 'hello', batchVersion: 1 });
  for (let i = 0; i < 71; i++) {
    const response = await fetch('http://127.0.0.1:' + port + '/api/agents/v1/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-network': String(i) }, body: '{}',
    });
    assert.equal(response.status, 201);
    await response.json();
  }
  const send = (sequence, action) => writer.send({ type: 'input', epoch: 1, id: String(sequence), sequence, action });
  for (let n = 1; n <= 93; n++) send(n, { kind: 'move', dx: n % 2 ? 1 : -1, dy: 0 });
  await writer.next(m => m.type === 'ack' && m.id === '93');
  const version = app.world.seq;
  send(94, { kind: 'type', text: '봄' });
  const refusal = await writer.next(m => m.type === 'error' && m.id === '94');
  assert.equal(refusal.code, 'WORLD_BUSY');
  assert.equal(app.world.seq, version);
  send(95, { kind: 'move', dx: 1, dy: 0 });
  assert.equal((await writer.next(m => m.type === 'error' && m.id === '95')).code, 'WORLD_BUSY');
  clock += refusal.retryAfterMs;
  send(96, { kind: 'type', text: '봄' });
  await writer.next(m => m.type === 'ack' && m.id === '96');
  assert.equal(app.world.seq, version + 1);
});

test('crowd cost keeps increasing beyond the old five-unit ceiling', async t => {
  const app = createTextworld({ storagePath: ':memory:', maxParticipants: 400,
    actionBurst: 10, policyNow: () => 0,
    identifyNetwork: req => req.headers['x-test-network'] || 'writer' });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1');
  const writer = connect('ws://127.0.0.1:' + port + '/ws');
  await writer.next(m => m.type === 'snapshot');
  writer.send({ type: 'hello', batchVersion: 1 });
  for (let i = 0; i < 360; i++) {
    const response = await fetch('http://127.0.0.1:' + port + '/api/agents/v1/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-network': String(i) }, body: '{}',
    });
    assert.equal(response.status, 201); await response.json();
  }
  writer.send({ type: 'input', id: 'first', sequence: 1, action: { kind: 'type', text: 'x' } });
  await writer.next(m => m.type === 'ack' && m.id === 'first');
  const version = app.world.seq;
  writer.send({ type: 'input', id: 'second', sequence: 2, action: { kind: 'move', dx: -1, dy: 0 } });
  const refused = await writer.next(m => m.type === 'error' && m.id === 'second');
  assert.equal(refused.code, 'WORLD_BUSY');
  assert.deepEqual(refused.cursor, { x: 65, y: 32 });
  assert.equal(app.world.seq, version);
});
