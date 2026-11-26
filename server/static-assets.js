import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const compress = promisify(gzip);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const compressible = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.txt']);

function acceptsGzip(value = '') {
  const encodings = new Map(value.toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
    return [name.trim(), quality === undefined ? 1 : Number(quality.slice(2))];
  }));
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
}

// Bound retained data, share concurrent reads/compression, and notice edits in
// local development. Unversioned URLs always revalidate after a deployment.
export function createStaticAssets(root, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const cache = new Map(), loading = new Map();
  let bytes = 0;
  async function load(file) {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const cached = cache.get(file);
    if (cached?.stamp === stamp) {
      cache.delete(file); cache.set(file, cached);
      return cached;
    }
    const key = `${file}:${stamp}`;
    if (loading.has(key)) return loading.get(key);
    const promise = (async () => {
      const content = await readFile(file), extension = extname(file);
      const compressed = compressible.has(extension) && content.length >= 512 ? await compress(content) : null;
      const zipped = compressed?.length < content.length ? compressed : null;
      const entry = { stamp, content, zipped, size: content.length + (zipped?.length || 0),
        etag: `W/"${createHash('sha256').update(content).digest('base64url')}"`,
        type: mime[extension] || 'application/octet-stream' };
      if (cache.has(file)) { bytes -= cache.get(file).size; cache.delete(file); }
      if (entry.size <= maxBytes) {
        while (cache.size && (bytes + entry.size > maxBytes || cache.size >= 256)) {
          const oldest = cache.keys().next().value;
          bytes -= cache.get(oldest).size; cache.delete(oldest);
        }
        cache.set(file, entry); bytes += entry.size;
      }
      return entry;
    })();
    loading.set(key, promise);
    try { return await promise; } finally { loading.delete(key); }
  }
  return async function serve(req, res, pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { res.writeHead(400); res.end(); return; }
    const base = resolve(root, decoded.startsWith('/shared/') ? 'shared' : 'public');
    const relative = decoded.startsWith('/shared/') ? decoded.slice(8) : decoded === '/' ? 'index.html' : decoded.slice(1);
    const file = resolve(base, relative);
    if (!file.startsWith(base + sep) || file.includes('\0')) { res.writeHead(404); res.end(); return; }
    const entry = await load(file);
    if (!entry) { res.writeHead(404); res.end(); return; }
    const zipped = entry.zipped && acceptsGzip(req.headers['accept-encoding']);
    const content = zipped ? entry.zipped : entry.content;
    const versionedFont = /^\/fonts\/[A-Za-z0-9._-]+-\d+\.\d+\.\d+\.woff2$/.test(decoded);
    const headers = { 'Content-Type': entry.type, 'Cache-Control': versionedFont ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: entry.etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      ...(entry.zipped ? { Vary: 'Accept-Encoding' } : {}), ...(zipped ? { 'Content-Encoding': 'gzip' } : {}) };
    const validators = (req.headers['if-none-match'] || '').split(',').map(v => v.trim().replace(/^W\//, ''));
    if (validators.includes('*') || validators.includes(entry.etag.slice(2))) {
      res.writeHead(304, headers); res.end(); return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': content.length });
    res.end(req.method === 'HEAD' ? undefined : content);
  };
}
