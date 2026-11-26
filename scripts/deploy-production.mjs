import { execFileSync } from 'node:child_process';

// Reconcile the existing service with remote main and return once queued.
const railway = process.env.RAILWAY_BIN || 'railway';
const scope = ['--project', 'c702f64c-3e82-47e8-9945-e0540b1b5b2b',
  '--environment', 'dcf0285c-151d-4a4a-ac7a-37efab3fcb0d', '--service', '99c29cc7-7ab4-4939-85d3-48044329b4e7'];
const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 45000 };
try {
  const sha = execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], opts).split(/\s/)[0];
  const [latest] = JSON.parse(execFileSync(railway, ['deployment', 'list', ...scope, '--limit', '1', '--json'], opts));
  if (latest?.meta?.commitHash === sha && ['WAITING','QUEUED','INITIALIZING','BUILDING','DEPLOYING','SUCCESS','SLEEPING','NEEDS_APPROVAL'].includes(latest.status)) {
    console.log(sha, latest.id, latest.status);
  } else {
    execFileSync(railway, ['service', 'source', 'connect', ...scope, '--repo', 'neocjmix/textworld', '--branch', 'main', '--json'], opts);
    console.log('Railway가 main 배포 요청을 접수했습니다.', sha);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
