import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const url = new URL('https://textworld-production-987c.up.railway.app/api/playtest');
const [command = 'status', id, ...args] = process.argv.slice(2);
const help = 'status [ID] | start [ID [scenario.json]] | set ID writers walkers readers [new-cells|overwrite] | mark ID 메모 | stop ID';
try {
  if (!process.env.TEXTWORLD_PLAYTEST_TOKEN) throw Error('Railway production의 운영자 환경에서 실행하세요.');
  if (process.env.HTTPS_PROXY || process.env.https_proxy) http.setGlobalProxyFromEnv?.();
  let body;
  if (command === 'status' && !args.length) {
    if (id) url.searchParams.set('id', id);
  } else if (command === 'start' && args.length <= 1) {
    const key = id ?? randomUUID();
    body = { command, id: key, plan: args.length ? JSON.parse(readFileSync(args[0], 'utf8')) : undefined };
    console.log('실행 ID ' + key + ' · 응답 유실 시 같은 ID로 조회하거나 다시 요청하세요.');
  } else if (command === 'set' && id && [3, 4].includes(args.length)) {
    const [writers, walkers, readers] = args.slice(0, 3).map(Number);
    body = { command, id, counts: { writers, walkers, readers }, writing: args[3] };
  } else if (command === 'mark' && id && args.length) body = { command, id, note: args.join(' ') };
  else if (command === 'stop' && id && !args.length) body = { command, id };
  else throw Error(help);

  const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { authorization: 'Bearer ' + process.env.TEXTWORLD_PLAYTEST_TOKEN, 'content-type': 'application/json' },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  console.log(JSON.stringify(result));
  if (!response.ok) throw Error('요청 실패 HTTP ' + response.status);
  console.log(new URL('/playtest', url).href);
} catch (error) { console.error(error.message); process.exitCode = 1; }
