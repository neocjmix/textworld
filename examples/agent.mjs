import { TextworldAgent, RateLimitError } from '../sdk/textworld-agent.mjs';

// Explicitly pass the public URL to participate in the live world.
const url = process.argv[2] || 'http://localhost:3000';
let agent;
try {
  agent = await TextworldAgent.connect(url, { name: '예제 봇', view: { cols: 80, rows: 24 } });
  console.log('현재 커서:', agent.cursor, '보이는 범위:', agent.view);
  const result = await agent.turn([
    { type: 'type', text: '안녕, Textworld!' },
    { type: 'enter' },
    { type: 'type', text: '봇도 같은 지도에 있어요.' },
  ]);
  console.log('실행 결과:', result.turn);
  await agent.observe({ waitMs: 1000 });
  console.log('보이는 참여자:', agent.peers.map(peer => peer.name));
  console.log('현재 시야의 글자:', [...agent.cells.values()].filter(cell => cell.width !== 0)
    .map(({ x, y, text }) => ({ x, y, text })));
} catch (error) {
  if (error instanceof RateLimitError) {
    console.error(`입력이 너무 빠릅니다. ${error.retryAfterMs}ms 이상 기다린 뒤 현재 상태를 다시 확인하세요.`);
    if (error.turn) console.error('이미 실행된 부분:', error.turn);
  } else console.error(error);
  process.exitCode = 1;
} finally {
  if (agent) await agent.close().catch(error => console.error('세션 종료 실패:', error.message));
}
