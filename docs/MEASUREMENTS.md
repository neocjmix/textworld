# 규모·비용을 판단하기 위한 계측

프로덕션에서 계측은 기본으로 켜진다. 세계 DB와 별도인 `TEXTWORLD_DB.metrics.sqlite`에 분 단위 집계와 시간 단위 집계를 저장한다. SQLite 영구 볼륨을 사용하므로 배포 이후에도 이전 코드의 자료가 남는다. 공개 지도·HTTP 참여자·MCP는 운영 통계 읽기 권한이 없다.

## 무엇을 연결해서 볼 것인가

| 질문 | 수집하는 근거 |
| --- | --- |
| 얼마나 사용했나 | 실제 참여자 세션의 누적 peer-ms, 생성·종료 수, 동시 WS/HTTP 참여자·시야 크기·세계 점유 |
| 어떤 작업이 비싸나 | commit 횟수·변경 셀 수·시간, 시야 계산 횟수·주소 면적·반환량·시간, 전체 전파 시간과 수신자 수 |
| 어느 쪽에서 느린가 | commit/observer 분포, Node event-loop p99/max·활성률, HTTP 경로별 응답 시간, 브라우저 submit→draw·ACK 왕복·draw CPU 분포 |
| 메모리/CPU가 얼마나 필요한가 | process CPU-ms/실제 경과시간, RSS/heap, cgroup CPU·메모리 한도, 빌드별 Node/arch metadata |
| 어디서 데이터가 늘어나나 | 세계 DB/WAL/빈 페이지, 현재 셀·점유 셀, 변경 셀 수, 계측 DB 자체 크기·flush 비용·실패 수 |
| 통신은 어떻게 증폭되나 | WS 실제 JSON payload 송수신 bytes·송신 대기량·느린 연결 종료, HTTP 응답 payload bytes, 요청 Content-Length의 선언값 |
| 정책에 걸린 것인가 | 경로별 HTTP 상태·WS429·turn 완료/차단/취소/진행중·telemetry 거부 |

사용자가 입력한 글·좌표·IP·이름·토큰·세션 ID·전체 URL은 계측에 저장하지 않는다. 경로는 고정된8종류, metric 이름은 허용 목록이다. 배포 revision으로 구분하며, 사람 수로 단정하지 않고 **참여자 세션 시간**으로 계산한다. 브라우저처럼 접속한 봇도 WS에 포함된다.

## 자료의 의미와 한계

- count/sum/min/max와2의 거듭제곱 경계를 가진42칸 histogram을 병합한다. `p95Upper`는 근사 상한이며 정밀한 p95가 아니다. 원시 지연 표본은 저장하지 않는다.
- `process.cpu_ms / process.elapsed_ms`가 해당 구간 평균 CPU 코어 사용량이다. RSS는 주기적 표본이며 컨테이너 전체 과금 메모리와 같지 않다. idle CPU도 비용에 포함된다.
- event-loop histogram의 측정 해상도는20ms다. 정상 baseline 자체가 약20ms일 수 있으므로 순수한 추가 지연으로 해석하지 않는다.
- HTTP 시간에는 long polling·의도된 paced turn 대기와 중도 연결 종료가 포함된다. 이를 서버 계산 지연이나 사용자 입력 지연으로 해석하지 않는다. event-loop·commit·observer 분포와 같이 본다.
- 브라우저 draw는 CPU 그리기 작업 완료 시점이다. 실제 화면 광자 표시나 OS 키보드 전체 지연을 측정한 것이 아니다. draw는첫그리기와이후10번 중1번, submit/ACK는 전체를 최대2000개씩 로컬 집계하여 분당 한 번 보낸다.
- 브라우저 수치는 **client.reported**로 구분한다. 익명 클라이언트가 조작할 수 있으므로 비용·수용 인원의 유일한 증거로 쓰지 않는다. 고정 metric6개·유한값·bin 합계·최대 표본 수를 검사하고 세션당30초보다 빠른 업로드는 버린다.
- HTTP 입력은 선언된 Content-Length이고, egress는 압축 전 application payload다. 헤더·TLS·프록시·재전송·별도 백업 볼륨을 모두 포함하는 청구 카운터가 아니다. Railway의 컨테이너 CPU/메모리/네트워크/볼륨 지표와 대조해야 한다.
- revision별 비교도 작업량·점유·시야·참여자 구성·자원 한도가 다르면 인과 비교가 아니다. 개선 전후에는 동일 fixture와 실제 제공량을 함께 기록한다.

