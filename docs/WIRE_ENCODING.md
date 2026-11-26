# 관측의 공유 인코딩과 화면 그리기

단일 Node 서버·SQLite·WebSocket을 유지한다. 새 브라우저는 `hello`에서 `batchVersion:1, wireVersion:1`을 보낸다. 최초 스냅샷은 기존 JSON이고, 협상 뒤 관측과 복구 스냅샷만 고정 필드 배열 JSON을 사용한다. ACK·오류·입력·HTTP·MCP는 그대로다. 이전 탭과 배포 롤백에도 연결을 이어갈 수 있다. 새 연결은 별도 사전 상태를 복구할 필요가 없다.

- 셀: `[x,y,text,width,leadX,version]`, 커서: `[id,name,color,x,y]`. 문자 폭·계속 칸·작성 버전·개별 커서를 생략하지 않는다.
- 관측: `[revision,partial,reset,[x,y,cols,rows],mask,...sections]`. 빈 필드는 마스크로 생략하고 수신 시 빈 배열/객체로 복원한다.
- 필드 순서는 `cells, forget, marks, unmark, freshness, colors, forgetVersions, peers, departed`다. 좌표 목록은 `[x,y]`, 표식은 `[x,y,version]` 배열이다.
- 묶음: `["tw1","b",views]`, 큰 단일 관측: `["tw1","v",view]`. 각 view는 `[world,observation]`이며 world는 `[width,height,epoch,textLayout]`다.
- 스냅샷: `["tw1","s",metadata,cells,peers,marks]`. 크기 변경 차이는 `["tw1","s",metadata,null,patch]`다. 개인별 입력 복구 상태는 해당 metadata에만 들어간다.

문자·이름·모든 값은 표준 `JSON.stringify`로 이스케이프한다. 서버가 같은 불변 셀·커서·월드 표현을 인코딩한 결과를 WeakMap에서 재사용한다. 시야 선택과 CJK 경계 처리가 먼저이며, 개인별 관측 번호·IME 복구 상태를 다른 사람에게 재사용하지 않는다. 서로 다른 시야에 같은 본문을 억지로 보내는 구역 방송은 도입하지 않았다.

50ms 관측 묶음과 64KiB 프레임 상한은 유지한다. 같은 칸의 중간 덮어쓰기와 커서 이동을 모두 순서대로 전달한다. ACK는 대기 중인 관측보다 먼저 보낼 수 있지만 스냅샷·오류는 앞선 관측을 비운 뒤 보낸다. 크기 변경의 기준 버전 검증과 재동기화도 유지한다.

표준 permessage-deflate는 비교 실험용으로 준비했다. 연결 사이·메시지 사이 압축 사전을 공유하지 않고 창 크기 11, 수준 1, memLevel 4, 동시 압축 4개로 제한한다. **압축 기본값은 꺼져 있다.** 같은 후보의 1,000명 정상 부하에서 1KiB 임계값은 실제 송신을 1.50→1.25MB/s로 줄였으나 ACK p95 38→69ms, 타인 수신 p95 108→155ms, CPU 0.386→0.447코어로 악화됐다. 초기 8KiB 후보의 절감은 약 9%였다. 지연과 밀집 시 여유를 우선해 이번 공개 설정에서는 추가 압축을 채택하지 않는다. 복잡한 별도 압축 프로토콜도 도입하지 않는다. [비교 원자료와 판정](SINGLE_SERVER_1000.md)

브라우저는 모든 관측을 적용한 뒤 애니메이션 프레임에서 바뀐 잉크·이름표 영역만 복원한다. 카메라·화면·배율·세계 버전·관측 사각형·글꼴이 바뀌거나 손상이 넓으면 전체를 다시 그린다. 커서와 글자의 토러스 반복도 손상 영역에 포함한다. 네이티브 입력 표면과 입력 예측의 정합성 규칙은 유지한다. `window.textworld.inspect().paint`는 마지막 그리기 통계이며 `repaint()`는 진단용 전체 재그리기다. 세계 입력이나 관측 권한은 바꾸지 않는다.

구현: [서버 인코더](../server/encode-view.js), [디코더](../shared/wire.js), [묶음 전달](../server/view-delivery.js), [화면 손상 계산](../public/paint-damage.js). 왕복·프레임 크기·구버전 혼합·실제 압축 바이트·CJK/풍화/토러스 픽셀 대조를 시험한다.
