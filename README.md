# Textworld

공개 실험: **https://textworld-production-987c.up.railway.app** · [Railway 운영 안내](docs/DEPLOYMENT.md) · [UI 명칭 사전](docs/UI_GLOSSARY.md)

A shared, spatial, real-time text world. People inhabit a 2D character grid as visible cursors, move, read, and overwrite cells together.

## Principles
- Public world uses toroidal topology and density-responsive expansion/contraction.
- Writing overwrites cells, never inserts or shifts neighboring content.
- Each user is represented by a visible, single-cell cursor. The current map interface keeps your cursor at the visible screen center; scrolling the world moves your presence and input position.
- Zoom is bounded; GPS determines initial placement and supports return to current geographic position.
- Public text is ephemeral. An independent scavenger can use cell provenance and history to remove old or damaged content.
- Future private worlds may choose different topology, persistence, deterministic growth, and scavenger policies.
- Mobile usability matters.

See [AGENTS.md](AGENTS.md) for agent operating instructions. The product principles are binding; implementation details remain open for autonomous exploration.

## 실행 — 실험 003: 한글 조합·문자 폭·관성 탐색

Node.js **24 이상**이 필요합니다. Node 내장 SQLite와 `ws`만 서버 런타임에 사용합니다.

```sh
npm ci
npm start
```

`http://localhost:3000`을 서로 다른 브라우저나 창 두 개에서 여세요. 서버는 기본적으로 `0.0.0.0:3000`에서 수신합니다. 같은 서버에 접속하면 글자와 커서를 공유합니다. `이곳 링크`로 특정 칸을 공유할 수 있습니다. 다른 기기에서 GPS·클립보드를 쓰려면 HTTPS가 필요합니다. localhost에서는 브라우저가 이를 허용합니다.

- 지도가 브라우저 화면 전체를 채우며 내 커서는 항상 보이는 지도 화면의 중심에 있습니다. 별도 입력 패널은 없습니다.
- 드래그·가로/세로 스크롤로 지도를 움직여 중심에 입력할 칸을 가져오세요. 드래그를 빠르게 놓으면 관성으로 이동하다 감속하며, 입력하거나 지도를 다시 잡으면 멈춥니다. 트랙패드는 OS가 보낸 이동량을 부드럽게 전달하며 관성을 중복해서 더하지 않습니다. 지도 이동 자체가 내 커서의 세계 좌표를 바꾸며 다른 사용자에게도 전달됩니다.
- 지도를 클릭/탭하면 현재 중심 셀에서 네이티브 키보드 입력을 받습니다. 탭한 곳으로 커서를 옮기지는 않습니다. 모바일에서는 OS 키보드가 열립니다. 한글 조합은 OS 입력 문맥을 유지하며 처리합니다. 영문·숫자 등 반각 문자는 1칸, 한글·한자·전각 문자와 이모지 표시 묶음은 2칸을 사용합니다. 바이트 수가 아닌 Unicode 표시 폭 규칙이며, 글꼴은 일반 글꼴을 사용합니다.
- 입력·붙여넣기는 덮어쓰기입니다. 입력하면 글자 폭만큼 진행하며 지도가 따라 움직여 커서는 중심 한 칸에 남습니다. 오른쪽 끝에서 같은 행의 왼쪽으로 이어집니다.
- Enter·Shift+Enter는 이번 글쓰기를 시작한 열의 다음 행으로 갑니다. 모바일 줄바꿈과 여러 줄 붙여넣기도 같은 기준을 씁니다.
- 지도 드래그·스크롤·GPS·좌표 링크는 새 글쓰기 기준을 잡습니다. 글을 쓰는 중 방향키로 오타를 고쳐도 기준 열은 유지됩니다. Home은 현재 행의 작성 기준 열로 돌아갑니다.
- Backspace는 방금 쓴 글자를 지우며, 직접 만든 줄바꿈 직후에는 글자를 지우지 않고 이전 줄 끝으로 돌아갑니다. 위치를 따로 옮겨 작성 경로를 벗어난 경우에는 왼쪽 칸의 글자를 지웁니다. 두 칸 문자는 시작 칸으로 돌아가 두 칸을 함께 지웁니다. Delete는 현재 칸이 속한 글자를 지우고 커서 위치를 유지합니다. 주변 글은 밀리거나 합쳐지지 않습니다.
- `− / +`로 60~200% 확대·축소합니다. 확대·축소나 화면 크기 변경에도 선택한 셀은 중심에 남습니다. 모바일 키보드가 열리면 키보드를 제외한 보이는 지도 영역의 중심을 사용합니다.
- GPS를 허용하면 현재 크기의 세계에 투영합니다. 거절하면 공동 출발점에서 사용할 수 있습니다. 정확한 위도·경도는 전송하지 않습니다.
- 연결이 끊기면 입력을 비활성화하고 다시 연결합니다. 미확정 입력을 자동 재전송하지 않습니다. 재접속 후 내용을 확인하세요.

