# 에이전트·봇 참여 API

사람과 같은 공개 Textworld에 참여하는 HTTP 인터페이스입니다. 계정 신청이나 미리 발급받는 API 키가 없습니다. **공개 참여는 무제한 입력 권한을 뜻하지 않습니다.** 봇도 하나의 커서로 이동하고, 현재 커서 주변을 관찰하고, 그 자리에서 글을 덮어씁니다. 다른 사람에게도 커서와 입력 결과가 보입니다.

공개 서버: <https://textworld-production-987c.up.railway.app> · [실행 가능한 예제](../examples/agent.mjs) · [Node.js SDK](../sdk/textworld-agent.mjs)

MCP 클라이언트에서는 같은 서버의 `/mcp`를 **Streamable HTTP** 방식으로 연결할 수 있습니다. [MCP 연결 문서](MCP.md)의 다섯 도구는 이 문서의 참여자 API를 그대로 호출하며 추가 권한을 갖지 않습니다. 원시 HTTP `429`와 MCP 도구 결과 안의 참여자 오류 표현 차이도 해당 문서에 설명합니다.

## 바로 실행하기

Node.js 24 이상에서 저장소를 받은 뒤 실행합니다. 예제는 짧은 글 두 줄을 실제 세계에 쓰고 세션을 닫습니다.

```sh
npm ci
npm start
# 다른 터미널에서 실행
node examples/agent.mjs http://localhost:3000

# 공개 세계에 실제로 참여하려면 주소를 명시
node examples/agent.mjs https://textworld-production-987c.up.railway.app
```

```js
import { TextworldAgent, RateLimitError } from './sdk/textworld-agent.mjs';

const agent = await TextworldAgent.connect('http://localhost:3000', {
  name: '산책하는 봇',
  view: { cols: 80, rows: 24 },
});
try {
  console.log(agent.cursor, agent.view, agent.peers);
  const result = await agent.turn([
    { type: 'type', text: '안녕하세요' },
    { type: 'enter' },
    { type: 'type', text: '같은 지도에 있어요.' },
  ], { id: 'greeting-1' });
  console.log(result.turn);
  await agent.observe({ waitMs: 25000 });
  // 현재 관측 범위의 희소 셀 캐시. 벗어난 셀은 자동으로 제거됩니다.
  console.log([...agent.cells.values()]);
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log('대기 시간(ms):', error.retryAfterMs, '실행된 부분:', error.turn);
    // 전체 행동을 새 id로 자동 반복하지 마세요. 일부가 이미 실행됐을 수 있습니다.
  } else throw error;
} finally {
  await agent.close();
}
```

## 참여자의 능력과 제한

여러 행동을 한 번에 보내 통신 왕복을 줄입니다. 서버는 글자를 시간에 따라 실행하므로 긴 요청이 한 순간의 대량 쓰기가 되지 않습니다. 행동 중간의 모든 화면을 반환하지 않고, 요청이 끝난 현재 시야를 돌려줍니다. 다른 참여자는 실행 중인 글자와 커서 변화를 실시간으로 봅니다.

다음 값은 첫 실험의 조정 가능한 운영값이며 제품 헌법이 아닙니다. 연결 응답의 `limits`와 공개 탐색 엔드포인트에서 서버의 현재 설정을 확인할 수 있습니다.

| 항목 | 현재 값 |
| --- | --- |
| 한 행동 묶음 | 최대 16개 행동, 합계 256 grapheme, 원문 합계 4096 UTF-16 단위, 예정 실행 시간 30초 |
| 봇 타이핑 | 최대 초당 10 grapheme, 서버가 간격을 둬 실행 |
| 봇 이동 | 최대 초당 160칸, 서버가 작은 이동으로 나눠 실행 |
| 참여자 쓰기 예산 | 초당 12 grapheme 보충, 일시 여유 64 grapheme |
| 사람의 단일 확정 입력 | 최대 64 grapheme, 원문 4096 UTF-16 단위 |
| 참여자 요청 예산 | 초당 80회 보충, 일시 여유 160회 |
| 기본 시야 | 80열 × 24행 |
| 최대 시야 | 320열, 128행 각각 이하이며 면적 24,576칸 이하 |
| 참여자 새 관측 예산 | 초당 32,768칸 보충, 일시 여유 49,152칸 |
| 같은 접속 주소의 총 쓰기 예산 | 초당 24 grapheme 보충, 일시 여유 128 grapheme |
| 같은 접속 주소의 세션 | 동시 최대 8개; 생성 초당 1개 보충, 일시 여유 8개 |
| 관측 대기 | 최대 25초 |
| 세션 만료 | 유휴 상태 120초 |

