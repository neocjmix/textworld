import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAssets } from '../scripts/build-assets.mjs';
import { readAssetRelease, retainAssetRelease, ASSET_RETENTION_MS } from '../server/asset-release.js';
import { createStaticAssets } from '../server/static-assets.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'textworld-release-'));
  await mkdir(join(root, 'public/fonts'), { recursive: true }); await mkdir(join(root, 'shared'));
  const files = {
    'public/app.js': "import { value } from '/shared/dep.js'; window.value = value;",
    'shared/dep.js': "export const value = 'version A';",
    'public/cost.js': "document.title = 'cost';",
    'public/style.css': 'body { color: red; }',
    'public/fonts/sarasa.css': '@font-face { font-family: World; src: url(/fonts/example-1.0.0.woff2); }',
    'public/fonts/example-1.0.0.woff2': 'font-A',
    'public/index.html': '<head><link rel="stylesheet" href="/fonts/sarasa.css"><link rel="stylesheet" href="/style.css"></head><script type="module" src="/app.js"></script>',
    'public/cost.html': '<head></head><script type="module" src="/cost.js"></script>',
  };
  await Promise.all(Object.entries(files).map(([path, body]) => writeFile(join(root, path), body)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'archive');
  async function release(label, now) {
    const directory = join(root, label);
    await buildAssets(root, directory);
    return retainAssetRelease(await readAssetRelease(root, directory), archive, { now });
  }
  async function serve(release) {
    const handler = createStaticAssets(root, { release });
    const server = http.createServer((req, res) => handler(req, res, req.url.split('?')[0]).catch(() => {
      res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end();
    }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return (path = '/', options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  }
  return { root, archive, release, serve };
}

test('deterministic builds invalidate transitive imports and CSS without invalidating unrelated font bytes', async t => {
  const f = await fixture(t), a = await f.release('A', 1_000_000), same = await f.release('same', 1_000_001);
  assert.equal(a.id, same.id); assert.deepEqual(a.files, same.files);
  await writeFile(join(f.root, 'shared/dep.js'), "export const value = 'version B';");
  const b = await f.release('B', 1_000_002);
  assert.notEqual(b.id, a.id); assert.notEqual(b.urls['/app.js'], a.urls['/app.js']);
  assert.equal(b.urls['/cost.js'], a.urls['/cost.js']);
  assert.equal(b.files['/fonts/example-1.0.0.woff2'].sha256, a.files['/fonts/example-1.0.0.woff2'].sha256);
  const html = await readFile(join(b.directory, 'pages/index.html'), 'utf8');
  assert.ok(html.includes(b.urls['/app.js'])); assert.ok(!html.includes('src="/app.js"'));
  const app = await readFile(join(b.directory, b.urls['/app.js']), 'utf8');
  assert.ok(app.includes('version B')); assert.ok(!app.includes('/shared/dep.js'));
  await writeFile(join(f.root, 'public/style.css'), 'body { color: blue; }');
  const c = await f.release('C', 1_000_003);
  assert.notEqual(c.urls['/style.css'], b.urls['/style.css']);
  assert.equal(c.urls['/app.js'], b.urls['/app.js']);
});

test('deployment and rollback serve exact old assets on cold requests, while HTML/ETag moves to the current release', async t => {
  const f = await fixture(t), a = await f.release('A', 1_000_000), old = await f.serve(a);
  const initial = await old('/'), oldTag = initial.headers.get('etag'); await initial.text();
  await writeFile(join(f.root, 'shared/dep.js'), "export const value = 'version B';");
  const b = await f.release('B', 1_000_001), request = await f.serve(b);
  const current = await request('/', { headers: { 'If-None-Match': oldTag } });
  assert.equal(current.status, 200); assert.notEqual(current.headers.get('etag'), oldTag);
  assert.equal(current.headers.get('cache-control'), 'public, max-age=0, s-maxage=30, must-revalidate');
  assert.ok((await current.text()).includes(b.urls['/app.js']));
  const prior = await request(a.urls['/app.js']);
  assert.equal(prior.status, 200); assert.match(await prior.text(), /version A/);
  assert.match(prior.headers.get('cache-control'), /immutable/);
  const fresh = await request(b.urls['/app.js']); assert.match(await fresh.text(), /version B/);
  const unchanged = await request('/index.html', { headers: { 'If-None-Match': current.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  for (const path of ['/assets/missing-AAAAAAAA.js', '/assets/%2e%2e/secret', '/%xy']) {
    const response = await request(path); assert.ok(response.status >= 400); assert.match(response.headers.get('cache-control'), /no-store/);
  }
  assert.match((await request('/app.js')).headers.get('cache-control'), /no-store/);
  const rollback = await retainAssetRelease(a, f.archive, { now: 1_000_002 }), back = await f.serve(rollback);
  assert.ok((await (await back('/')).text()).includes(a.urls['/app.js']));
  assert.match(await (await back(b.urls['/app.js'])).text(), /version B/);
});

test('seven-day retention starts at retirement, preserves lazy fonts, then removes only retired files', async t => {
  const f = await fixture(t), start = 1_000_000, a = await f.release('A', start);
  const retirement = start + 30 * 86400_000;
  await writeFile(join(f.root, 'shared/dep.js'), "export const value = 'version B';");
  await rm(join(f.root, 'public/fonts/example-1.0.0.woff2'));
  await writeFile(join(f.root, 'public/fonts/example-2.0.0.woff2'), 'font-B');
  await writeFile(join(f.root, 'public/fonts/sarasa.css'), '@font-face { font-family: World; src: url(/fonts/example-2.0.0.woff2); }');
  const b = await f.release('B', retirement), request = await f.serve(b);
  assert.equal(await (await request('/fonts/example-1.0.0.woff2')).text(), 'font-A');
  assert.match(await (await request(a.urls['/app.js'])).text(), /version A/);
  const c = await f.release('C', retirement + ASSET_RETENTION_MS + 1), next = await f.serve(c);
  assert.equal((await next(a.urls['/app.js'])).status, 404);
  assert.equal((await next('/fonts/example-1.0.0.woff2')).status, 404);
  assert.equal((await next(b.urls['/app.js'])).status, 200);
});

test('a damaged build or reused immutable URL is rejected before replacing existing content', async t => {
  const f = await fixture(t), a = await f.release('A', 1_000_000), url = a.urls['/app.js'];
  await writeFile(join(a.directory, url), 'changed content');
  await assert.rejects(retainAssetRelease(a, f.archive), /checksum mismatch/);
  const altered = { ...a, files: { ...a.files, [url]: { sha256: createHash('sha256').update('changed content').digest('hex') } } };
  await assert.rejects(retainAssetRelease(altered, f.archive), /Immutable URL changed contents/);
  assert.match(await readFile(join(f.archive, url), 'utf8'), /version A/);
});
