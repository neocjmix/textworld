import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const ASSET_RETENTION_MS = 7 * 86400_000;
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const PAGE_CACHE = 'public, max-age=0, s-maxage=30, must-revalidate';
export const MUTABLE_CACHE = 'no-cache, no-store, max-age=0';
const assetPath = /^\/(assets|fonts)\/[A-Za-z0-9._-]+\.(js|css|woff2)$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readAssetRelease(root, directory = resolve(root, '.build')) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || !/^[a-f0-9]{20}$/.test(manifest.id)
      || Object.keys(manifest.files).some(path => !assetPath.test(path))
      || manifest.pages.some(path => !/^\/[A-Za-z0-9_-]+\.html$/.test(path))) throw Error('Invalid asset manifest');
  return { ...manifest, directory, root, archive: null };
}

// Copy before listening. The volume outlives containers, so an old page and a
// cold edge can still fetch the exact old JS/CSS/font bytes after deployment.
export async function retainAssetRelease(release, archive, { now = Date.now(), retentionMs = ASSET_RETENTION_MS } = {}) {
  await mkdir(archive, { recursive: true });
  const activeFile = resolve(archive, 'active.json');
  let previous = [];
  try { previous = JSON.parse(await readFile(activeFile, 'utf8')).files; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Retention starts when a release stops being current, even if it ran for months.
  for (const url of previous) {
    if (!assetPath.test(url)) throw Error('Invalid archived asset path');
    try { await utimes(resolve(archive, url.slice(1)), now / 1000, now / 1000); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const [url, info] of Object.entries(release.files)) {
    const source = resolve(url.startsWith('/fonts/') ? resolve(release.root, 'public') : release.directory, url.slice(1));
    const body = await readFile(source);
    if (digest(body) !== info.sha256) throw Error(`Asset build checksum mismatch: ${url}`);
    const destination = resolve(archive, url.slice(1));
    await mkdir(resolve(archive, url.startsWith('/fonts/') ? 'fonts' : 'assets'), { recursive: true });
    try {
      const existing = await readFile(destination);
      if (digest(existing) !== info.sha256) throw Error(`Immutable URL changed contents: ${url}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = destination + `.tmp-${process.pid}`;
      await writeFile(temporary, body); await rename(temporary, destination);
    }
    await utimes(destination, now / 1000, now / 1000);
  }
  const temporary = activeFile + `.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify({ id: release.id, files: Object.keys(release.files) }));
  await rename(temporary, activeFile);
  // Deduplicated content, seven days after retirement; never evict current files.
  let bytes = 0, retained = 0, removed = 0;
  for (const group of ['assets', 'fonts']) {
    for (const name of await readdir(resolve(archive, group))) {
      const path = resolve(archive, group, name), url = `/${group}/${name}`, info = await stat(path);
      if (!info.isFile()) continue;
      if (!release.files[url] && info.mtimeMs < now - retentionMs) { await rm(path); removed++; }
      else { bytes += info.size; retained++; }
    }
  }
  console.log(JSON.stringify({ assetRelease: release.id, archiveFiles: retained, archiveBytes: bytes, removedFiles: removed }));
  return { ...release, archive };
}
