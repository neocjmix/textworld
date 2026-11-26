import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createStaticAssets } from '../server/static-assets.js';

async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'textworld-assets-'));
  await mkdir(join(root, 'public')); await mkdir(join(root, 'shared'));
  const body = 'export const map = "shared text world";\n'.repeat(100);
  await writeFile(join(root, 'public/app.js'), body);
  await writeFile(join(root, 'shared/world.js'), body);
  const serve = createStaticAssets(root, options);
  const server = http.createServer((req, res) => serve(req, res, req.url.split('?')[0]).catch(() => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = (path = '/app.js', headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: server.address().port, path, headers, method }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
  return { root, body, request };
}

test('static text negotiates gzip and revalidates both representations without retransmitting a body', async t => {
  const { request, body } = await fixture(t);
  const plain = await request(), compressed = await request('/app.js', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(plain.body.toString(), body);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(compressed.body).toString(), body);
  assert.ok(compressed.body.length < plain.body.length / 4);
  assert.equal(compressed.headers.vary, 'Accept-Encoding');
  assert.equal(compressed.headers.etag, plain.headers.etag);
  assert.equal(compressed.headers['cache-control'], 'no-cache, no-store, max-age=0');
  for (const validator of [plain.headers.etag, `"other", ${plain.headers.etag.slice(2)}`, '*']) {
    const unchanged = await request('/app.js', { 'If-None-Match': validator, 'Accept-Encoding': 'gzip' });
    assert.equal(unchanged.status, 304); assert.equal(unchanged.body.length, 0);
    assert.equal(unchanged.headers.etag, plain.headers.etag);
  }
  assert.equal((await request('/app.js', { 'If-None-Match': '"older"' })).status, 200);
  for (const encoding of ['gzip;q=0, *;q=1', 'br', 'gzip;q=invalid']) {
    const identity = await request('/app.js', { 'Accept-Encoding': encoding });
    assert.equal(identity.headers['content-encoding'], undefined); assert.equal(identity.body.toString(), body);
  }
  const head = await request('/app.js', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), compressed.body.length);
});

test('a changed file invalidates its ETag and concurrent requests receive complete content', async t => {
  const { root, request } = await fixture(t, { maxBytes: 2048 });
  const first = await request();
  const changed = 'export const updated = true;\n'.repeat(130);
  await writeFile(join(root, 'public/app.js'), changed);
  const responses = await Promise.all(Array.from({ length: 20 }, () => request('/app.js', { 'If-None-Match': first.headers.etag, 'Accept-Encoding': 'gzip' })));
  for (const response of responses) {
    assert.equal(response.status, 200); assert.notEqual(response.headers.etag, first.headers.etag);
    assert.equal(gunzipSync(response.body).toString(), changed);
  }
  assert.equal((await request('/shared/world.js')).status, 200);
});

test('font bytes remain immutable and uncompressed; malformed and escaping paths cannot serve files', async t => {
  const { root, request } = await fixture(t);
  await mkdir(join(root, 'public/fonts'));
  const font = Buffer.from('already-compressed-font');
  await writeFile(join(root, 'public/fonts/sarasa-latin-1.0.43.woff2'), font);
  const response = await request('/fonts/sarasa-latin-1.0.43.woff2', { 'Accept-Encoding': 'gzip' });
  assert.equal(response.headers['content-type'], 'font/woff2');
  assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(response.headers['content-encoding'], undefined); assert.deepEqual(response.body, font);
  for (const path of ['/../secret', '/%2e%2e/secret', '/shared/%2e%2e/secret', '/%00', '/fonts/']) {
    assert.equal((await request(path)).status, 404, path);
  }
  assert.equal((await request('/%xy')).status, 400);
});
