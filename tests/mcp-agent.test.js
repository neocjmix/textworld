import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTextworld } from '../server/index.js';
import { LIMITS } from '../server/participant-policy.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, { frozen = false, modern = true } = {}) {
  const app = createTextworld({ storagePath: ':memory:', trustProxy: false, ...(frozen ? { policyNow: () => 0 } : {}) });
  app.world.resize(512, 256);
  const { port } = await app.listen(0, '127.0.0.1');
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const client = new Client({ name: 'textworld-test', version: '1.0.0' }, {
    versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' },
  });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  const sessions = [];
  const call = (name, args = {}) => client.callTool({ name: `textworld_${name}`, arguments: args });
  const join = async options => {
    const result = await call('join', { view: { cols: 9, rows: 7 }, ...options });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.status, 201);
    const { id, token } = result.structuredContent.body.session;
    const credentials = { sessionId: id, token };
    sessions.push(credentials);
    return { ...credentials, result: result.structuredContent.body };
  };
  t.after(async () => {
    for (const session of sessions) await call('leave', session).catch(() => {});
    await client.close(); await app.close();
  });
  const raw = (body, headers = {}) => fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers,
  }, body: JSON.stringify(body) });
  return { app, url, client, transport, call, join, raw };
}

test('modern MCP discovery exposes five bounded participant tools and short text summaries', async t => {
  const f = await fixture(t);
  f.app.world.applyWrite({ author: 'seed', id: 'hidden', epoch: f.app.world.epoch, x: 2, y: 2, text: 'hidden' });
  const list = await f.client.listTools();
  assert.deepEqual(list.tools.map(tool => tool.name).sort(), ['textworld_act', 'textworld_cancel', 'textworld_join', 'textworld_leave', 'textworld_look']);
  assert.equal(list.tools.find(tool => tool.name === 'textworld_act').annotations.destructiveHint, true);
  const a = await f.join();
  assert.notEqual(a.sessionId, a.token); assert.equal(a.result.observation.cells.length, 0);
  const observed = await f.call('look', { sessionId: a.sessionId, token: a.token });
  assert.equal(observed.structuredContent.status, 200);
  assert.ok(observed.content[0].text.length < 150);
  assert.equal(observed.content[0].text.includes(a.token), false);
  assert.equal(f.transport.sessionId, undefined);
});

test('MCP agents share CJK overwrites; retries retain identity and do not replay actions', async t => {
  const f = await fixture(t), a = await f.join(), b = await f.join();
  const first = { sessionId: a.sessionId, token: a.token, id: 'first', actions: [{ type: 'type', text: '한' }] };
  const result = await f.call('act', first);
  assert.equal(result.structuredContent.status, 200);
  const viewed = await f.call('look', { sessionId: b.sessionId, token: b.token });
  assert.equal(viewed.structuredContent.body.observation.cells.find(cell => cell.width === 2)?.text, '한');
  await f.call('act', { sessionId: b.sessionId, token: b.token, id: 'second', actions: [{ type: 'type', text: 'B' }] });
  const seq = f.app.world.seq;
  const replay = await f.call('act', first);
  assert.equal(f.app.world.seq, seq);
  assert.equal(replay.structuredContent.body.observation.cells.find(cell => cell.x === 256)?.text, 'B');
  const wrong = await f.call('look', { sessionId: a.sessionId, token: b.token });
  assert.equal(wrong.isError, true); assert.equal(wrong.structuredContent.status, 401);
});

test('MCP does not grant bulk writes or views and reports existing HTTP policy errors', async t => {
  const f = await fixture(t), a = await f.join();
  const seq = f.app.world.seq;
  const result = await f.call('act', { sessionId: a.sessionId, token: a.token, id: 'large', actions: [{ type: 'type', text: 'A'.repeat(20000) }] });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.status, 413);
  assert.equal(f.app.world.seq, seq);
  const broad = await f.call('join', { view: { cols: 320, rows: 128 } });
  assert.equal(broad.isError, true); assert.equal(broad.structuredContent.status, 400);
});

