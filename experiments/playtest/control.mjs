import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const url = new URL('https://textworld-production-987c.up.railway.app/api/playtest');
const [command = 'status', id, ...args] = process.argv.slice(2);
const help = 'status [ID] | cost ID | start [ID [scenario.json]] | set ID writers walkers readers [new-cells|overwrite] | mark ID 메모 | stop ID';
try {
  if (!process.env.TEXTWORLD_PLAYTEST_TOKEN) throw Error('Railway production의 운영자 환경에서 실행하세요.');
  if (process.env.HTTPS_PROXY || process.env.https_proxy) http.setGlobalProxyFromEnv?.();
  let body;
  if ((command === 'status' || (command === 'cost' && id)) && !args.length) {
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
  if (!response.ok) {
    console.log(JSON.stringify(result));
    throw Error('요청 실패 HTTP ' + response.status);
  }
  if (command === 'cost') {
    const cost = result.cost;
    if (!cost) console.log('이 실행에 저장된 비용 표본이 없습니다.');
    else {
      const usd = value => value == null ? '미측정' : '$' + value.toFixed(8);
      const estimate = cost.estimatedUsd;
      console.log('실행', result.id, '·', result.state, '·', cost.elapsedSeconds.toFixed(1) + '초');
      console.log('서비스 사용료 추정 소계', usd(estimate.subtotal), '· CPU', usd(estimate.cpu),
        '· 메모리', usd(estimate.memory), '· 공개 송신', usd(estimate.publicEgress), '· 볼륨', usd(estimate.volume));
      console.log('확인된 글자 1,000개당', usd(cost.usdPer1000WrittenGraphemes),
        '· 봇이 외부에 있었다고 가정한 별도 송신료', usd(cost.hypotheticalBotEgressUsd));
    }
  } else {
    console.log(JSON.stringify(result));
    console.log(new URL('/playtest', url).href);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
