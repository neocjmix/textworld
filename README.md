# Textworld

공개 실험: **https://textworld-production-987c.up.railway.app** · [Railway 운영 안내](docs/DEPLOYMENT.md)

A shared, spatial, real-time text world. People inhabit a 2D character grid as visible cursors, move, read, and overwrite cells together.

## Principles
- Public world uses toroidal topology and density-responsive expansion/contraction.
- Writing overwrites cells, never inserts or shifts neighboring content.
- Each user is represented by a visible, single-cell cursor; browsing and scrolling affect presence, and the cursor remains in the viewport.
- Zoom is bounded; GPS determines initial placement and supports return to current geographic position.
- Public text is ephemeral. An independent scavenger can use cell provenance and history to remove old or damaged content.
- Future private worlds may choose different topology, persistence, deterministic growth, and scavenger policies.
- Mobile usability matters.

See [AGENTS.md](AGENTS.md) for agent operating instructions. The product principles are binding; implementation details remain open for autonomous exploration.

## 실행 — 실험 001

Node.js **24 이상**이 필요합니다. Node 내장 SQLite와 `ws`만 서버 런타임에 사용합니다.

```sh
npm ci
npm start
```

`http://localhost:3000`을 서로 다른 브라우저나 창 두 개에서 여세요. 서버는 기본적으로 `0.0.0.0:3000`에서 수신합니다. 같은 서버에 접속하면 글자와 커서를 공유합니다. `이곳 링크`로 특정 칸을 공유할 수 있습니다. 다른 기기에서 GPS·클립보드를 쓰려면 HTTPS가 필요합니다. localhost에서는 브라우저가 이를 허용합니다.

- 칸 클릭/탭 → 아래 입력창에 입력. 한글 조합과 이모지는 grapheme 단위로 한 칸을 차지합니다.
- 입력·붙여넣기는 덮어쓰기입니다. 오른쪽 끝에서 같은 행의 왼쪽으로 이어집니다.
- 방향키 이동, Enter는 같은 열의 다음 행, Backspace는 왼쪽 칸 삭제, Delete는 현재 칸 삭제입니다.
- 드래그·스크롤로 탐색하고 `− / +`로 확대·축소합니다. 커서는 항상 화면 안에 있습니다.
- GPS를 허용하면 현재 크기의 세계에 투영합니다. 거절하면 공동 출발점에서 사용할 수 있습니다. 정확한 위도·경도는 전송하지 않습니다.
- 연결이 끊기면 입력을 비활성화하고 다시 연결합니다. 미확정 입력을 자동 재전송하지 않습니다. 재접속 후 내용을 확인하세요.

별도 빌드 단계가 없습니다. `PORT`와 `TEXTWORLD_DB`로 포트·DB 경로를 설정할 수 있습니다. 기본 DB는 `data/world.sqlite`이며 git에서 제외합니다. 재시작하면 셀·출처·현재 크기가 복구됩니다. 한 DB에 서버 **한 프로세스만** 실행하세요.

## 검증

```sh
npm test                    # 엔진 + 실제 WebSocket/HTTP 통합 테스트
npm run test:browser         # 실제 Chromium, 독립 브라우저/모바일 에뮬레이션
npm run test:input           # 조합 취소/모바일 삭제 회귀
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

중요한 선택은 [결정 기록](docs/DECISIONS.md), 대안 비교와 다음 실험은 [공간 모델 실험](docs/EXPERIMENTS.md)을 참고하세요. 제품 헌법은 변경하지 않았습니다.