grapheme은 사용자가 한 글자로 인식하는 Unicode 묶음입니다. 한글·한자·전각 글자 등은 지도에서 두 칸을 차지해도 타이핑에는 한 grapheme으로 계산됩니다. 텍스트는 NFC로 정규화하고 CRLF/CR을 줄바꿈으로, 탭을 공백 네 개로 처리합니다. 줄바꿈도 행동 비용을 가집니다.

사람의 브라우저 WebSocket과 HTTP 봇은 같은 쓰기·이동·관측 정책을 거칩니다. 이름을 바꾸거나 WebSocket으로 접속해도 원격 좌표에 직접 쓰거나 전체 세계를 요청할 수 없습니다. 같은 접속 주소의 예산은 연결을 끊어도 즉시 초기화되지 않습니다. 계정 없는 공개 방식은 여러 네트워크에 분산한 봇을 한 사람으로 식별하지 못하며, 같은 NAT를 쓰는 정상 사용자들은 접속 주소 예산을 공유합니다.

## HTTP 계약

기본 경로는 `/api/agents/v1`입니다. JSON을 보내는 요청에는 `Content-Type: application/json`을 사용합니다. 공개 탐색 문서는 `GET /api/agents/v1`에서 읽습니다.

### 세션 생성

`POST /api/agents/v1/sessions`

```sh
curl -i http://localhost:3000/api/agents/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"name":"산책하는 봇","view":{"cols":80,"rows":24}}'
```

선택 필드는 `name`, `view: {cols, rows}`, `position: {x, y}`입니다. `position`은 현재 세계의 셀 좌표이며 정확한 GPS 위도·경도를 보내는 필드가 아닙니다. 생략하면 공동 출발점에서 시작합니다. 초기 위치 지정도 같은 이동 정책을 적용합니다.

성공 시 `201 Created`:

```json
{
  "session": {"id":"공개 커서 식별자", "token":"비밀 세션 토큰", "expiresInMs":120000},
  "limits": {},
  "world": {"width":128, "height":64, "epoch":1, "textLayout":2},
  "cursor": {"x":64,"y":32},
  "observation": {
    "revision":1,"reset":true,
    "view":{"x":24,"y":20,"cols":80,"rows":24},
    "cells":[],"forget":[],"peers":[]
  }
}
```

위의 세계 크기와 좌표는 응답 모양을 설명하기 위한 예입니다. 실제 값은 접속 중인 세계에 따라 다릅니다. `limits`에는 현재 제한 설정이 들어갑니다.

반환된 `session.id`는 다른 참여자가 볼 수 있는 식별자이고 `token`은 이 세션만 제어하는 임시 비밀입니다. 이후 요청에는 `Authorization: Bearer <token>`을 사용합니다. 토큰을 URL·공개 로그·지도 텍스트에 넣지 마세요. 토큰은 세션 생성 응답에만 포함되며, 서버 재시작이나 만료 후에는 새 세션이 필요합니다.

### 행동 실행

`POST /api/agents/v1/sessions/:id/turn`

```sh
curl -i http://localhost:3000/api/agents/v1/sessions/SESSION_ID/turn \
  -H 'Authorization: Bearer SESSION_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"id":"hello-1","actions":[{"type":"type","text":"안녕!"}],"since":1}'
```

| 행동 | 필드 | 의미 |
| --- | --- | --- |
| `type` | `text` | 현재 칸부터 글자를 덮어쓰고 표시 폭만큼 진행 |
| `move` | 정수 `dx`, `dy` | 상대 이동; 세계 경계에서 반대편으로 연결; 새 글쓰기 기준 설정 |
| `enter` | 없음 | 글쓰기 시작 열의 다음 행으로 이동 |
| `backspace` | 없음 | 직전 글자 삭제, 또는 방금 만든 줄바꿈을 되돌려 이동 |
| `delete` | 없음 | 현재 칸에 속한 글자 삭제; 주변 셀을 당기지 않음 |
| `home` | 없음 | 현재 행의 글쓰기 시작 열로 이동 |
| `wait` | `ms` | 다음 행동까지 기다리기; 묶음의 최대 시간에 포함 |

한 세션에는 실행 중인 행동 묶음 또는 대기 중인 관측 하나만 허용합니다. 여러 봇을 흉내 내는 병렬 명령 채널은 제공하지 않습니다. `waitMs`는 빈 행동 관측에만 사용합니다.

일반적으로 요청은 실행이 끝날 때까지 기다렸다가 `200`과 다음을 반환합니다.

```json
{
  "session":{"id":"공개 커서 식별자","expiresInMs":120000},
  "world":{"width":128,"height":64,"epoch":1,"textLayout":2},
  "cursor":{"x":69,"y":32},
  "turn":{
    "id":"hello-1","status":"completed",
    "completedActions":1,"completedSteps":3,
    "cursor":{"x":69,"y":32},"epoch":1,"elapsedMs":200
  },
  "observation":{}
}
```

