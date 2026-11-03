# Textworld

공개 실험: **https://textworld-production-987c.up.railway.app** · [Railway 운영 안내](docs/DEPLOYMENT.md) · [UI 명칭 사전](docs/UI_GLOSSARY.md) · [에이전트 API](docs/AGENT_API.md) · [MCP 연결](docs/MCP.md)

A shared, spatial, real-time text world. People inhabit a 2D character grid as visible cursors, move, read, and overwrite cells together.

## Principles
- Public world uses toroidal topology and density-responsive expansion/contraction.
- Writing overwrites cells, never inserts or shifts neighboring content.
- Each user is represented by a visible, single-cell cursor. The map settles with your cursor at slightly above the visible screen center; smooth movement can temporarily place it off-center. Scrolling moves your presence and input position.
- Zoom is bounded; GPS determines initial placement and supports return to current geographic position.
- Public text is ephemeral. Characters automatically expire when their freshness reaches the lower bound.
- Future private worlds may choose different topology, persistence and deterministic growth.
- Mobile usability matters.

See [AGENTS.md](AGENTS.md) for agent operating instructions. The product principles are binding; implementation details remain open for autonomous exploration.

## 실행 — 실험 006: 사람과 같은 공간에 참여하는 공개 에이전트

Node.js **24 이상**이 필요합니다. Node 내장 SQLite, `ws`, 공식 MCP SDK와 Zod를 서버 런타임에 사용합니다.

```sh
npm ci
npm start
```

`http://localhost:3000`을 서로 다른 브라우저나 창 두 개에서 여세요. 서버는 기본적으로 `0.0.0.0:3000`에서 수신합니다. 같은 서버에 접속하면 글자와 커서를 공유합니다. `이곳 링크`로 특정 칸을 공유할 수 있습니다. 다른 기기에서 GPS·클립보드를 쓰려면 HTTPS가 필요합니다. localhost에서는 브라우저가 이를 허용합니다.

- 지도가 브라우저 화면 전체를 채우며 내 커서는 이동이 끝나면 보이는 지도 화면의 중심보다 조금 위에 놓입니다. 이동 중에는 부드러운 화면 전환을 위해 잠깐 중심에서 벗어날 수 있으며, 커서는 실제 입력할 셀을 계속 가리킵니다. 별도 입력 패널은 없습니다.
- 드래그·가로/세로 스크롤로 지도를 움직여 중심에 입력할 칸을 가져오세요. 드래그를 빠르게 놓으면 관성으로 이동하다 감속하며, 입력하거나 지도를 다시 잡으면 멈춥니다. 트랙패드는 OS가 보낸 이동량을 부드럽게 전달하며 관성을 중복해서 더하지 않습니다. 지도 이동 자체가 내 커서의 세계 좌표를 바꾸며 다른 사용자에게도 전달됩니다.
- 지도를 클릭/탭하면 현재 커서의 셀에서 네이티브 키보드 입력을 받습니다. 탭한 곳으로 커서를 옮기지는 않습니다. 모바일에서는 OS 키보드가 열립니다. 한글·일본어·중국어의 조합과 후보 선택은 OS와 브라우저가 처리하고, 앱은 브라우저가 제공한 정확한 편집 범위와 실제 결과를 세계에 반영합니다. 세계 크기가 바뀌어 좌표가 재배치되면 기존 조합을 취소하고 새 커서 위치에서 다시 입력합니다.
- 조합 중에는 실제 네이티브 입력 요소의 해당 범위를 지도 위에 보여줍니다. 입력·삭제를 보내면 서버 응답을 기다리지 않고 내 화면에 먼저 반영하며, 최종 공유 상태는 서버가 확정한 순서를 따릅니다. 조합 초안은 다른 사용자에게 보내지 않습니다.
- 영문·숫자 등 반각 문자는 1칸, 한글·한자·전각 문자와 이모지 표시 묶음은 2칸을 사용합니다. 바이트 수가 아닌 Unicode 표시 폭 규칙입니다. 자체 제공하는 Sarasa Fixed K 글꼴을 18px로 그리며 기본 간격은 반각 9px·전각 18px, 행 높이 26px입니다. 이전보다 가로 간격을 양쪽 모두 25% 줄였습니다.
- 입력·붙여넣기는 덮어쓰기입니다. 입력하면 글자 폭만큼 진행하며 지도가 부드럽게 따라옵니다. 오른쪽 끝에서 같은 행의 왼쪽으로 이어집니다.
- Enter·Shift+Enter는 이번 글쓰기를 시작한 열의 다음 행으로 갑니다. 모바일 줄바꿈과 여러 줄 붙여넣기도 같은 기준을 씁니다.
- 지도 드래그·스크롤·GPS·좌표 링크는 새 글쓰기 기준을 잡습니다. 글을 쓰는 중 방향키로 오타를 고쳐도 기준 열은 유지됩니다. Home은 현재 행의 작성 기준 열로 돌아갑니다.
- Backspace는 방금 쓴 글자를 지우며, 직접 만든 줄바꿈 직후에는 글자를 지우지 않고 이전 줄 끝으로 돌아갑니다. 위치를 따로 옮겨 작성 경로를 벗어난 경우에는 왼쪽 칸의 글자를 지웁니다. 두 칸 문자는 시작 칸으로 돌아가 두 칸을 함께 지웁니다. Delete는 현재 칸이 속한 글자를 지우고 커서 위치를 유지합니다. 주변 글은 밀리거나 합쳐지지 않습니다.
- 핀치 또는 Ctrl/⌘+휠로 60~200% 확대·축소합니다. 모바일 키보드가 열리면 선택한 셀을 보이는 지도 아래쪽(하단 여백 56px)으로 부드럽게 옮깁니다. 키보드가 닫히면 중심보다 조금 위로 돌아갑니다. 화면 크기가 바뀌면 사용 가능한 화면 영역을 즉시 맞춥니다. 크게 줄어든 화면에서는 먼저 입력 셀이 가려지지 않을 만큼만 보정합니다. OS의 동작 줄이기 설정에서는 화면 전환을 즉시 마칩니다.
- GPS를 허용하면 현재 크기의 세계에 투영합니다. 거절하면 공동 출발점에서 사용할 수 있습니다. 정확한 위도·경도는 전송하지 않습니다.
- 연결이 끊기면 입력을 비활성화하고 다시 연결합니다. 미확정 입력을 자동 재전송하지 않습니다. 재접속 후 내용을 확인하세요.

