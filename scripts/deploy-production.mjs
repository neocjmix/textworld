import { execFileSync } from 'node:child_process';
import { ensureCDNPolicy, railwayScope as scope, railwayOptions as opts } from './cdn-policy.mjs';

// Reconcile the existing service with remote main and return once queued.
const railway = process.env.RAILWAY_BIN || 'railway';
try {
  ensureCDNPolicy(railway);
  const sha = execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], opts).split(/\s/)[0];
  const [latest] = JSON.parse(execFileSync(railway, ['deployment', 'list', ...scope, '--limit', '1', '--json'], opts));
  if (latest?.meta?.commitHash === sha && ['WAITING','QUEUED','INITIALIZING','BUILDING','DEPLOYING','SUCCESS','SLEEPING','NEEDS_APPROVAL'].includes(latest.status)) {
    console.log(sha, latest.id, latest.status);
  } else {
    execFileSync(railway, ['service', 'source', 'connect', ...scope, '--repo', 'neocjmix/textworld', '--branch', 'main', '--json'], opts);
    console.log('Railway가 main 배포 요청을 접수했습니다.', sha);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