## 저장 비용·고장 범위

분 집계는최대6시간, 시간 집계는최대30일 유지한다. 50,000행 한도가 먼저 적용되면 오래된 분 집계부터 제거한다. 메인 DB는64MiB page 한도, WAL 유지 한도는8MiB로 설정했다. 일시적 WAL·파일시스템 동작까지 정확히 이 크기라고 보장하지 않으며 실제 크기를 함께 기록한다. 배포별 metric·보존기간에 따라 실제 유지되는 기간은 짧아질 수 있다.

최대1분의 아직 flush하지 않은 자료는 비정상 종료 시 잃을 수 있다. 정상 종료는 마지막 구간을 저장한다. 계측 DB를 열지 못하거나 flush가 실패하면 세계 동작은 계속하고 실패 수·진단을 남긴다. 계측 실패 시 원시 이벤트를 메모리에 무제한 재보관하지 않는다. 세계 SQLite와 파일을 분리해 추가 쓰기 부담을 분리했지만 같은 볼륨·프로세스의 I/O와 CPU는 공유한다.

## 내보내기와 비용 계산

Railway 서비스의 `TEXTWORLD_METRICS_TOKEN`을 관리자가 보관한다. 토큰이 없으면 계측은 계속하지만 `/api/metrics`는404다. 공개 참여 도구에 토큰을 전달하지 않는다.

```sh
# 토큰은 환경변수나 로컬 artifacts/metrics-token에서 읽으며 출력하지 않는다.
NODE_USE_ENV_PROXY=1 npm run metrics:export -- https://textworld-production-987c.up.railway.app 3600
npm run metrics:report -- artifacts/metrics-export.json
# DB 파일의 읽기 전용 분석도 가능하다.
npm run metrics:report -- data/world.sqlite.metrics.sqlite
npm run bench:scale
npm run test:measurements
```

HTTP는 `GET /api/metrics?period=60|3600&since=...&before=...&limit=...`, Bearer 관리 토큰을 사용한다. 최대5000행을 반환한다. export 스크립트는 경계 bucket을 겹쳐 읽고 중복을 제거한다. 실행 중인 자료의 비원자적 스냅샷이므로 실험의 확정 자료는 종료 후 DB/export와 조건을 보존한다.