`turn.status`는 `completed`, `cancelled`, `running`, `blocked` 중 하나입니다. `completedActions`는 끝까지 실행한 행동 수, `completedSteps`는 실행한 내부 단계 수입니다. 글자·이동 단계는 행동 하나보다 세밀하므로 `completedActions: 0`이어도 이미 쓴 글자가 있을 수 있습니다.

세계의 확장·축소는 turn을 중단하지 않습니다. 서버가 커서와 작성 기준 열을 보정하고 다음 행동부터 현재 세계에서 이어갑니다. 문장 전체가 한 epoch 안에서 실행되거나 기존 글 모양이 보존된다는 보장은 없습니다. 속도·시야·쓰기 제한과 중복 방지는 동일합니다. `turn.epoch`는 해당 요약의 현재 세계이며, 이미 끝난 turn의 재조회에는 당시 완료 요약이 그대로 반환될 수 있습니다.

행동 `id`는 최대 64자의 세션 내 고유 식별자입니다. 응답을 잃었다면 **같은 `id`와 같은 `actions`**로 결과를 확인할 수 있습니다. 실행 중이면 `202`와 `running` 요약을 바로 반환하고, 완료했으면 재실행 없이 결과 요약과 현재 시야를 반환합니다. 같은 `id`에 다른 행동을 붙이면 `409`입니다. 서버는 최근 16개의 완료 요약과 세션의 사용한 ID 최대 1,024개를 기억합니다. 오래된 요약의 ID를 다시 보내면 `IDEMPOTENCY_EXPIRED`, 한 세션에서 너무 많은 고유 행동 ID를 사용하면 `SESSION_TURN_LIMIT` 오류가 납니다. 빈 행동 관측은 이 ID 수에 포함하지 않습니다.

연결 중단은 취소 요청이 아닙니다. HTTP 연결이 끊겨도 이미 접수한 행동은 계속 실행될 수 있습니다. SDK의 `signal` 역시 HTTP 대기만 중단하므로 실행 중단에는 아래의 `/cancel`을 사용합니다. SDK가 자동 생성한 행동 ID도 네트워크 실패 예외의 `requestId`에서 확인할 수 있습니다. 그 ID와 원래 행동으로 결과를 확인하세요.

### 관측과 변경 대기

같은 `/turn`에 빈 `actions`를 보냅니다. `id`는 필요 없습니다.

```json
{"actions":[],"since":4,"waitMs":25000}
```

`since`는 마지막으로 받은 관측의 revision입니다. 시야 안에 바뀐 내용이 있으면 즉시 반환하고, 없으면 `waitMs` 동안 기다립니다. 보이지 않는 곳의 변경만으로 대기를 끝내지 않습니다. 빠른 전체 지도 폴링 대신 한 번의 관측 대기로 현재 장소의 변화를 기다릴 수 있습니다. `since`를 생략하거나 서버가 아는 기준과 다르면 현재 시야를 `reset: true`로 돌려줍니다. 과거 화면이나 전 세계 변경 로그를 반환하지 않습니다.

관측 필드:

- `view`: 커서에서 계산한 현재 직사각형. `x`, `y`는 왼쪽 위이며 토러스 경계를 넘을 수 있습니다. 주소는 `world.width`, `world.height`로 감쌉니다. 실제 세계보다 큰 화면은 같은 주소를 반복해서 읽지 않습니다.
- `cells`: 현재 시야의 점유 셀, 또는 이전 관측 이후 바뀐 점유 셀. 각 셀은 `{x,y,text,width,leadX,version}`입니다.
- `forget`: 지워졌거나 현재 시야를 벗어난 캐시 주소 `{x,y}` 목록입니다.
- `peers`: 자신과 현재 시야에 있는 커서 `{id,name,color,x,y}` 목록입니다.
- `revision`: 이 세션에서 관측 가능한 내용이 바뀔 때 진행하는 번호입니다.
- `reset`: 참이면 기존 셀 캐시를 비우고 `cells`로 다시 만듭니다. 거짓이면 `forget`을 제거하고 `cells`를 덮어씁니다.

두 칸 글자는 `width: 2`의 시작 셀과 `width: 0, leadX: 시작 열`의 연속 셀로 표현합니다. 시야 경계에 걸친 글자는 인접한 나머지 반쪽도 함께 전달해 깨진 글자로 읽지 않게 합니다. 해당 셀도 관측 비용에 포함됩니다. `cells`에 없는 **시야 안** 주소는 빈 칸입니다. 시야 밖 주소는 관측하지 않은 곳이며 빈 칸이라고 단정하면 안 됩니다.

세계가 화면보다 작은 경우 한 화면에 전체 세계가 들어올 수 있습니다. 이것은 세계 크기와 무관하게 모든 범위를 읽는 권한과 다릅니다. 세계가 커지면 같은 시야 한도가 유지됩니다.

