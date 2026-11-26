# Railway CDN과 배포 캐시

## 정책

별도 외부 CDN 대신 Railway 내장 CDN을 사용한다. 같은 공개 도메인에서 동작하며 DNS·WebSocket·세계의 관측 및 입력 계약은 바꾸지 않는다. [공식 문서](https://docs.railway.com/networking/cdn)에 따르면 현재 베타, 별도 CDN 요금 없음, 캐시 적중에는 서비스 egress 과금 없음이다. 원본에서 가져온 miss와 WebSocket은 기존 비용이 발생한다.

| 응답 | Cache-Control | 갱신 |
| --- | --- | --- |
| 해시 JS·CSS, 버전 글꼴 | `public, max-age=31536000, immutable` | 내용 변경 시 새 URL |
| 빌드된 HTML | `public, max-age=0, s-maxage=30, must-revalidate` | 성공한 배포에서 Railway가 HTML 자동 purge |
| 공개 API 사용법 JSON 두 경로 | 위와 같은 30초 edge TTL | 최대 30초 뒤 갱신; 실제 요청 제한은 서버가 즉시 적용 |
| `/app.js`, `/shared/*`, `/fonts/sarasa.css` 등 고정 URL | `no-cache, no-store, max-age=0` | CDN 저장 금지 |
| 세션·행동·관측·MCP·health·운영 API·오류 | `no-store` | 항상 원본 |

브라우저는 HTML을 매번 재검증한다. 오래된 HTML을 허용하는 SWR은 사용하지 않는다. `Authorization` 요청은 Railway에서도 캐시를 우회한다. 공개 글이라는 이유로 세계 관측을 HTTP 캐시에 올리지 않는다.

## 자동화

1. Railpack이 `npm run build`를 실행한다. esbuild가 공유 모듈을 포함한 브라우저 의존성을 묶어 내용 해시 URL을 생성한다. `.build/manifest.json`의 체크섬과 페이지 참조를 함께 만든다. 빌드 실패 시 새 서버를 서비스하지 않는다.
2. 서버가 수신을 시작하기 전에 체크섬을 확인하고 DB 옆 `static-assets/`에 원자적으로 보관한다. 프로덕션은 `/data/static-assets`이다. 같은 URL에 다른 내용이 들어오면 시작을 거부한다.
3. `npm run deploy:production`은 활성 CDN의 설정을 `auto / 30m fallback / no SWR / purge-on-deploy html`로 맞추고 배포를 접수한 뒤 돌아온다. TTL은 응답 헤더가 우선이며 우리 응답에는 모두 명시한다. GitHub 자동 배포나 대시보드 재배포에도 플랫폼에 저장된 purge 정책이 적용된다.
4. Railway가 **성공한 배포 이후** HTML을 무효화한다. 빌드 접수나 서버 기동 중 수동 purge하지 않는다. 너무 일찍 지우면 구 서버에서 이전 HTML이 다시 캐시될 수 있다.
5. 정적 파일 자체는 purge하지 않는다. 새 HTML은 새 URL을 참조한다. 바뀌지 않은 글꼴과 코드는 캐시를 유지한다.

최초에는 캐시에 안전한 서버를 배포한 후 `RAILWAY_BIN=/path/to/railway npm run cdn:enable`로 활성화한다. 꺼진 CDN을 배포 도구가 임의로 다시 켜지 않는다. 명령은 기존 project/environment/service ID를 명시한다.

## 이전 페이지와 롤백

이전 HTML을 받은 브라우저나 이미 열린 탭은 이전 파일을 계속 요청할 수 있다. CDN에 없는 파일도 새 서버가 정확한 이전 내용으로 보내도록 영구 볼륨에 보관한다. **파일을 사용하는 배포가 교체된 시점부터 7일**을 보장하고 현재 배포의 파일은 만료시키지 않는다. 같은 파일은 배포마다 복제하지 않는다. 기한이 지난 이전 파일은 다음 기동에서 정리하며 파일 수·바이트·삭제 수를 기동 로그에 남긴다.

없는 해시 URL을 새 파일로 대신 응답하지 않는다. 404도 `no-store`라 다음 배포에서 생길 파일의 부정 캐시가 남지 않는다. 롤백도 그 빌드의 HTML·자산을 다시 활성화하고 방금 사용하던 파일을 보존한다. 이 기능 도입 전 커밋으로 롤백할 때는 CDN을 먼저 끈다.

7일 넘게 열어 놓은 탭에서 처음 요청하는 이전 글꼴, 볼륨 삭제/손상, 구 프로토콜의 무기한 호환은 보장하지 않는다. 보존은 브라우저 파일의 일관성을 위한 것이며 세계 입력의 정합성 계약을 바꾸지 않는다.

## 검증과 측정

- `node --test tests/asset-release.test.js tests/static-assets.test.js`: 의존 모듈 변경, 동일 빌드, HTML/ETag 전환, cold request의 구 파일, 롤백, 지연 글꼴, 만료, 손상/해시 충돌 거절, gzip/HEAD/304/오류.
- `npm run build` 후 `TEXTWORLD_BUILT_ASSETS=1 npm run test:browsers`: 실제 번들로 Chromium·Firefox·WebKit의 두 사용자, CJK 입력, 모바일, 재접속.
- `TEXTWORLD_BUILT_ASSETS=1 npm run test:fonts`: 번들된 CSS의 글꼴과 지연 도착 후 Canvas 재표시.
- 공개 CDN의 `x-cache: HIT`와 `Age`, 배포 후 HTML/asset ID, 구 파일 체크섬, HTTPS·WSS를 확인한다. 단일 위치의 반복 요청 적중률을 전체 방문자 적중률로 간주하지 않는다.

CDN HIT는 서버 계측에 나타나지 않는다. `http.static.tx_bytes`는 원본이 직접 전송한 바이트다. 장기 비용은 Railway 청구/edge 자료와 실제 방문 분포를 함께 확인한다. 지역·언어·첫 방문/재방문의 byte hit ratio가 필요하며 서버 지표만으로 CDN 전체 적중률을 역산하지 않는다. 적용 결과는 아래에 추가한다.
