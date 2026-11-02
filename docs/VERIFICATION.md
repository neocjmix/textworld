# 실행 검증 — 2026-11-02

## 한글 조합·CJK 표시 폭·관성 탐색

| 실행 | 결과 | 확인한 범위 |
| --- | --- | --- |
| `npm test` | 53/53 통과 | 기존 엔진/네트워크, Unicode 폭, 두 칸 원자 변경·scavenger·DB 이전/백업, 관성 시간 계산 |
| `npm run test:browser` | 25/25 통과 | 전체 화면 지도와 중심 커서, 두 클라이언트, GPS·줌·터치·재접속 |
| `npm run test:input` | 10/10 통과 | 조합 취소·snapshot·탐색 뒤 늦은 입력 억제, 주소 보존 resize와 불확정/이동 취소 구분 |
| `npm run test:writing` | 20/20 통과 | 기존 작성 의도 및 실제 native 한글 범위 치환, 두 번째 칸 삭제·덮어쓰기 |
| `npm run test:ime` | 9/9 통과 | native Chromium 문맥 보존, 연속 음절, 누락된 isComposing, 늦은 companion, 확정 Enter |
| `npm run test:motion` | 10/10 통과 | 실제 Chromium mouse/touch flick, 원격 presence, 입력/IME/탭/핀치/줌 등 중단, wheel 총량, reduced-motion |

총 127개 자동 검사를 실제 실행했다. 별도로 난수 120개 fixture에서 혼합 문자를 한 번/나누어 썼을 때 최종 셀·폭·쌍 버전이 일치하는지 확인했다. 이 추가 실험은 자동 검사 수에 더하지 않았다.

- 기존 앱에서 native `ㅎ` 입력 뒤 `replacementStart:0,replacementEnd:1`로 `하 → 한`을 확정하면 `ㅎ한`이 남는 실패를 실제 Chromium CDP로 재현했다. 수정 후 한 글자로 치환되며 다음 음절도 중복 없이 이어진다.
- 통합 중 snapshot 뒤 늦은 완료가 다시 쓰이는 회귀를 발견했다. Chromium이 일부 inputType을 빈 값으로 전달하는 경우까지 취소 상태로 억제하고 새 정상 입력에서 해제하도록 수정했다.
- 첫 Railway 공개 입력 점검에서 한글 치환이 실패했고 같은 코드 재시도는 통과했다. 세계 크기 변경 기록을 단서로, `ㅎ` 확정 뒤 주소가 그대로인 density resize를 끼워 넣어 `ㅎ한` 중복을 로컬에서 재현했다. 모든 snapshot을 무조건 초기화하던 통합 처리를 수정했다. 서버가 주소 보존을 명시하고 입력 확정·동일 커서·유효한 작성 경로가 확인되면 조합 전/중 문맥을 유지한다. 미확정 쓰기·실제 좌표 변경·복구 snapshot의 늦은 완료는 여전히 취소하는 검사와, 주소는 남아도 토러스 경계 인접성이 바뀌는 확장에서는 취소하는 검사를 합쳐 5개 추가했다.
- 실제 pointerup 시각보다 RAF timestamp가 앞서는 경우 관성이 곧바로 취소되는 실패를 같은 단조 시계 사용으로 수정했다. 휠의 합계가 부동소수 오차로 마지막 한 칸에 못 미치는 실패도 수정했다.
- `ABCDEF`, `가나다`, `ＡＢＣ`, `é1한🙂`가 각각 6개 기본 칸을 사용한다. 일반 Arial/sans-serif를 사용하며 좁은 칸 12px, 넓은 문자 24px 간격이다. 두 번째 칸 덮어쓰기와 토러스 경계 표시를 실제 열어 확인했다.
- 시각 산출물: `artifacts/cjk-desktop.png`, `cjk-mobile.png`, `cjk-composition.png`, `cjk-seam.png`, `cjk-width-mobile.png`. 혼합 폭과 조합 밑줄, 중심 커서가 일치했다. 넓은 라틴 글자는 할당 폭에 맞춰 압축될 수 있고, 다른 사용자의 이름표가 윗행을 가리는 기존 표시 한계는 남아 있다.
- 기존 영구 DB의 폭 컬럼 추가 전에 일관된 SQLite 백업을 만들며, 실패하면 이전을 진행하지 않는 것을 검증했다. 기존 셀의 주소·내용·버전은 유지한다. 이전 기록은 1칸 폭, 새 입력부터 새 폭이다.