별도 빌드 단계가 없습니다. `PORT`와 `TEXTWORLD_DB`로 포트·DB 경로를 설정할 수 있습니다. 기본 DB는 `data/world.sqlite`이며 git에서 제외합니다. 재시작하면 셀·출처·현재 크기가 복구됩니다. 한 DB에 서버 **한 프로세스만** 실행하세요.

## 검증

```sh
npm test                    # 엔진 + 실제 WebSocket/HTTP 통합 테스트
npm run test:browser         # 실제 Chromium, 독립 브라우저/모바일 에뮬레이션
npm run test:input           # 조합 취소/모바일 삭제 회귀
npm run test:writing         # Enter·작성 기준·Backspace·native 입력 의도
npm run test:ime             # 실제 Chromium IME의 문맥 보존·치환·연속 조합
npm run test:motion          # 관성·중단·원격 위치·터치·reduced-motion
npm run experiment          # 공간 모델의 결정적 반례 비교
```

브라우저 테스트는 `/usr/bin/chromium`을 사용합니다. 다른 환경에서는 Chromium을 설치하고 `CHROMIUM_PATH`를 설정하세요. 스크린샷은 `artifacts/`에 생성됩니다. 실제 휴대폰의 OS 키보드를 사용한 검증과 모바일 에뮬레이션은 다릅니다. 상세한 실행 증거와 미검증 항목은 [검증 기록](docs/VERIFICATION.md)에 있습니다.

## 별도 scavenger

서버와 별도 프로그램이 같은 `SCAVENGER_TOKEN` 환경변수를 사용하도록 설정한 뒤 실행합니다. 토큰이 없으면 관리 API가 비활성화됩니다.

```sh
node server/scavenger.js
```

기본적으로 24시간 이상 지난 현재 셀을 최대 500개 정리합니다. `TEXTWORLD_URL`, `SCAVENGER_MAX_AGE_MS`로 접속 주소와 수명을 바꿀 수 있습니다. 한 번 실행하고 종료하므로 주기 실행은 운영자가 별도로 구성합니다. 코어에는 나이 정책이 없습니다. 프로그램은 evidence를 읽고 셀 버전이 그대로일 때만 삭제합니다. 읽은 뒤 새로 쓴 글은 지우지 않습니다.

화면에서 지운 글의 과거 버전은 현재 실험 DB의 history에 남습니다. 표시 수명과 데이터 보존 기간은 다릅니다. history 정리 정책은 아직 구현하지 않았습니다.

## 현재 범위

Railway에서 공개 실험 중인 초기 프로토타입입니다. 익명 참여, 단일 서버, 전체 세계 스냅샷/방송, 유한한 실험 크기(32×16~1024×512)를 사용합니다. 확장 시 기존 경계의 글이 떨어질 수 있고, 축소는 점유된 가장자리 때문에 보류될 수 있습니다. GPS 착지점과 공유 좌표 링크는 크기가 바뀌면 과거의 장소를 보장하지 않습니다. 비공개 세계, 분산 권위, 인증, abuse 대응, history 보존 기한은 구현하지 않았습니다.

입력 모델 비교와 동작 규칙은 [입력 설계](docs/INPUT_DESIGN.md)에 기록했습니다. 범위 선택·복사·잘라내기·단어 삭제·실행 취소·일반 문서형 자동 치환은 아직 지원하지 않으며, 시도 시 안내하고 세계를 변경하지 않습니다. 한글 조합처럼 OS가 최근 입력의 끝부분을 바꾸는 경우에는 로컬 작성 경로로 확인되는 최대 32개 글자 안에서 교체를 처리합니다. Tab은 UI 포커스를 옮기고, 붙여넣은 탭은 공백 4칸으로 처리합니다.

폭 규칙 도입 전 저장된 글은 기존 좌표와 이웃 내용을 보존하기 위해 1칸 배치를 유지합니다. 다시 입력한 글부터 새 폭을 적용합니다. 두 칸 문자가 토러스의 좌우 경계에 걸쳐 있으면 그 문자가 정리될 때까지 세계 너비 변경을 보류합니다. 이 두 가지는 기존 데이터와 글자 쌍을 보존하기 위한 현재 실험의 제한입니다.

중요한 선택은 [결정 기록](docs/DECISIONS.md), 대안 비교와 다음 실험은 [공간 모델 실험](docs/EXPERIMENTS.md)을 참고하세요. 제품 헌법은 변경하지 않았습니다.