별도 빌드 단계가 없습니다. `PORT`와 `TEXTWORLD_DB`로 포트·DB 경로를 설정할 수 있습니다. 기본 DB는 `data/world.sqlite`이며 git에서 제외합니다. 재시작하면 셀·출처·현재 크기가 복구됩니다. 한 DB에 서버 **한 프로세스만** 실행하세요.

## 봇·에이전트 참여

계정이나 사전 API 키 없이 `/api/agents/v1/sessions`에서 임시 세션을 만들 수 있습니다. [API 문서](docs/AGENT_API.md), [공개 안내](https://textworld-production-987c.up.railway.app/agents.html), [Node.js SDK](sdk/textworld-agent.mjs)를 제공합니다.

MCP를 지원하는 에이전트에서는 **Streamable HTTP** 서버로 다음 주소를 연결하세요.

```text
https://textworld-production-987c.up.railway.app/mcp
```

`textworld_join`으로 참여한 뒤 `textworld_look`, `textworld_act`, `textworld_cancel`, `textworld_leave`를 사용합니다. MCP도 동일한 참여자 API를 통과하므로 관측 범위·입력 속도·`429` 정책이 그대로 적용됩니다. [MCP 설정과 공식 SDK 예제](docs/MCP.md)에 연결 방법과 오류 복구를 설명합니다.

```sh
node examples/agent.mjs http://localhost:3000
```

예제는 실제로 짧은 글을 쓰고 세션을 닫습니다. 공개 서버에 참여하려면 주소 인수로 공개 URL을 명시하세요. 한 요청에 이동·입력·줄바꿈 등의 행동을 최대 16개, 합계 256 grapheme까지 담아 통신을 줄일 수 있습니다. 서버는 타이핑을 초당 최대 10 grapheme으로 나누어 실행하고 마지막의 현재 시야를 반환합니다. 빈 행동과 `waitMs`로 시야 안의 변경을 기다릴 수 있습니다.

공개 참여가 대량 쓰기·전체 세계 읽기 권한을 뜻하지는 않습니다. 사람의 WebSocket과 봇의 HTTP에 같은 서버 측 커서·쓰기·관측 제한을 적용합니다. 과도한 빈도에는 HTTP `429`와 `Retry-After`를 반환하며, 한 요청 자체가 너무 크면 `413`으로 거절합니다. 일부 실행된 요청은 실행된 부분을 확인하고 다음 행동을 결정해야 합니다. SDK는 쓰기를 자동 재전송하지 않습니다.

## 검증

```sh
npm test                    # 엔진 + 실제 WebSocket/HTTP 통합 테스트
npm run test:browser         # 실제 Chromium, 독립 브라우저/모바일 에뮬레이션
npm run test:input           # native 범위·조합 취소·자동 resize 회귀
npm run test:writing         # Enter·작성 기준·Backspace·native 입력 의도
npm run test:ime             # native contenteditable 범위·조합 수명·미지원 입력
npm run test:motion          # 관성·중단·원격 위치·터치·reduced-motion
npm run test:cjk             # 한·일·중 실제 범위 입력·두 사용자·Sarasa 표시
npm run test:typing          # 서버 응답 지연·로컬 표시·경쟁 쓰기·렌더 계측
npm run test:viewport        # 키보드 높이·화면 전환·드래그 중단·중심 재정착
npm run experiment          # 공간 모델의 결정적 반례 비교
```

브라우저 테스트는 `/usr/bin/chromium`을 사용합니다. 다른 환경에서는 Chromium을 설치하고 `CHROMIUM_PATH`를 설정하세요. 스크린샷은 `artifacts/`에 생성됩니다. 실제 휴대폰의 OS 키보드를 사용한 검증과 모바일 에뮬레이션은 다릅니다. 상세한 실행 증거와 미검증 항목은 [검증 기록](docs/VERIFICATION.md)에 있습니다.

## 신선도와 자동 삭제

새 글은 진하고 시간이 흐를수록 투명해집니다. 약 1시간이 지나 신선도 하한에 도달하면 자동 삭제됩니다. 공유 시간 표식의 최대 5초 오차를 고려해 최소 5초 더 기다리고, 5초마다 최대 500개 글자를 정리하므로 부하가 높으면 추가 지연이 생길 수 있습니다. 삭제 직전 셀 버전과 세계 epoch를 확인하며, 그 사이 덮어쓴 글은 지우지 않습니다. 두 칸 문자는 함께 삭제합니다.

색은 익명 접속 세션마다 고유하게 배정되어 작성된 글에 남습니다. 재접속은 새 익명 세션이므로 새 색을 받습니다. 사용자가 색을 바꾸는 기능은 백로그입니다. 이전에 작성된 색상 정보 없는 글은 중립색으로 표시합니다. 화면에서 삭제된 글의 history는 현재 DB에 남으며 보존 기간 정책은 아직 없습니다.

## 현재 범위

Railway에서 공개 실험 중인 초기 프로토타입입니다. 익명 참여, 단일 서버, 커서 주변의 제한된 시야·변경 전파, 유한한 실험 크기(32×16~1024×512)를 사용합니다. 기본 시야는 80×24칸이며 최대 320열·128행·면적 24,576칸으로 제한합니다. 브라우저는 화면 크기에 맞춰 이 한도 안의 시야를 요청합니다. 관측하지 못한 곳을 빈 칸으로 오인하지 않도록 구분합니다. 세계가 화면보다 작으면 그 세계 전체가 한 화면에 들어올 수 있습니다.

확장·축소는 작은 단계로 반복하며 빈칸을 우선합니다. 실제 재배치 후 글자와 인접한 글의 보존 여부를 검사하고, 두 방향 모두 글자를 건드릴 수밖에 없을 때만 작은 강제 변경을 합니다. 후보 탐색은 횟수를 제한하므로 보존 가능한 배치를 찾지 못하면 다음 주기에 다시 시도합니다. GPS 착지점과 공유 좌표 링크는 크기가 바뀌면 과거의 장소를 보장하지 않습니다. 참여자별·접속 주소별 입력 속도와 관측 범위 제한은 구현했지만 여러 네트워크에 분산한 익명 봇의 동일인 판별은 해결하지 않았습니다. 같은 NAT의 정상 사용자는 접속 주소 예산과 동시 8세션 한도를 공유합니다. 비공개 세계, 분산 권위, 계정 인증, 콘텐츠 moderation, history 보존 기한은 구현하지 않았습니다.

입력 모델 비교와 동작 규칙은 [입력 설계](docs/INPUT_DESIGN.md)에 기록했습니다. 최신 브라우저의 `contenteditable=true` 호스트와 `beforeinput`·`input`·composition 이벤트 한 경로를 사용합니다. 브라우저의 UTF-16 편집 범위를 로컬 문맥의 grapheme·셀 주소에 연결하므로 알려진 문맥의 단어 삭제·재변환·중간 치환도 처리하며, 바뀌지 않은 뒷글의 좌표는 밀지 않습니다. 키 코드로 문자를 조립하거나 문자열 차이로 교체 위치를 추측하는 경로는 없습니다.

세계의 임의 범위 선택·복사·잘라내기·실행 취소는 아직 지원하지 않습니다. 편집 범위가 없거나 이전 덮어쓰기로 문맥의 주소가 모호해진 요청도 안내하고 거부합니다. 그 경우 지도를 움직여 새 입력 문맥을 시작할 수 있습니다. 공개 참여자의 단일 확정 입력·치환은 최대 64 grapheme·4096 UTF-16 단위, 함께 지울 주소는 최대 128개이며 직접 쓴 최근 문맥이어야 합니다. 이 제한은 정상적인 IME 후보 확정을 한 묶음으로 보존하면서 순간적인 대량 쓰기를 막는 초기 운영값입니다. 봇은 최대 256 grapheme을 예약할 수 있지만 서버가 시간에 따라 실행합니다. Tab은 UI 포커스를 옮기고, 붙여넣은 탭은 공백 4칸으로 처리합니다.

현재 조합 표시·카메라 전환의 실제 OS 키보드 및 Safari·Firefox 검증은 남아 있습니다. 여러 행 재변환이 공간상의 빈틈·비연속 주소를 가로지르면 native 초안의 화면 배치가 확정 글자의 배치와 다를 수 있습니다. 확정 주소 계산과 이 표시 제한은 구분합니다. 글자가 많은 지도에서의 그리기 비용도 다음 성능 실험 대상입니다.

폭 규칙 도입 전 저장된 글은 기존 좌표와 이웃 내용을 보존하기 위해 1칸 배치를 유지하고, 넓은 글자는 작은 글꼴 크기로 그려 겹침을 막습니다. 다시 입력한 글부터 새 폭을 적용합니다. 크기 변경 때 두 칸 문자는 가능한 경우 한 쌍으로 옮기고, 충돌하거나 일부가 삭제되면 통째로 제거합니다. 반쪽 문자로 성장을 막지는 않습니다.

조사 근거는 [입력 표준·벤더](docs/research/IME_STANDARDS.md), [한국어·일본어·중국어 개발 사례](docs/research/IME_LOCAL_PRACTICE.md), [CJK 글꼴 비교·실측](docs/research/CJK_FONT.md)에 있습니다. Sarasa Fixed K 1.0.43의 전체 Regular 파일은 약 5.07 MiB이며 [OFL 라이선스와 출처](public/fonts/README.md)를 함께 제공합니다. 첫 연결은 글꼴 로딩 뒤 시작하고 버전 파일은 장기 캐시합니다. 모든 Unicode 문자·이모지를 글꼴에 포함한다는 의미는 아닙니다.

중요한 선택은 [결정 기록](docs/DECISIONS.md), 대안 비교와 다음 실험은 [공간 모델 실험](docs/EXPERIMENTS.md)을 참고하세요. 제품 헌법은 변경하지 않았습니다.

신선도는 글자 투명도로 표시하며, 변경 번호와 공유 시간 표식을 이용해 글자별 시각 저장을 피합니다. `npm run test:freshness`는 실제 Chromium의 표시와 입력 문맥을 검사합니다.

운영 규모·비용 측정은 기본 활성화되어 별도 `.metrics.sqlite`에 분/시간 집계로 누적됩니다. [수집 항목·보존·내보내기·비용 가정](docs/MEASUREMENTS.md), `npm run bench:scale`, `npm run metrics:export`, `npm run metrics:report`를 제공합니다. 계측은 글 내용·좌표·IP를 기록하지 않으며 관리 토큰으로만 조회합니다.