기존 쓰기 시나리오의 토러스 검사가 한 차례 5초 제한에 걸렸지만, 조건을 바꾸지 않은 단독/전체 재실행은 통과했다. 확정 원인은 찾지 못했으며 다음 실패에 좌표·pending·안내 문구를 남기도록 진단을 추가했다.

실제 iOS/Android 키보드는 아직 검증하지 않았다. 다음 실험은 기기별 한글 후보 확정·자동 교정과, 터치 관성 감속/정지 촉감을 확인하는 것이다. 경계에 걸친 두 칸 문자가 있는 동안 너비 변경을 보류하는 정책과 최근 32글자 치환 한도는 현재 실험의 제한이다.

## Enter와 공간 글쓰기 재설계

기존 구현에서 `ABC` 뒤 Enter가 현재 열의 아래로 가는 반면, `ABC\nD` 붙여넣기는 입력 시작 열로 돌아가는 차이를 실제 실행으로 재현했다. 줄바꿈 직후 Backspace가 무관한 다음 행의 왼쪽 셀을 지우는 반례도 확인했다. 비교한 모델과 선택은 [INPUT_DESIGN.md](INPUT_DESIGN.md), 결정은 D009에 기록했다.

| 실행 | 결과 | 확인한 범위 |
| --- | --- | --- |
| `npm test` | 26/26 통과 | 공통 쓰기 계획, 작성 기준·이벤트 분할·토러스·탭 경로, 잘못된 기준 거부, 기존 요청 호환, 실제 WebSocket 동기화와 기존 엔진 불변식 |
| `npm run test:browser` | 25/25 통과 | 전체 화면 지도, 중심 커서, 독립 클라이언트, 스크롤·터치·GPS·줌·재접속·native Chromium IME |
| `npm run test:input` | 5/5 통과 | 조합 완료·취소·늦은 완료 억제와 빈 textarea의 모바일 삭제 경로 |
| `npm run test:writing` | 18/18 통과 | Enter·Shift+Enter·CRLF paste·mobile newline·Backspace·오타 교정·Home·미지원 입력의 무변경 |

총 74개 자동 검사를 실제 실행했다. 새 브라우저 시나리오는 각각 독립 클라이언트 두 개를 사용하며 최종 위치가 상대에게 전달되고 커서가 화면 중심에 남는지 확인한다.

- Enter는 0열이 아닌 작성 시작 열의 다음 행으로 이동한다. 연속 빈 줄과 줄바꿈만 입력한 경우 셀 내용과 쓰기 순번은 바뀌지 않는다.
- Backspace는 실제 작성 경로의 글자를 지우고, 줄바꿈에서는 이전 입력 위치로 이동만 한다. 주변 글은 남으며 토러스 경계에서도 같다.
- 작성 전 방향키는 시작 열을 정하지만, 작성 중 방향키·Backspace로 오타를 고쳐도 시작 열이 유지된다. 지도 탐색·좌표 링크는 새 기준을 잡는다. Home·줌·도움말·확정된 재접속은 기준을 보존한다.
- 선택·복사·잘라내기 단축키와 clipboard 이벤트, 특히 Shift+Delete가 셀 삭제로 오인되지 않음을 확인했다. undo·단어 삭제·자동 치환도 새 글로 재삽입하지 않는다.
- native Chromium IME 확정과 다음 Enter를 구분했다. 모바일 beforeinput/input 변형과 일부 조합 이벤트 순서는 명시적 이벤트 시뮬레이션이다. 실제 iOS/Android 키보드 검증으로 간주하지 않는다.
- 로컬 세계에 한글 세 줄을 실제 입력해 `artifacts/writing-desktop.png`, `artifacts/writing-mobile.png`를 저장하고 열어 확인했다. 모든 행의 시작 열과 중앙 커서가 일치했다. 좁은 도움말에서 단축키 설명이 어색하게 끊기는 점은 키별 한 행으로 정리했다.
- 마지막 도움말 표시 변경은 390×844, 320×568, 390×520에서 별도 확인했다. 수평 overflow가 없고, 내부 스크롤로 모든 안내와 닫기 버튼에 접근할 수 있었다. 공개 Railway 배포 후의 코드 일치·두 브라우저 presence 점검은 [배포 기록](DEPLOYMENT.md)에 남겼다.

