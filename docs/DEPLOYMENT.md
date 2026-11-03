# Railway 배포 운영

Textworld는 하나의 Node.js 프로세스가 SQLite와 메모리 세계를 함께 관리한다. 초기 배포는 별도 PostgreSQL·Redis 없이 Railway 앱 서비스 하나와 영구 볼륨 하나를 사용한다.

## 대상

- 공개 URL: **https://textworld-production-987c.up.railway.app**
- 프로젝트: `Textworld` (`c702f64c-3e82-47e8-9945-e0540b1b5b2b`)
- 환경: `production` (`dcf0285c-151d-4a4a-ac7a-37efab3fcb0d`)
- 서비스: `textworld` (`99c29cc7-7ab4-4939-85d3-48044329b4e7`)
- 볼륨: `67c1e829-98b9-4d3f-9810-5fa9ff2c2ace` (1024 MB, `/data`)
- 리전: `us-west2` (서비스·볼륨 공통)
- 소스 저장소: `neocjmix/textworld`
- [Railway 서비스](https://railway.com/project/c702f64c-3e82-47e8-9945-e0540b1b5b2b/service/99c29cc7-7ab4-4939-85d3-48044329b4e7?environmentId=dcf0285c-151d-4a4a-ac7a-37efab3fcb0d)

## 서비스 설정

Railway 서비스 설정에서 다음 값을 관리한다. `railway.json`은 만들지 않는다. [현재 Railway 문서](https://docs.railway.com/config-as-code)는 새 서비스가 이전 Config as Code를 사용할 수 없다고 명시한다. 필요해지면 [.railway/railway.ts 기반 IaC](https://docs.railway.com/infrastructure-as-code)를 도입한다.

| 항목 | 값 |
| --- | --- |
| Builder | Railpack |
| Start command | `node server/index.js` |
| Healthcheck | `/health` |
| Replicas | `us-west2`의 1개 |
| Sleep | 꺼짐 |
| Restart policy | On failure |
| Volume mount | `/data` |
| `RAILPACK_NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `TEXTWORLD_DB` | `/data/world.sqlite` |

서버는 `0.0.0.0:$PORT`로 HTTP와 WebSocket `/ws`를 함께 제공한다. Railway HTTPS 도메인을 3000번 포트로 연결한다. HTTPS 덕분에 휴대폰에서도 GPS와 클립보드를 사용할 수 있지만, 사용자 권한은 여전히 필요하다.

공개 에이전트 API는 같은 서비스의 `/api/agents/v1`에서 제공한다. [API 문서](AGENT_API.md)와 [/agents.html](https://textworld-production-987c.up.railway.app/agents.html)에서 세션·속도 제한·취소·부분 실패 계약을 확인한다. 별도 봇 서비스나 관리자 토큰은 필요하지 않다.

볼륨은 SQLite 본체와 `-wal`, `-shm` 파일 모두가 같은 영구 경로에 저장되도록 `/data` 전체를 마운트한다. 로컬 개발 DB를 배포에 포함하지 않는다. 코드 재배포와 볼륨 데이터는 별개이며 서비스 재시작 후 셀·출처·세계 크기를 다시 읽는다.

## 배포 후 확인

배포 성공 상태만으로 실시간 동작을 판정하지 않는다.

1. Railway 배포가 `SUCCESS`에 도달했는지 확인한다.
2. 공개 `/health`가 HTTP 200과 `ok:true`를 반환하는지 확인한다.
3. 독립 브라우저 두 개에서 공개 주소로 접속해 글자와 커서가 전달되는지 확인한다. 특히 WebSocket의 Origin/Host 검사가 Railway 프록시 뒤에서 통과해야 한다.
4. 테스트용 셀을 기록한 뒤 승인된 다음 코드 배포에서 동일 셀·버전이 복구되는지 확인한다.
5. 검증용 글자는 다른 사용자의 변경을 덮어쓰지 않도록 확인한 뒤 정리한다.
6. 에이전트 세션 두 개로 짧은 입력·현재 시야 관측·취소를 확인하고, 과도한 요청이 실제 HTTP `429` 및 `Retry-After`를 반환하는지 확인한다. 큰 입력 한 건은 `413`이며 서버에 일부만 쓰지 않아야 한다.

2026-11-02 최초 배포 `2c80cda8-01f6-4bd0-8b6a-53be2c540b0e`는 `SUCCESS`에 도달했다. 구현 커밋은 `e150e44`다. 공개 HTTPS `/health`의 HTTP 200·`ok:true`, 독립 Chromium 두 context의 WSS 연결·양방향 덮어쓰기·커서 전파, 모바일 화면, 브라우저 오류 없음까지 실제 검증했다. `안녕, Textworld` 13칸을 기록하고 셀의 내용·버전·출처를 로컬 검증 산출물에 저장했다. 자동 재배포 후 이 기록과 비교해 볼륨 보존을 확인할 수 있다.

`main`을 배포 소스로 연결했다. 이번 문서 push 뒤 자동 배포 시작은 관찰되지 않아, 소스를 다시 연결해 최신 커밋 배포를 명시적으로 시작한다. 따라서 GitHub push 자동 배포는 추가 확인이 필요하다. 운영 설정은 위 Railway 서비스에서 관리하며, 로컬의 `data/`는 GitHub에 포함되지 않는다.

### 입력 모델 개편 배포 — 2026-11-02

구현 커밋 `fae4181aeb8320924eaf19c21956ed5945684f8f`를 기존 서비스에 배포했다. 배포 `09bfe395-5aac-476e-a508-72c72f665379`는 08:15 UTC에 `SUCCESS`에 도달했다. DB 스키마와 볼륨 설정은 변경하지 않았다.

08:16 UTC에 공개 HTTPS `/health`의 HTTP 200·`ok:true`, `/app.js`·공통 쓰기 모듈 두 개·HTML·CSS의 로컬 코드 일치를 확인했다. 독립 Chromium context 두 개에서 Enter → 방향키 → Enter가 작성 기준 열을 유지하고, Backspace가 줄바꿈 이전 위치로 돌아가며, 상대 브라우저에도 그 위치가 전파되는 것을 검증했다. 커서는 화면 중앙에 있었고 pageerror는 없었다. 이 공개 점검에서는 write/erase 메시지를 보내지 않았다. 결과는 로컬 `artifacts/railway-writing-verification.json`에 저장했다.

첫 공개 점검 스크립트는 로컬 기본 세계 크기의 고정 Y 좌표를 가정해 실패했다. 운영 세계는 정상 축소된 32×16이어서 좌표가 순환한 것이 원인이었다. 최소 세계 크기 안의 좌표로 검증 fixture를 수정하고 다시 실행해 통과했다. 구현을 바꾸어 테스트 가정에 맞추지 않았다.

## 운영 경계

### 한글·표시 폭·관성 배포 — 2026-11-02

첫 구현 `b9c1af7`의 배포 `a1d84b77-adc9-4563-8582-c81e78dcacf2`는 09:24 UTC에 성공했다. 시작 로그에서 `/data/world.sqlite.pre-width-v2-1793611466418-429f4ad3-aceb-4424-9ec1-0b0342b5e1c1.sqlite` 백업 생성 후 서버가 기동한 것을 확인했다.

첫 공개 한글 검증의 실패를 추가 조사해 주소가 유지되는 자동 크기 변경까지 입력 문맥을 지우던 문제를 수정했다. 최종 구현은 `dfc4ef1cb4440b01a9d5d8624cb235f8723d3f17`, 배포는 `42036915-e586-4005-a77e-2d825e9a4a33`이며 09:38 UTC에 `SUCCESS`에 도달했다. 이미 이전된 DB여서 백업·컬럼 추가를 반복하지 않았다.

09:39 UTC에 공개 HTTPS에서 아래 항목을 실제 확인했다.

- `/health` HTTP 200·`ok:true`, HTML·CSS·앱·입력·관성·공통 폭 모듈 9개가 로컬 코드와 일치했다.
- 배포 전에 기록한 66개 기존 셀의 좌표·내용·버전이 그대로였고, 이전 글은 1칸 폭을 유지했다.
- 독립 브라우저 두 개가 접속한 상태에서 `ㅎ`를 입력하고 실제 density resize(32×16 epoch 7 → 64×32 epoch 8)를 기다렸다. 버퍼의 `ㅎ`가 유지됐고 native 범위 치환으로 `한`, 이어 `한글 AB`를 정상 작성했다.
- 혼합 문장은 7개 기본 칸을 사용하고 다른 브라우저에서도 일치했다. Enter는 작성 시작 열로 돌아갔으며 pageerror는 없었다.

검증 결과는 `artifacts/railway-cjk-verification.json`에 저장했다. 빈 위치 `(15,1)`에 짧은 `한글 AB` 검증 문장을 남겼다. 다른 참가자의 후속 덮어쓰기를 지울 수 있는 무조건 정리는 하지 않았다. 실제 모바일 OS 키보드 검증은 별도다.

### native 편집 범위·Sarasa 글꼴 배포 — 2026-11-02

구현 커밋 `8cee91e0d8e503e728f2004066e6f3228803e8de`를 기존 서비스에 배포했다. 배포 `17f5c355-165e-4518-aacc-2d08a9bcda35`는 **11:14:21 UTC에 SUCCESS**에 도달했다. GitHub push 직후 자동 시작은 관찰되지 않아 기존 `main` 소스를 다시 연결해 배포를 시작했다. DB 스키마·볼륨·replica 설정은 변경하지 않았다.

11:14:52 UTC에 공개 HTTPS에서 실제 확인했다.

- `/health` HTTP 200·`ok:true`, HTML·CSS·앱·입력·공통 모듈·폰트 CSS 등 11개 자산이 로컬과 일치했다.
- 배포 전에 기록한 125개 셀의 좌표·내용·폭·버전이 그대로였다.
- Sarasa WOFF2의 5,315,944 bytes와 SHA-256 `d6fe195614ff2e94c6d8bc9e05c39782b8fe0caf06f090116fc900ef39861f77`이 로컬 파일과 일치했다. `font/woff2`와 1년 immutable 캐시 헤더, 실제 9px/18px 문자 폭도 확인했다.
- 독립 Chromium 두 context에서 `ㅎ`를 기존 범위의 `하 → 한`으로 조합했다. 미확정 조합은 공유하지 않고 `한` 확정은 단일 원자적 패치로 전달했다.
- 빈 위치 `(32,1)`에 `한글日本中文A`를 입력해 13칸의 내용·폭이 일치하는 것을 확인했다. Enter는 작성 시작 열의 다음 행으로 돌아갔고 원격 커서도 이동했다. 브라우저 pageerror는 없었다.

공개 검증 결과는 `artifacts/railway-standard-verification.json`, 화면은 `artifacts/standard-live-desktop.png`에 저장하고 직접 열어 확인했다. 이 검증은 실제 OS 키보드·후보창 또는 Safari/Firefox 실행을 포함하지 않는다. 다른 참여자의 후속 수정을 덮어쓰지 않도록 짧은 검증 문장은 남겼다.

이번 서버의 native 범위 편집은 `write`의 `clear` 주소들과 새 글을 하나의 버전으로 반영한다. 이전 서버는 이 필드의 의미를 모르므로 롤백이 필요하면 이 계약을 지원하는 서버를 사용해야 한다. 이전 구현으로 단순 롤백하고 최신 입력 클라이언트를 계속 사용하는 조합은 검증되지 않았다.

### 즉시 입력 표시·부드러운 카메라 배포 — 2026-11-02

구현 커밋 `e1e2651a767fbc1723b0952fbb4e37ae3da69426`를 배포했다. 배포 `834f2a95-d9ed-448f-bdaa-716664f4062a`는 **12:07:18 UTC에 SUCCESS**에 도달했다. 기존 `main` 소스 재연결로 명시적으로 배포를 시작했다. 서버 프로토콜·DB 스키마·볼륨·replica 설정은 변경하지 않았다.

새 클라이언트는 native 조합 범위를 직접 표시하고, 미확정 로컬 입력의 표시와 서버 확정 상태를 구분한다. 카메라는 입력·휠·보이는 화면의 높이 변화를 부드럽게 따라가며, 움직임이 끝나면 커서가 중심에 돌아온다. 직접 드래그는 손가락을 즉시 따른다. 배포 전 자동 검사 196개를 통과했고 자세한 측정과 한계는 [VERIFICATION.md](VERIFICATION.md)에 기록했다.

12:08:29 UTC 공개 HTTPS에서 다음 항목을 실제 검증했다.

- `/health` HTTP 200·`ok:true`, 새 입력·표시·카메라 모듈을 포함한 14개 자산이 로컬과 일치했다. Sarasa 파일 SHA-256·9/18px 폭·immutable 캐시도 유지됐다.
- 배포 전 기록한 194개 셀의 내용·폭·버전이 보존됐다.
- 실제 native 조합 `한`의 18×22px font box가 지도에 표시됐고, 같은 세계 주소에 Canvas 조합 글이 중복되지 않았다.
- 입력 사용자의 수신만 300ms 보류했을 때 서버에서 확인한 이전 글은 `ㅎ`, 화면의 로컬 글은 `한`, pending은 남아 있었다. 응답 전달 후 서버 상태와 일치했다.
- `visualViewport`를 높이 600↔900px로 모의 변경해 열림 51개·닫힘 52개의 전환 프레임을 관찰했다. 논리 입력 주소와 글꼴 크기를 유지하며 새 중심으로 정착했다. 이는 실제 OS 키보드 창 검증이 아니다.
- 독립 브라우저 두 개에서 빈 위치 `(45,1)`에 `한글日本中文A`를 작성해 13칸의 내용·폭 동기화와 Enter 후 위치 전달을 확인했다. 브라우저 오류는 없었다.

증거는 `artifacts/railway-smooth-verification.json`과 `smooth-live-desktop.png`, `smooth-live-composition.png`에 저장하고 화면을 직접 확인했다. 검증 문장은 다른 참여자의 수정을 지울 수 있는 자동 정리 없이 남겼다.

### 공개 참여자의 접속 주소와 제한

HTTP 에이전트와 브라우저 WebSocket은 같은 접속 주소의 요청·쓰기·이동·새 시야 관측 예산을 공유한다. 연결 종료 후에도 예산 기록을 최소 10분 유지한다. 같은 주소의 동시 세션은 현재 8개이며 생성은 초당 1개 보충·일시 여유 8개다. 같은 NAT를 쓰는 정상 사용자도 이 한도를 공유한다. 여러 네트워크의 익명 봇을 같은 주체로 식별하는 기능은 없다. 이 값들은 초기 운영 실험이며 운영 규모에 맞춰 측정·조정해야 한다.

로컬 기본값은 TCP 연결의 `remoteAddress`를 사용하고 클라이언트가 임의로 보낸 프록시 헤더를 신뢰하지 않는다. Railway 환경 변수 `RAILWAY_ENVIRONMENT_ID`가 있거나 `TEXTWORLD_TRUST_PROXY=railway`를 명시하면 유효한 단일 IP 형태의 `X-Real-IP`를 접속 주소로 사용한다. `X-Forwarded-For`는 사용하지 않는다. IPv4의 IPv6-mapped 표현은 통합하고 IPv6는 /64 단위로 묶어 임시 주소 변경으로 예산을 초기화하는 것을 줄인다.

Railway의 [공개 네트워킹 기술 명세](https://docs.railway.com/networking/public-networking/specs-and-limits#technical-specifications)는 `X-Real-IP`를 클라이언트 주소 헤더로 설명한다. 이 운영 선택은 공개 요청이 신뢰하는 Railway ingress를 거치며 해당 헤더가 원래 클라이언트 주소로 전달된다는 전제를 갖는다. 공개 요청이 직접 컨테이너 포트에 도달하는 우회 경로를 만들면 이 전제가 성립하지 않는다. 플랫폼 변경·TCP proxy 노출 시 신뢰 설정을 다시 검토한다. 헤더를 사용하는 사실을 동일인 인증으로 취급하지 않는다.

봇 세션·진행 중인 행동·중복 방지 요약은 메모리에 있다. 재배포·재시작하면 사라지며 이미 확정한 셀은 기존 SQLite에 남는다. 세션 만료나 서버 재시작 뒤에는 새로 참여하고 현재 화면을 관찰해 후속 행동을 정한다. 마지막 요청 전체를 자동으로 재전송하지 않는다. 기존 열린 브라우저도 새 프로토콜 자산을 받아야 하므로 배포 후 새로고침으로 현재 시야·공통 제한을 적용한다.

### 복구와 제한

- 표시 폭 v2는 `cells`·`history`에 폭/연속 칸 정보를 추가한다. 기존 영구 DB는 변경 전에 `/data/world.sqlite.pre-width-v2-<timestamp>-<uuid>.sqlite`로 `VACUUM INTO` 백업하고 파일·디렉터리를 동기화한다. 백업 실패 시 시작과 스키마 변경을 중단한다. 이미 변경된 DB와 신규 DB에는 이 백업을 반복하지 않는다.
- 폭 컬럼을 모르는 이전 서버는 컬럼 수가 고정된 INSERT를 사용하므로 **이 변경 이전 코드만 단독으로 롤백해서는 안 된다**. 폭 스키마 호환 릴리스를 쓰거나 해당 시점 DB를 복원해야 한다. 백업 이후 새 글은 그 백업에 포함되지 않는다. 새 입력은 `layout:2`가 필요하므로 기존 열린 페이지는 새로고침 안내를 받는다.
- 수평 복제는 아직 지원하지 않는다. 각 프로세스가 세계의 메모리 사본을 가지므로 replica를 늘리면 사용자마다 다른 세계를 보게 된다.
- 볼륨을 사용하는 재배포·재시작에는 잠깐 연결 중단이 있을 수 있다. 클라이언트는 현재 위치를 유지하며 재연결하고 최신 snapshot을 읽는다. 미확정 입력은 자동 재전송하지 않는다.
- 영구 볼륨은 백업과 같지 않다. 볼륨 삭제·장애에 대한 복구와 정기 백업은 별도 운영 작업이다.
- 현재 history·중복 작업 기록은 무제한으로 커진다. 초기 공개 실험의 디스크·메모리 사용량을 관찰하고 retention/compaction을 후속 구현한다.
- 만료 정책이 서버에서 5초마다 최대 500개 글자를 조건부 삭제한다. 배포 직후 기존의 3분 이상 된 글도 삭제 대상이다.
- 계정 기반 동일인 인증·콘텐츠 moderation·분산 봇 판별은 초기 프로토타입에 없다. 참여자·접속 주소별 제한과 관측 경계는 운영 abuse 대응 전체를 대신하지 않는다.

## 배포 판단

2026-11-02: 컨테이너 임시 파일시스템에 SQLite를 두는 방식은 재배포 시 기록을 잃으므로 제외했다. 별도 데이터베이스로 옮기기보다 기존 단일 writer와 영구 볼륨을 유지해 현재 검증된 구조를 배포한다. 제품 헌법은 변경하지 않는다.

### 공개 참여 API 배포 — 2026-11-02

구현 `a2906169fa84647d19f331c2c61435e6ab14ffa3`, 배포 `5ef349b7-367b-409e-8d5d-2f95a4a18585`는 **13:42:43 UTC에 SUCCESS**에 도달했다. 기존 GitHub main 소스를 다시 연결해 배포했으며 DB 스키마·볼륨·replica는 바꾸지 않았다.

공개 주소의 실제 브라우저와 HTTP 봇 두 개가 제한된 시야로 접속했다. 빈 영역을 확인한 뒤 `봇AB`를 서버가222ms에 걸쳐3단계로 입력했고 브라우저는3번의 변경을 받았다. 다른 봇의 한글 덮어쓰기와 브라우저의 native 입력, 중복 요청 재실행 방지,20,000자 요청413·무변경, 진행 중 관측에 실제429·Retry-After, 취소, 과도한 시야 요청400까지 확인했다. 총5grapheme만 입력했으며 생성한 세션은 모두 종료했다.

마지막 IP 제한 검사는 검증 도구의 브라우저와 HTTP 요청이 같은 출구를 쓴다는 가정 때문에 실패했다. Railway HTTP 로그를 비교하니 실제 출구가둘이었다. HTTP 쪽 주소 그룹에서는정확히8세션이생성되고다음요청이429였고 WebSocket은다른그룹이었다. 요청에 서로 다른 X-Real-IP/X-Forwarded-For를 넣어도 해당 주소 그룹의8개 제한을 우회하지 못했다. 추가 분리 실험에서도 실행 환경 프록시가 출구를 분산하는 것을 확인했으며 서버 정책을 바꾸어 잘못된 fixture에 맞추지 않았다. 원 IP·토큰을 저장하지 않은 그룹별 근거와 최초 실패 보고서는 `artifacts/railway-edge-address-groups.json` 및 공개 검증 산출물에 보존했다. 세션 정리 외에 기존 글을 삭제하지 않았다.

### MCP 배포 — 2026-11-02

구현 커밋 `1216df5ce753eb318f5c2a26855b4b6a64e9cd4b`의 배포 `2c20311e-9898-4f7f-9751-561d359ef225`가 **14:03:04 UTC에 SUCCESS**에 도달했다. 기존 서비스·영구 볼륨을 유지했다. 공개 MCP 주소는 `https://textworld-production-987c.up.railway.app/mcp`다.

14:03:23 UTC부터 공식 MCP 클라이언트로 공개 주소의 도구5개 발견, 참여자2개의 제한된 시야·presence 공유,20,000자 입력413·무변경, 도구429·재시도100ms, 취소를 확인했다. 모든 검증 세션을 종료한 뒤 `/health`는200·참여자0명이었고 discovery의 `/mcp` 안내도 확인했다. 운영 MCP 점검의 추가 쓰기는0건이다. 결과는 `artifacts/mcp-public-verification.json`이다. 특정 상용 MCP 호스트 UI에서의 설정은 직접 실행하지 않았으며 공식 클라이언트와 연결 예제를 제공한다.

### 신선도 저장 구조 운영 주의

`change_times`가 없는 기존 DB는 `.pre-change-times-v3-<시각>-<uuid>.sqlite`로 먼저 백업·fsync한 뒤 시각을 공유 표로 이전한다. 원본 좌표·글자·폭·version을 보존하고 cells/history의 기존 updatedAt은0으로 바꾼다. 새 서버는 version 이전의 가장 가까운 공통 시간 표식을 조회한다. 이 변경 전 서버로 단순 롤백하면0을 실제 시각으로 해석하므로 이 구조를 이해하는 호환 서버 또는 백업 복원이 필요하다. backup 이후 쓰기 보존 여부를 먼저 판단해야 한다. DB 스키마 구조 호환과 데이터 의미 호환은 다르다.

### 공유 신선도 배포 — 2026-11-02

구현 `45448f4d6f8942686b9ea21ce6432577b4880ad2`, 배포 `89edd0e8-ec71-4ef0-a12e-343b817cd297`가15:05:25 UTC에SUCCESS에 도달했다. 기동 로그에서 `/data/world.sqlite.pre-change-times-v3-1793631922265-41c11d11-0bdb-4d14-9498-f0f44df014a5.sqlite` 백업 생성과 정상 기동을 확인했다.

배포 전 같은 시야에서 기록한680개 기존 셀의 좌표·본문·폭·연속칸·버전이 모두 보존됐다. 공개 관측은 정확한 시각을 노출하지 않고 old/earlier 공유 신선도 표를 돌려줬다. 실제 공개 Chromium에서도 신선도 범례·공유 표 수신과 연결을 확인했으며 pageerror0, 추가 쓰기0건이었다. 근거 artifacts/freshness-live-verification.json 및 freshness-live.png. 로컬 검사는 서버182개·브라우저50개, 합계232개 통과다.

### 규모·비용 계측 배포 — 2026-11-02

구현 `3fce190c2c031c94fbdf11de43a963f2e6e0745d`, 배포 `60ef63d5-dd27-4af7-9636-cfc9615011a1`가15:26:55 UTC에SUCCESS에 도달했다. 기존 영구 볼륨의 별도 `.metrics.sqlite`에서 실제 분·시간 집계 누적과 export를 확인했고 collector failures0이었다. 관리 토큰은 Railway 환경변수에만 설정하고 비공개 로컬 파일을 통해 검증했으며 저장소에는 넣지 않았다. 토큰 없이 운영 통계를 읽을 수 없다.

공개 브라우저를125초 유지해 DPR 등 집계 업로드를 확인했다. 페이지 오류0·추가 쓰기0건이었다. 세부 draw/ACK/submission 수집은 통제된 로컬 브라우저에서 별도로 검증했다. 코드 고정72scenario benchmark는 docs/measurements/scaling-baseline-2026-11-02.json에 보존했다. 운영 호스트와 로컬의 Node/CPU 한도가 다름도 기록했다.

계측 보완 구현 `ed67e9b00254f4c2117b1799d7c5521b1642546f`의 배포 `0fba6641-20b4-45f5-abc7-a8e6c62a213a`는15:34:14 UTC에SUCCESS에 도달했다. 배포 전52개 집계 행이 모두 같은 bucket·period·metric·revision으로 남고 count가 감소하지 않았음을 실제 export로 검증했다. 총83행과 이전/현재 두 빌드의 Node·CPU·메모리 한도를 확인했다. client.reported.draw_ms·drawn_glyphs·viewport_cells·dpr가 운영에서 저장됐으며 failures0이었다. 원자료와 검증 근거는 비공개 artifacts/metrics-export.json, measurement-persistence-verification.json, cost-report.json에 있다. 계측은 이 배포 이후에도 분 단위로 계속 누적된다.

### 분산 확장·축소 배포 — 2026-11-02

구현 `30e9b8dbbcf17c811a8d43fecefd09cddc8210d0`의 배포 `66d36272-7fd8-4150-ab95-e4ed2b8ed31b`가17:05:48 UTC에SUCCESS에 도달했다. 기존64×32·epoch8의 운영 월드가 서버의 자동 밀도 판단으로128×64·epoch9로 실제 확장됐다. seed3982370324에서 가로1154·세로2715곳에 변경이 분산됐고1083점유 셀 중1057개가 살아남고26개가 제거됐다. 문장 인접성은 바뀔 수 있다.

실제 공개 Chromium이 재배치 snapshot을 받고 커서(32,16)→(64,33)를 반영했다. 새 시야의 CJK 쌍과 범위 내 커서, pending0, pageerror0을 확인했다. 운영 검증의 추가 쓰기는0건이다. artifacts/topology-live-verification.json 및 topology-live.png에 근거를 남기고 화면을 직접 검토했다. 저장된 topology_events에서 시드와 손실량을 보존한다. 현재 크기 범위32×16~1024×512와 density/cooldown은 유지하며, 글·커서의 보존을 이유로 resize를 막지는 않는다.

### 목표 밀도 제어·국소 연속성 배포 — 2026-11-03

구현 `2a4bda1`, 배포 소스 `40f9779544b62f1f688e927e83367b82fc1d7a44`(그래프 포맷 정리 포함), Railway 배포 `a1911bb6-aecb-4e97-aa43-9eefc99a07a1`이 **14:11:33 UTC SUCCESS**에 도달했다. 현재 서비스는 해당 SHA에 고정되어 있다. 기존 SQLite 스키마·영구 볼륨을 유지하며 점유 카운터는 저장된 글에서 복구한다. [새 제어 규칙과 한계](DENSITY_CONTROL.md)를 적용했다.

전환 중 health 요청 한 건은 502를 받았다. SUCCESS 이후 공개 `/health` 정상, 배포된 `/app.js`와 로컬 파일의 일치, 데스크톱·모바일 Chromium의 두 참여자 presence, 글꼴·pending 0·페이지/프로토콜 오류 0을 확인했다. 쓰기 없는 25초 동안 32×16·epoch110이 유지됐고 검증 중 추가 쓰기는 0건이다. 단일 프로세스/볼륨의 이 배포가 무중단이었다고 주장하지 않는다.

새 revision에서 `density.actual/projected/target_area/above_band/at_limit/net_growth_cells_per_second/net_decay_cells_per_second` 각각 59회와 `observer.ink_density` 11회가 분 집계로 영속화됐고 collector failures는 0이었다. 공개 관측 당시 빈 세계라 실제 성장·축소 부하 검증은 별도의 로컬 실시간 두 브라우저와 가속 시계 엔진 실험에 근거한다. `artifacts/density-public-verification.json`, `density-public-desktop.png`, `density-public-mobile.png`에 근거를 남겼다.


### 커서 기준 연속 입력 — 2026-11-03

구현 `fa78bf77225e07eed7d91d546a4d4279c2100d0f`를 배포 `e59bd59e-4970-420d-adad-292835ee9a68`로 반영했다. Railway가 2026-11-03 14:54:09 UTC에 SUCCESS를 반환했다. 기존 서비스·영구 볼륨·단일 writer 설정을 유지했다.

공개 HTTPS의 app/native-input/cursor-input/native-context 소스 네 파일이 해당 로컬 커밋과 동일했다. 실제 Chromium 데스크톱·모바일 두 context에서 서로의 커서와 한글·중국어 입력을 보았고, 한글 첫 글자의 native 재변환도 상대 화면에 반영됐다. 확정 native 작업 3건, 페이지·프로토콜 오류 0건, 종료 후 pending 0·health 정상·참여자 0이었다. 공개 시야에는 작성자 식별자가 없어 조건부 소유 확인 후 삭제는 생략하고 테스트 글자 4개를 일반 3분 만료에 맡겼다. 운영 중 임의 확장·축소나 부하 주입은 하지 않았다.

새 revision의 `input.cursor_actions` 7개, `input.context_entries` 7개, 계획 시간 7개, 초기 개인 snapshot 크기 2개가 실제 집계 DB에 저장됐고 collector failures는 0이었다. [운영 확인 자료](measurements/cursor-public-2026-11-03.json). 입력 계획 시간의 이번 7개 표본은 최대 2.68ms이며 처리량이나 SLA를 뜻하지 않는다.

서비스는 구현 SHA에 고정돼 있다. 뒤이은 검증 문서 커밋은 배포 코드를 바꾸지 않는다. 공개 페이지를 새로고침하면 새 커서 입력 프로토콜을 사용한다.
