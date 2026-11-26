# 표본을 읽는 순서

해석과 운영 판정은 [단일 서버 1,000명 보고서](../../SINGLE_SERVER_1000.md)를 먼저 본다. 원자료의 실패·거절·중단을 성공 표본과 합산하지 않는다. MB는 10⁶ bytes, GiB는 2³⁰ bytes이며 `serverBytesPerSecond`는 측정 가능한 표본에서 WebSocket 프레임을 포함한다. TLS·IP·재전송은 포함하지 않는다.

| 파일 | 용도 |
| --- | --- |
| `aligned-before.json` | 작업 전 전체 동작의 대조. 이후판과 행동 예산도 달라 인코딩만의 효과로 해석하지 않는다 |
| `guarded-legacy.json`, `guarded-normal.json`, `guarded-deflate.json` | 같은 코드·시계 정렬·부하·예산에서 전송 형식만 비교한 주 대조 |
| `hour-1000.json` | `a2cd85a`의 실제 1시간 활동과 510초 무입력 정리. 원가 모형의 활동 구간 근거 |
| `hour-1000-active.json` | 위 실행의 정리 전 중간 체크포인트. 별도 실행으로 세지 않는다 |
| `hour-1000-quiet-health.json` | 정리 중 5초마다 연결 수·크기·프로세스 자원을 별도로 조회. 정리 구간의 송신량 측정은 아니다 |
| `footprint-normal-1000.json` | 마지막 CJK/치환 범위 과부하 방어의 180초 정상 회귀. 앞선 정리 구간과 호스트를 공유했다 |
| `footprint-surge-1000.json` | 최종 방어의 전원 광장·작성자 20→250→20 급증. 초기 자리 이동의 15초 제한 때문에 발생기가 취소한 11개 연결도 실패로 보관 |
| `footprint-surge-close-audit.json` | 같은 급증의 재실행. 종료 코드·자리 이동 완료·발생기 취소 여부를 분리한 원자료 |
| `final-normal-1000.json` | 다른 로컬 부하가 끝난 뒤 마지막 방어의 정상 180초를 독립 실행한 최종 전후 표 근거 |
| `public-1000-result.json`, `public-1000-paint*.json`, `public-1000-steady-*.json` | 첫 공개 990봇 시험. 429가 실제 느린 사용자 입력도 막아 품질 판정에 실패한 표본 |
| `public-union-*.json`, `public-union-*.png` | 두 번째 공개 990봇 시험. 비트집합 후보에서도 느린 사람 입력의 429가 재현돼 후보를 철회 |
| `union-normal-1000.json`, `union-surge-1000.json`, `control-after-union-1000.json` | 중복 관객을 제거한 비트집합 후보와 기존 코드 재대조. 지연 악화를 숨기지 않고 보관 |
| `fixed-1000.json` | 고정 시야 1,000명에서 중간 덮어쓰기를 포함한 72,000개 기대 관측 전수 대조. 실제 시계 장기 시험과 다르다 |
| `render-before.json`, `render-after-cached.json`, `render-motion-before.json`, `render-motion-after.json` | 1,000개의 가상 커서를 사용하는 클라이언트만의 그리기 비교. 서버 동접 증거가 아니다 |
| `partial-render-three-engines.json` | 세 엔진의 전체/부분 렌더링 픽셀 대조 |
| `restored-cycle-*.json`, `restored-cycle-*.png` | 최종 300명 공개 920초. 성장·풍화·최소 크기 축소·재성장, 승인/수신/그리기 분리와 역할 교체의 인원 변동까지 기록 |
| `restored-checks.json`, `restored-public-*.json`, `restored-cdn.json` | 300명 운영값 복원 후 단위/통합·세 브라우저·공개 HTTPS/WSS·캐시 무효화·비용 화면 검증 |
| `public-cycle-*.json` | 공개 서버의 300명 성장·풍화·축소·회복과 외부 두 브라우저 관측 |
| `public-300-*.json` | 중간 후보의 앞선 공개 300명 실행. 최종 구현 인증으로 합산하지 않는다 |
| `failed-crowded-1000.json`, `rejected-sliced-delivery.json` | 실제 실패한 밀집 보호·송신 분할 후보. 대기·이탈을 숨기지 않고 남긴 자료 |
| `before-1000-mixed.json`, `compact-1000-mixed.json`, `deflate-1000-mixed.json`, `deflate8k-1000-mixed.json` | 초기 탐색. 시계 정렬과 실행 환경을 맞춘 이후 주 대조와 혼합하지 않는다 |
| `grouped-normal.json`, `guarded-crowded-1000.json` | 신선도 그룹·밀집 보호의 중간 비교. 명시한 예산과 소스 digest를 함께 확인한다 |

장기 수신 지연은 150×50 시야의 독자 56개 자리를 추적한 표본이다. 전원 메시지의 디코딩·바이트·순번·연결은 계량하지만 지연 표본이 전체 독자 분포를 대표하지는 않는다. 이후 발생기는 블록마다 선택 순번을 바꿔 작은/큰 시야를 모두 포함하고 `readerSampling`·`readerViewCounts`를 남긴다. 180초 시험은 모든 정지 독자를 추적한다.

운영자 봇의 연결과 송신은 같은 공개 세계의 실제 서버 경로를 쓰되 루프백이다. 그 바이트를 Railway 외부 송신 청구액으로 합산하지 않는다. 공개 비용에는 서비스 사용량과 외부 고객이었다는 별도 송신 가정을 함께 남긴다. 외부 브라우저의 Canvas 호출 시각은 실제 발광 시각이 아니며 모바일 크기 에뮬레이션은 실물 휴대폰 OS 키보드 검증이 아니다.

그리기의 최종 전후 비교는 `render-motion-before.json`과 `render-motion-after.json`의 정지 구간 및 `motion` 필드를 사용한다. 나머지 렌더 표본은 캐시/이동 경로를 고르던 중간 실행이다. `fixed-1000.json` 바깥쪽 `revision`·`dirty`는 발생기 체크아웃 상태이며, 실제 대상 서버는 내부 `sourceDigest`로 식별한다. 이 값은 주 대조 `a2cd85a`의 digest와 일치한다.