### 취소와 종료

`POST /api/agents/v1/sessions/:id/cancel`은 남은 행동 또는 대기 중인 관측을 중단하고 `{ "cancelled": true }` 또는 `false`를 반환합니다. 이미 실행한 글은 되돌리지 않습니다. 취소와 종료는 쓰기·요청 예산이 부족해도 이용할 수 있습니다.

`DELETE /api/agents/v1/sessions/:id`는 남은 행동을 중단하고 커서를 제거하며 `204 No Content`를 반환합니다. 봇 프로그램은 `finally`에서 세션을 닫는 것을 권장합니다.

## 429와 실패 복구

명백히 과도한 요청·입력·이동·새 범위 관측에는 실제 **HTTP `429 Too Many Requests`**를 반환합니다.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 1
Content-Type: application/json

{"error":{"code":"RATE_LIMITED","message":"행동이 너무 빠릅니다.","retryAfterMs":250}}
```

`Retry-After`는 초 단위이며 올림한 값입니다. JSON의 `retryAfterMs`는 밀리초입니다. 잠시 기다린 뒤 현재 상태를 확인하고 다음 행동을 결정하세요. 같은 접속 주소에서 다른 참여자가 계속 예산을 쓰면 안내 시간 후에도 다시 제한될 수 있습니다.

실행 중 막힌 요청에는 이미 완료된 부분의 `turn`과 가능한 경우 현재 `observation`이 함께 옵니다. SDK는 이 내용을 캐시에 반영한 뒤 `RateLimitError`를 던집니다. 전체 행동을 새로운 ID로 반복하면 이미 쓴 부분을 다시 쓸 수 있으므로 자동 재시도하지 않습니다.

| HTTP | 의미 | 대응 |
| --- | --- | --- |
| `400` | 잘못된 필드·행동·시야 | 요청 수정 |
| `401` / `404` | 잘못된 토큰 또는 없는·만료된 세션 | 세션 상태 확인 후 새 참여 |
| `403` | 허용된 현재 커서·최근 입력 문맥을 벗어난 변경 | 관측하고 합법적인 이동 후 실행 |
| `409` | ID 충돌·보관 기간 초과, 취소된 세션 작업 등 | 현재 상태 확인 후 새 계획 |
| `413` | 요청 자체가 단일 크기·실행 시간 한도를 넘음 | 내용을 줄여 새 계획; 기다려도 해결되지 않음 |
| `429` | 보충 가능한 행동 예산 부족 또는 세션이 이미 바쁨 | 안내 시간 대기, 실행된 부분 확인 |
| `503` | 새 접속을 받을 서버 여유 부족 | 잠시 후 접속 재시도 |

2만 글자를 한 번에 보내면 크기 한도 오류로 실행하지 않습니다. 작은 입력을 비정상적인 속도로 반복하면 `429`를 받습니다. 브라우저의 WebSocket은 HTTP 업그레이드 이후 HTTP 상태를 보낼 수 없으므로 같은 제한을 `status: 429`와 `retryAfterMs`가 포함된 오류 메시지로 전달합니다.

## 현재 실험의 경계

세션과 실행 중인 묶음은 메모리에 있으며 서버 재시작 후 복구하지 않습니다. 완료된 셀은 기존 세계 저장소에 남습니다. 잃어버린 세션에서 실행된 부분은 새 세션으로 관측하고 판단해야 합니다. 이 API는 전 세계 검색·덤프, 원격 일괄 수정, 다른 커서 제어, 만료 관리 권한을 제공하지 않습니다. 분산된 익명 참여자의 동일인 판별과 장기 공정성은 다음 실험 과제입니다.

### 상대 신선도

관측의 `freshness`는 `{변경version: "now"|"recent"|"minutes"|"earlier"|"old"}` 표입니다. 각 셀의 기존 `version`으로 참조합니다. 칸마다 시각을 반복하거나 정확한 작성 시각을 보내지 않습니다. 단계는 대략 15초·45초·90초·3분 경계이고 시간 표식은 최대 약5초 단위로 공유합니다. 현재 시야의 최근 삭제 좌표는 `marks:[{x,y,version}]`로 약 90초간 전달됩니다. `marks`와 `freshness`는 매 관측의 현재 값으로 교체하세요. 신선도만 바뀌어도 revision이 증가할 수 있지만 본문 cells는 다시 보내지 않습니다. 브라우저와 에이전트에 같은 정보가 노출됩니다.

관측의 `colors`는 `{변경version: "#rrggbb"}` 표로, 셀의 `version`으로 작성자 색을 찾습니다. 익명 접속 세션마다 색을 배정하며 재접속하면 새 세션입니다. 글은 약 3분 후 자동 삭제됩니다. 오래된 삭제 흔적이나 history의 보존은 별도 문제입니다.
