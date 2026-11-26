import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const railwayScope = ['--project', 'c702f64c-3e82-47e8-9945-e0540b1b5b2b',
  '--environment', 'dcf0285c-151d-4a4a-ac7a-37efab3fcb0d', '--service', '99c29cc7-7ab4-4939-85d3-48044329b4e7'];
export const railwayOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 45000,
  env: { ...process.env, RAILWAY_CALLER: process.env.RAILWAY_CALLER || 'skill:use-railway@1.3.5',
    RAILWAY_AGENT_SESSION: process.env.RAILWAY_AGENT_SESSION || `textworld-deploy-${process.pid}` } };

// Configure a native post-success purge. A pre-deploy purge would race with
// requests that refill the edge from the still-running previous deployment.
export function ensureCDNPolicy(railway, { enable = false } = {}) {
  const { cdn } = JSON.parse(execFileSync(railway, ['cdn', 'status', ...railwayScope, '--json'], railwayOptions));
  if (!cdn.available) throw Error('Railway CDN is unavailable for this service');
  if (!cdn.enabled && !enable) {
    console.log('CDN is disabled; deploy cache-safe assets before running npm run cdn:enable.');
    return;
  }
  execFileSync(railway, ['cdn', 'update', ...railwayScope, '--html-caching', 'auto', '--default-ttl', '30m',
    '--no-swr', '--purge-on-deploy', 'html', '--json'], railwayOptions);
  if (!cdn.enabled) execFileSync(railway, ['cdn', 'enable', ...railwayScope, '--json'], railwayOptions);
  console.log('CDN policy: origin TTLs, automatic HTML purge after successful deployments, immutable assets retained.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  ensureCDNPolicy(process.env.RAILWAY_BIN || 'railway', { enable: process.argv.includes('--enable') });
}
