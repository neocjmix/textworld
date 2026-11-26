import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function buildAssets(root, directory = resolve(root, '.build')) {
  // Never publish HTML pointing at an incomplete build. Production builds run
  // in the next deployment's container, before it can receive any traffic.
  await rm(directory, { recursive: true, force: true });
  const entries = { app: 'public/app.js', cost: 'public/cost.js', style: 'public/style.css', sarasa: 'public/fonts/sarasa.css' };
  const result = await build({ absWorkingDir: root, entryPoints: entries,
    outdir: resolve(directory, 'assets'), entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]',
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, legalComments: 'eof', metafile: true, logLevel: 'warning', external: ['/fonts/*'],
    plugins: [{ name: 'browser-root-imports', setup(builder) {
      builder.onResolve({ filter: /^\/shared\// }, args => ({ path: resolve(root, args.path.slice(1)) }));
    } }] });
  const urls = {}, files = {};
  for (const [output, info] of Object.entries(result.metafile.outputs).sort(([a], [b]) => a.localeCompare(b))) {
    const path = resolve(root, output), url = '/' + relative(directory, path).split('\\').join('/');
    const body = await readFile(path);
    files[url] = { sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
    if (info.entryPoint) urls['/' + info.entryPoint.replace(/^public\//, '')] = url;
  }
  // Keep fonts at their existing immutable URLs, including lazy Unicode ranges.
  for (const name of (await readdir(resolve(root, 'public/fonts'))).sort()) {
    if (!name.endsWith('.woff2')) continue;
    const body = await readFile(resolve(root, 'public/fonts', name));
    files['/fonts/' + name] = { sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
  }
  const pages = {};
  for (const name of (await readdir(resolve(root, 'public'))).filter(name => name.endsWith('.html')).sort()) {
    const source = await readFile(resolve(root, 'public', name), 'utf8');
    pages['/' + name] = source.replace(/\b(src|href)="([^"]+)"/g,
      (match, attr, url) => urls[url] ? `${attr}="${urls[url]}"` : match);
  }
  const id = createHash('sha256').update(JSON.stringify({ urls, files, pages })).digest('hex').slice(0, 20);
  await mkdir(resolve(directory, 'pages'), { recursive: true });
  for (const [url, body] of Object.entries(pages)) {
    await writeFile(resolve(directory, 'pages', url.slice(1)), body.replace('</head>', `  <meta name="textworld-assets" content="${id}">\n</head>`));
  }
  const manifest = { schema: 1, id, urls, files, pages: Object.keys(pages) };
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifest = await buildAssets(root);
  console.log(`Built immutable assets ${manifest.id} (${Object.keys(manifest.files).length} files)`);
}
