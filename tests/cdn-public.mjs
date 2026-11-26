// A bounded, read-only cache check against the existing public deployment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { request } from 'playwright';

const origin = process.env.PUBLIC_URL || 'https://textworld-production-987c.up.railway.app';
const manifest = JSON.parse(await readFile('.build/manifest.json', 'utf8'));
const options = { baseURL: origin, ignoreHTTPSErrors: true, timeout: 30000 };
if (process.env.HTTPS_PROXY) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  options.proxy = { server: proxy.protocol + '//' + proxy.host,
    username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) };
}
const client = await request.newContext(options), records = [];
async function get(path, headers) {
  const response = await client.get(path, { headers, maxRedirects: 0 });
  const body = await response.body(), h = response.headers();
  const row = { path, status: response.status(), cache: h['x-cache'] || null, age: h.age || null,
    policy: h['cache-control'], etag: h.etag, release: h['x-textworld-assets'],
    bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  records.push(row);
  return { ...row, body };
}
try {
  const health = await get('/health'); assert.equal(health.status, 200);
  const live = JSON.parse(health.body);
  if (process.env.PUBLIC_REVISION) assert.equal(live.revision, process.env.PUBLIC_REVISION);
  for (const path of ['/', '/index.html', '/cost.html', '/agents.html', ...Object.values(manifest.urls),
    Object.keys(manifest.files).find(path => path.includes('-core-')),
    '/api/agents/v1', '/.well-known/textworld-agent.json']) {
    let hit = false;
    for (let i = 0; i < 3; i++) {
      const response = await get(path); assert.equal(response.status, 200, path);
      assert.match(response.policy, /public/);
      if (path === '/' || path.endsWith('.html')) assert.equal(response.release, manifest.id);
      if (manifest.files[path]) assert.equal(response.sha256, manifest.files[path].sha256, path);
      if (response.cache === 'HIT') { hit = true; break; }
    }
    assert.ok(hit, `No edge HIT for ${path}: ${JSON.stringify(records.filter(r => r.path === path))}`);
  }
  for (const path of ['/health', '/api/metrics', '/api/playtest', '/api/agents/v1/sessions/missing',
    '/mcp', '/playtest', '/app.js', '/fonts/sarasa.css', '/assets/absent-AAAAAAAA.js']) {
    const response = await get(path);
    assert.match(response.policy, /no-store/, path);
    assert.ok(!['HIT', 'STALE'].includes(response.cache), path);
  }
  const page = await get('/');
  const conditional = await get('/', { 'If-None-Match': page.etag });
  assert.equal(conditional.status, 304); assert.equal(conditional.bytes, 0);
  if (process.env.CDN_PREVIOUS_MANIFEST) {
    const previous = JSON.parse(await readFile(process.env.CDN_PREVIOUS_MANIFEST, 'utf8'));
    for (const path of [...Object.values(previous.urls), Object.keys(previous.files).find(path => path.includes('-core-'))]) {
      // Authorization deliberately bypasses Railway's cache for PUBLIC files;
      // this is not an operator credential and cannot authorize any private API.
      const response = await get(path, { Authorization: 'Bearer public-asset-origin-check' });
      assert.equal(response.status, 200, path); assert.ok(!['HIT', 'STALE'].includes(response.cache));
      assert.equal(response.sha256, previous.files[path].sha256, `Previous bytes changed: ${path}`);
    }
  }
  const output = process.env.CDN_OUTPUT || 'artifacts/cdn-public.json';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ at: new Date().toISOString(), origin, revision: live.revision,
    assetRelease: manifest.id, note: 'Controlled requests from one client; not a production traffic hit-ratio measurement.', records }, null, 2) + '\n');
  console.log(JSON.stringify({ revision: live.revision, assetRelease: manifest.id, requests: records.length,
    checks: ['HTML/JS/CSS/font/discovery edge HIT', 'current release and checksums', 'dynamic and error responses bypass cache',
      'conditional HTML 304', ...(process.env.CDN_PREVIOUS_MANIFEST ? ['old assets verified at origin'] : [])], output }));
} finally { await client.dispose(); }