다음 입력 실험은 실제 휴대폰에서 한국어 후보 확정·줄바꿈·자동 교정·삭제를 확인하고, 여러 행 글쓰기와 오타 수정 과제에서 지도 탐색/방향키에 따른 작성 기준이 예측 가능한지 관찰하는 것이다.

## 전체 화면 지도 개편

사용자 요청에 따라 월드맵을 전체 화면으로 바꾸고 중심 셀을 고정했다. `npm test` 19/19, `npm run test:browser` 25/25, `npm run test:input` 5/5를 실제 실행해 통과했다. 아래 최초 구현 검증과 구분한다.

- 화면 중심과 셀 중심의 수학적 일치 및 native textarea 기준점의 화면 좌표를 검증했다.
- XY 스크롤·드래그·미세 트랙패드 이동 누적이 바로 중심 셀과 다른 사용자가 보는 위치를 변경한다.
- 타이핑·삭제·방향키·토러스 경계·줌·재접속 뒤에도 중심을 유지한다.
- 별도 입력 패널 없이 데스크톱 물리 키보드와 모바일 지도 탭에서 native 입력 포커스를 얻는다.
- Chromium native IME에서 한글 조합 미리보기와 최종 1회 기록, 탐색 후 늦은 조합 취소를 검증했다.
- 실제 Chromium 터치 경로로 첫 탭·드래그·두 손가락 핀치를 확인했다. visualViewport 높이와 offset을 바꿔 키보드가 차지한 영역을 제외한 지도 중심을 확인했다.
- 모바일 탭 뒤 호환 mousedown이 입력 포커스를 빼앗던 실패를 pointerdown.preventDefault로 수정했다. 줌 버튼에 남은 데스크톱 포커스 때문에 타이핑이 무시되던 흐름도 수정하고 회귀 검사했다.
- 데스크톱·모바일·짧은 viewport·조합 중 스크린샷을 실제 열어 확인했다. 실제 iOS/Android OS 키보드, Safari/Firefox는 아직 검증하지 않았다.

## 최초 구현 검증

검증 환경: Node.js 24.19.0, Linux Chromium, Playwright. 아래 명령을 실제 실행했다. 제품 헌법 diff는 없다.

| 실행 | 결과 | 확인한 범위 |
| --- | --- | --- |
| `npm test` | 19/19 통과 | 13개 core invariant + 6개 실제 WebSocket/HTTP/별도 프로세스 통합 |
| `npm run test:browser` | 16/16 통과 | 독립 브라우저 2개, 모바일 context, native Chromium IME, GPS 허용·거절·갱신 |
| `npm run test:input` | 4/4 통과 | 조합 완료 1회, snapshot/이동에 의한 조합 취소, mobile beforeinput 삭제 |
| `npm run experiment` | assertion 통과 | 6가지 resize 변환의 충돌·주소 이동·인접성 손실, GPS 착지 변화 |
| `node --check public/app.js` | 통과 | 프런트엔드 문법 |
| `git diff --check` | 통과 | diff 공백 오류 |

## 실제 검증한 동작

