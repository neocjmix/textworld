# 실행 검증 — 2026-11-02

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
- 운영 HTTPS 배포, abuse 대응, 인증/권한, history 보존 기한과 compaction. 공개 인터넷 서비스로 배포하지 않았다.
- 크기 변경에 대한 사용자 인지 실험. 현재 확장은 경계 문장 인접성을 유지하지 못하며, GPS 장소/좌표 링크는 resize에 안정적이지 않다.

다음 실험: 같은 경계 문장·커서·GPS anchor fixture에 정수 torus와 immutable 행/열 ID의 빈 strip 변환을 적용하고, 글자 충돌, 인접성 단절, 사용자 커서 이동 거리, GPS 재방문 거리를 비교한다.
