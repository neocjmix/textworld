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

볼륨은 SQLite 본체와 `-wal`, `-shm` 파일 모두가 같은 영구 경로에 저장되도록 `/data` 전체를 마운트한다. 로컬 개발 DB를 배포에 포함하지 않는다. 코드 재배포와 볼륨 데이터는 별개이며 서비스 재시작 후 셀·출처·세계 크기를 다시 읽는다.

## 배포 후 확인

배포 성공 상태만으로 실시간 동작을 판정하지 않는다.

1. Railway 배포가 `SUCCESS`에 도달했는지 확인한다.
2. 공개 `/health`가 HTTP 200과 `ok:true`를 반환하는지 확인한다.
3. 독립 브라우저 두 개에서 공개 주소로 접속해 글자와 커서가 전달되는지 확인한다. 특히 WebSocket의 Origin/Host 검사가 Railway 프록시 뒤에서 통과해야 한다.
4. 테스트용 셀을 기록한 뒤 승인된 다음 코드 배포에서 동일 셀·버전이 복구되는지 확인한다.
5. 검증용 글자는 다른 사용자의 변경을 덮어쓰지 않도록 확인한 뒤 정리한다.

2026-11-02 최초 배포 `2c80cda8-01f6-4bd0-8b6a-53be2c540b0e`는 `SUCCESS`에 도달했다. 구현 커밋은 `e150e44`다. 공개 HTTPS `/health`의 HTTP 200·`ok:true`, 독립 Chromium 두 context의 WSS 연결·양방향 덮어쓰기·커서 전파, 모바일 화면, 브라우저 오류 없음까지 실제 검증했다. `안녕, Textworld` 13칸을 기록하고 셀의 내용·버전·출처를 로컬 검증 산출물에 저장했다. 자동 재배포 후 이 기록과 비교해 볼륨 보존을 확인할 수 있다.

`main`을 배포 소스로 연결했다. 이번 문서 push 뒤 자동 배포 시작은 관찰되지 않아, 소스를 다시 연결해 최신 커밋 배포를 명시적으로 시작한다. 따라서 GitHub push 자동 배포는 추가 확인이 필요하다. 운영 설정은 위 Railway 서비스에서 관리하며, 로컬의 `data/`는 GitHub에 포함되지 않는다.

## 운영 경계

- 수평 복제는 아직 지원하지 않는다. 각 프로세스가 세계의 메모리 사본을 가지므로 replica를 늘리면 사용자마다 다른 세계를 보게 된다.
- 볼륨을 사용하는 재배포·재시작에는 잠깐 연결 중단이 있을 수 있다. 클라이언트는 현재 위치를 유지하며 재연결하고 최신 snapshot을 읽는다. 미확정 입력은 자동 재전송하지 않는다.
- 영구 볼륨은 백업과 같지 않다. 볼륨 삭제·장애에 대한 복구와 정기 백업은 별도 운영 작업이다.
- 현재 history·중복 작업 기록은 무제한으로 커진다. 초기 공개 실험의 디스크·메모리 사용량을 관찰하고 retention/compaction을 후속 구현한다.
- 관리용 `SCAVENGER_TOKEN`이 없으면 scavenger API는 열리지 않는다. 나이 기반 정리의 별도 프로그램은 구현되어 있지만 주기 실행을 구성하지 않으면 자동으로 실행되지 않는다.
- 전역 연결 수·사용자별 인증·콘텐츠 moderation은 초기 프로토타입에 없다. 현재 메시지 크기·연결별 속도 제한은 운영 abuse 대응 전체를 대신하지 않는다.

## 배포 판단

2026-11-02: 컨테이너 임시 파일시스템에 SQLite를 두는 방식은 재배포 시 기록을 잃으므로 제외했다. 별도 데이터베이스로 옮기기보다 기존 단일 writer와 영구 볼륨을 유지해 현재 검증된 구조를 배포한다. 제품 헌법은 변경하지 않는다.