test('MCP batches are rejected atomically and Host/Origin guards reject untrusted callers', async t => {
  const f = await fixture(t);
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'textworld_join', arguments: {} } };
  const batch = await f.raw([message, { ...message, id: 2 }]);
  assert.equal(batch.status, 400);
  assert.equal((await (await fetch(new URL('/health', f.url))).json()).peers, 0);
  // Node fetch rewrites Host; send the actual hostile wire header with http.
  const host = await new Promise((resolve, reject) => {
    const request = http.request(f.url, { method: 'POST', headers: { Host: 'attacker.invalid',
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject); request.end(JSON.stringify(message));
  });
  const origin = await f.raw(message, { Origin: 'https://attacker.invalid' });
  assert.equal(host, 403); assert.equal(origin.status, 403);
  const large = await f.raw({ ...message, extra: 'a'.repeat(65536) });
  assert.equal(large.status, 413);
  assert.equal((await fetch(f.url)).status, 405);
});

test('MCP shares request budgets once with HTTP and preserves tool-level 429 retry details', async t => {
  const f = await fixture(t, { frozen: true }), a = await f.join(), b = await f.join();
  const ca = { sessionId: a.sessionId, token: a.token }, cb = { sessionId: b.sessionId, token: b.token };
  for (let i = 0; i < 100; i++) {
    assert.equal((await f.call('look', ca)).structuredContent.status, 200);
    assert.equal((await f.call('look', cb)).structuredContent.status, 200);
  }
  // Two actors have spent 200 network tokens, not 400 for adapter overhead.
  for (let i = 100; i < LIMITS.request.burst; i++) assert.equal((await f.call('look', ca)).structuredContent.status, 200);
  const blocked = await f.call('look', ca);
  assert.equal(blocked.isError, true); assert.equal(blocked.structuredContent.status, 429);
  assert.ok(blocked.structuredContent.retryAfterMs > 0); assert.equal(blocked.structuredContent.retryAfter, '1');
  assert.equal(blocked.structuredContent.body.error.code, 'RATE_LIMITED');
  assert.equal((await f.call('cancel', ca)).structuredContent.status, 200);
});

test('MCP envelope exhaustion is actual HTTP 429 and controls remain usable', async t => {
  const f = await fixture(t, { frozen: true }), a = await f.join();
  let response;
  for (let i = 0; i < LIMITS.network.request.burst + 1; i++) {
    response = await f.raw({ jsonrpc: '2.0', id: i, method: 'tools/list', params: {} });
    await response.text();
    if (response.status === 429) break;
  }
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '1');
  const cancelled = await f.call('cancel', { sessionId: a.sessionId, token: a.token });
  assert.equal(cancelled.structuredContent.status, 200);
  const left = await f.call('leave', { sessionId: a.sessionId, token: a.token });
  assert.equal(left.structuredContent.status, 204);
});

test('MCP cancellation stops a running turn and does not undo completed text', async t => {
  const f = await fixture(t), a = await f.join(), auth = { sessionId: a.sessionId, token: a.token };
  const pending = f.call('act', { ...auth, id: 'slow', actions: [{ type: 'type', text: 'abcdefghij' }] });
  await pause(160);
  assert.equal((await f.call('cancel', auth)).structuredContent.body.cancelled, true);
  const result = await pending;
  assert.equal(result.structuredContent.body.turn.status, 'cancelled');
  assert.ok(result.structuredContent.body.turn.completedSteps > 0);
  assert.ok(result.structuredContent.body.turn.completedSteps < 10);
  const seq = f.app.world.seq; await pause(150); assert.equal(f.app.world.seq, seq);
});

test('the same tool definitions work with an initialization-based MCP client', async t => {
  const f = await fixture(t, { modern: false });
  assert.equal((await f.client.listTools()).tools.length, 5);
  const a = await f.join();
  const looked = await f.call('look', { sessionId: a.sessionId, token: a.token });
  assert.equal(looked.structuredContent.status, 200); assert.equal(f.transport.sessionId, undefined);
});
