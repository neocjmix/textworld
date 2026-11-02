import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = new URL('/mcp', process.argv[2] || 'http://localhost:3000');
const client = new Client({ name: 'textworld-example', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
const transport = new StreamableHTTPClientTransport(endpoint);
let session, lastTurnId;

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const data = result.structuredContent;
  if (!data || typeof data !== 'object' || !Number.isInteger(data.status)) {
    throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n')
      || '구조화된 도구 결과가 없습니다.');
  }
  if (result.isError || data.status >= 400) {
    throw Object.assign(new Error(data.body?.error?.message || `도구 실패: ${data.status}`), {
      status: data.status, code: data.body?.error?.code,
      retryAfterMs: data.retryAfterMs ?? data.body?.error?.retryAfterMs,
      turn: data.body?.turn,
    });
  }
  return data.body;
}

try {
  await client.connect(transport);
  const discovered = await client.listTools();
  console.log('사용 가능한 도구:', discovered.tools.map(tool => tool.name));
  const joined = await call('textworld_join', { name: 'MCP 예제 봇', view: { cols: 80, rows: 24 } });
  session = { sessionId: joined.session.id, token: joined.session.token };
  console.log('현재 커서:', joined.cursor, '보이는 범위:', joined.observation.view);
  lastTurnId = randomUUID();
  const acted = await call('textworld_act', { ...session, id: lastTurnId,
    actions: [{ type: 'type', text: '안녕 MCP!' }], since: joined.observation.revision });
  console.log('실행 결과:', acted.turn);
  const looked = await call('textworld_look', { ...session, since: acted.observation?.revision, waitMs: 1000 });
  console.log('현재 시야의 참여자:', looked.observation.peers.map(peer => peer.name));
} catch (error) {
  if (error.status === 429) console.error(`요청이 너무 빠릅니다. 대기 시간: ${error.retryAfterMs}ms`, error.turn || '');
  else console.error(error.message);
  if (lastTurnId) console.error('마지막 행동 ID(응답 유실 시 같은 행동의 결과 확인에 사용):', lastTurnId);
  process.exitCode = 1;
} finally {
  if (session) await call('textworld_leave', session).catch(error => console.error('세션 종료 실패:', error.message));
  await client.close();
}