- 두 독립 클라이언트가 같은 셀을 경쟁해서 써도 서버 순서와 최종 상태가 일치한다. overwrite/delete는 옆 셀의 글·버전을 바꾸지 않는다.
- 같은 입력 작업을 재전송해도 과거 글자가 되살아나지 않는다. 재접속은 현재 snapshot을 받으며 자동으로 과거 입력을 재생하지 않는다.
- 음수 좌표, 오른쪽/아래 경계, 한 행보다 긴 붙여넣기에서 torus overwrite가 유지된다.
- 한글 자모 조합, combining accent, 국기, ZWJ 가족 이모지를 grapheme으로 다룬다. Chromium CDP의 native IME 경로에서 `ㅎ → 하 → 한` preedit는 전송하지 않고 최종 `한`만 한 칸에 기록했다.
- stale epoch 입력을 거절하고 새 지도를 받는다. 같은 오래된 요청 다발에는 스냅샷을 중복 전송하지 않는다.
- density hysteresis에 따른 확장·축소, 점유된 셀/커서가 있는 band 축소 보류, SQLite 재시작 복구를 검증했다.
- 실제 별도 scavenger 프로세스가 오래된 4칸을 지우고 현재 글을 남겼다. 삭제 패치가 실시간 도착했다. 오래된 evidence로 새 버전을 지울 수 없다.
- GPS의 반대 경도·극점 경계, 허용/거절 시의 진입, GPS 버튼이 갱신된 위치를 다시 읽는 동작을 확인했다. 위치는 브라우저에 모의 제공했으며 실제 GPS 센서는 사용하지 않았다.
- 스크롤/드래그/줌에서 커서가 viewport 안에 남는다. 모바일 터치 선택·입력·드래그, 390×844 및 390×520 화면에 가로 overflow가 없다.
- Chromium pageerror는 없었다. 연결 중단 시 입력 비활성화, 재접속 최신 세계 복구를 확인했다.

렌더링 결과 `artifacts/desktop.png`, `artifacts/mobile.png`, `artifacts/mobile-keyboard-height.png`를 생성하고 직접 열어 확인했다. artifacts는 재생성 가능하며 git에 포함하지 않는다.

독립 검토에서는 재접속 후 `{7,8}` 위치 유지 및 wheel 이벤트 220회 연속 후 연결 유지도 브라우저에서 확인했다. 이 두 점검은 별도의 수동 스크립트 실행이므로 자동 테스트 39개 수에 더하지 않는다.

## 발견하고 고친 실패

1. 탭을 브라우저는 1칸, 서버는 4칸으로 계산했다 → shared writePlan 재사용.
2. 같은 페이지에서 hash만 바뀌면 링크 좌표로 가지 않았다 → hashchange 이동 처리.
3. GPS 복귀가 60초 캐시를 재사용했다 → 명시적 복귀 요청은 maximumAge=0.
4. 재접속 때 이전 위치를 잃었다 → snapshot 수신 후 이전 cursor를 새 epoch에 복원.
5. 빠른 pan의 fractional 이벤트마다 presence를 전송했다 → 40ms 합치기와 동일 위치 생략.
6. stale 요청마다 snapshot을 보냈다 → 연결별 마지막 전송 epoch를 기록.
7. snapshot/이동 후 늦은 조합 완료가 새 위치에 입력될 수 있었다 → active composition 및 취소 상태 검사와 companion input 억제.
8. 빈 textarea에서 mobile Backspace가 input을 만들지 않을 수 있었다 → cancellable beforeinput 삭제를 처리.

## 아직 검증하지 않은 것

- 실제 Android/iOS 한국어 키보드, Safari/Firefox, 모바일 OS 키보드가 만드는 visualViewport 변화. 짧은 viewport 에뮬레이션은 실제 키보드 검증이 아니다.
- 장시간 부하, 200/800ms 지연 비교, 대규모 history·셀 수, 프로세스 crash/fsync 전원 손실, 다중 서버.
- 전체 격자를 읽는 보조기술 접근성. 현재 Canvas 안내/라벨과 native textarea를 제공하지만 읽기 경험은 부족하다.
- abuse 대응, 인증/권한, history 보존 기한과 compaction. 이 최초 검증 이후 Railway HTTPS 배포와 실제 공개 주소의 두 브라우저 동기화는 [배포 기록](DEPLOYMENT.md)에서 추가 검증했다.
- 크기 변경에 대한 사용자 인지 실험. 현재 확장은 경계 문장 인접성을 유지하지 못하며, GPS 장소/좌표 링크는 resize에 안정적이지 않다.

다음 실험: 같은 경계 문장·커서·GPS anchor fixture에 정수 torus와 immutable 행/열 ID의 빈 strip 변환을 적용하고, 글자 충돌, 인접성 단절, 사용자 커서 이동 거리, GPS 재방문 거리를 비교한다.