비용 보고서는 관측한 작업량이30일간 동일하게 지속될 때의 **조건부 자원 비용 대용값**이다. 짧은 관측을 미래 이용량 예측으로 취급하지 않는다. 2026-11-02 공식 [Railway 가격표](https://docs.railway.com/pricing/plans)의 CPU $20/vCPU-month, RAM $10/GB-month, egress $0.05/GB, volume $0.15/GB-month를 명시적으로 적용한다. 단위 변환은1GB=2^30 bytes로 가정하며 요금 변경 시 스크립트의 값을 갱신해야 한다. 플랜 최소요금·포함 크레딧·실제 과금 단위·서비스 전체 사용량에 따라 청구액은 달라진다. 다른 인프라에도 적용하려면 그 단가와 계량 정의로 다시 계산한다.

## 확장 실험과 다음 개선

`bench:scale`은512×256 세계, 점유0/8192, 시야80×24/160×48, 관측자1/8/32를 조합한다. 각20번 쓰기·전체 시야 갱신을3회, 계측 켬/끔 순서를 번갈아 수행한다. 총72개 scenario/1440개 쓰기이며 장비·Node·CPU quota·Git revision·dirty 여부·분포·CPU·heap/RSS·반환 셀·payload bytes를 저장한다. 서버 계산 microbenchmark로서 socket·TLS·실제 사용자 요청 pacing·외부 클라이언트·수평 분산은 검증하지 않는다. public participant 한도를 우회한 서비스 수용 인원 시험으로 주장하지 않는다.

첫 실험은 시야 계산/전체 참여자 전파의 증폭과 전체 peers 목록 반복 전송을 다음 후보로 지목한다. 같은 관측을 공유하는 계산 캐시, 변경 영역에 따른 구독자 선택, peer 변화분 전송을 비교하되 시야·토러스·CJK·freshness의 의미를 유지해야 한다. 이후 별도 부하 생성기에서 접속/활동 비율·이동·IME·관측 대기·MCP를 섞어 목표 제공량과 실제 처리량,429, backlog, p95, resource 사용량을 측정한다. 현재 단일 SQLite writer는 replica를 늘리는 것만으로 수평 확장되지 않는다. 이번 자료는 그 결정을 위한 기준을 쌓는 첫 단계다.

첫 코드 고정 benchmark의 실제 결과와 해석은 [기준 기록](measurements/BASELINE.md)에 있고, 전체72개 집계도 저장소에 보존한다. 비용 보고서는 정적 자산 bytes와 동적 application bytes를 분리한다. 최초 글꼴 로딩이 많은 짧은 구간을 계속 활동하는 세션과 혼동하지 않는다.

5초마다 만료 검사를 시작하고, 적체가 있으면 이벤트 루프에 제어를 돌려준 뒤 다음 소량 묶음을 처리한다. 각 묶음에서 만료·기록 정리 시간(`expiration.ms`), 지워진 칸 수(`expiration.deleted_cells`), 정리 연속 실행 여부(`expiration.batch_full`)를 집계한다. 후보가 있는 묶음에는 가장 오래된 글자가 안전한 만료 시점(공유 시각 + 185초)을 넘긴 시간(`expiration.lag_ms`)도 기록한다.

점진적 resize의 `topology.adapt_ms`, `topology.search_deferred`, `topology.forced`로 후보 탐색 지연과 보류·강제 변경을 관찰한다.

`topology.lost_text_cells`와 `topology.broken_adjacencies`는 resize 결과의 실제 문자 손실과 끊어진 점유 셀 인접 관계를 집계한다. 점유 관계는 문장 개수와 같지 않다.

## 밀도 제어 계측 — 2026-11-03

새 자동 제어기는 매초 `density.actual`(표시 칸/전체 면적), `density.projected`, `density.target_area`, `density.net_growth_cells_per_second`, `density.net_decay_cells_per_second`, `density.above_band`, `density.at_limit`을 집계한다. 초과·한도 항목은 0/1 샘플이며 평균으로 판단 주기 중 해당 상태의 비율을 본다. `world.occupied`는 기존 공백 포함 저장 칸 수라 새 표시 밀도와 다르다. `observer.ink_density`는 허용된 실제 시야의 표시 밀도다. 이 값이 높고 전역 밀도가 낮다면 국소 집중 현상이다. 두 밀도의 좌표·사용자·내용은 저장하지 않는다.

`topology.area_delta`는 변화 면적의 절댓값, `topology.growth`/`topology.shrink`는 방향별 사건 수다. `topology.local_preserved`/`topology.local_reset`은 서버가 각 참여자의 시야·문맥을 함께 이동할 수 있다고 검증했는지 집계한다. 이름에 reset이 있지만 현재 커서 모델에서는 입력 초기화 횟수가 아니라 평행 이동 증명 실패를 뜻한다. 이 값 때문에 조합이나 turn을 중단하지 않는다. `topology.search_deferred`는 과거 빌드와의 비교용으로 남으며 새 제어기에는 보류 경로가 없다.

`npm run experiment:density`는 입력→재배치→만료의 가속 시계 실험과 고정 크기 시야의 국소 보존 가능성 실험을 실행한다. [설계와 실제 측정](DENSITY_CONTROL.md), [집계 JSON](measurements/density-2026-11-03.json)에 조건과 한계를 기록했다. `node tests/density-live.mjs`는 실시간 자동 타이머와 두 Chromium의 native 입력을 사용한다.


## 커서 기반 입력의 비용 — 2026-11-03

`input.cursor_actions`는 성공한 커서 행동 수, `input.after_resize`는 클라이언트의 epoch 표식과 현재 세계가 다른 상태에서 성공한 행동 수다. `input.plan_ms`는 서버의 주소 계산 시간, `input.context_entries`는 참여자의 임시 native grapheme 항목 수, `input.snapshot_bytes`는 개인 입력 state의 압축 전 JSON 바이트 수다. 이름은 수집기의 고정 허용 목록에 등록했으며 실제 프로토콜 실행 후 SQLite 집계에 저장되는지 검사한다. 본문·좌표·개인 문맥을 측정 로그에 남기지 않는다.

실시간 두 Chromium 창의 한·중 입력 60건과 자동 resize 14회에서 입력 거부 0건을 관측했다. 일반 행동 메시지 72개는 평균 192.46바이트, 개인 입력 snapshot 필드 30개는 평균 2,017.8바이트였다. snapshot 필드에는 state 외에 처리 순번도 포함된다. [원 집계](measurements/cursor-continuity-2026-11-03.json), [조건과 설계](CURSOR_CONTINUITY.md)를 보존한다. 단일 로컬 실행이며 운영 처리량·플랫폼 청구 비용을 나타내지 않는다.

## 현재 코드의 수용 규모 조사 — 2026-11-16

[조사 보고서](CAPACITY_2026_11_16.md)에 현재 배포 코드의 72개 microbenchmark, 실제 WebSocket 10개 실행, 자동 확장 9회, 이력 저장량과 Railway 7일 자원 표본을 기록했다. `node experiments/capacity.mjs`는 별도 서버/발생기·실제 파일 SQLite·정해진 송신 빈도를 사용한다. ACK를 기다리며 부하 자체를 낮추지 않고 예정/실제 송신 지연과 종료 시 미처리량을 기록한다. `node experiments/world-cost.mjs`는 자동 확장과 만료 후 남은 이력을 측정한다. 두 스크립트는 로컬 전용이며 운영을 변경하지 않는다. 정상 상태 실험의 고정 세계 시계, 실제 OS/네트워크/resize 부하 제외, 짧은 표본 등의 한계를 지원 인원과 구분한다.

새 구조의 작업량 모델과 분산 검증 목표는 [분산 세계 설계](DISTRIBUTED_WORLD_DESIGN.md)에 있다. `node experiments/distributed-model.mjs`는 병합·만료·배치/주소 분리의 의미 모형이며 성능 벤치마크가 아니다. 이 모형의 통과를 선형 확장의 실측 증거로 해석하지 않는다.

## 변경 묶음과 수신 계약 실험 — 2026-11-16

`node experiments/replication-batching.mjs`는 모든 변경을 보존하는 묶음 전송, 순번 누락 감지·중복 제거·짧은 로그 이어받기를 검사한다. 실제 루프백 WebSocket 연결은 2개이며 각자 128개 기록을 4개 묶음으로 받았다. 큰 관측자 수에 따른 전송 횟수와 JSON 바이트는 같은 시야의 결정적 작업량 모형이다. 부하 시험 인원이나 처리량 개선 배수로 읽지 않는다. [계약·결과·한계](REPLICATION_BATCHING.md), [원자료](measurements/replication-batching-2026-11-16.json).

다음 단일 서버 개선부터 입력 수락 수와 관측 기록 적용 수, 묶음 수·크기, 공유 인코딩 횟수·시간, ACK/관측 지연, 압축 후 egress, 재전송/reset, 큐 크기와 브라우저 비용을 분리해 측정한다. 이는 추가할 측정 계획이며 현재 운영 서버에 이미 존재하는 지표가 아니다. 특히 공유 스트림의 시야 필터링으로 제외한 기록과 전송 누락을 혼동하지 않는다. 정상 연결의 변경을 버리거나 묶음 간격을 몰래 늘려 처리량이 개선됐다고 계산하지 않는다.

## 트래픽 단계의 진입 판단 — 2026-11-16

[단계별 계획](SCALING_ROADMAP.md)에 단일 서버 유지, 접속 처리 분리, 세계 처리 분산, 운영 자동화의 진입 조건을 정했다. 문서의 인원 범위는 계획 예시이며 실측 수용 인원이 아니다. 우선 50ms 묶음에서 입력 수신→전송 준비 p95 100ms 이내, 지속적인 대기열 증가 없음, 정상 구독 중 누락 없음과 1시간 만료/저장량 안정성을 검증 목표로 둔다. 예상 피크와 1.5배 부하를 같은 시야·행동 제한으로 비교하고, 실패 원인이 다음 구조를 결정한다. 단계별 추가 자원 비용도 함께 기록한다. 이번 계획 정리에서는 새 성능 시험을 실행하지 않았다.
