# CJK 입력: 현지 개발자·사용자 경험 조사

조사일: 2026-11-02. 한국어·일본어·중국어 검색어로 찾은 개발 경험, 실제 오픈소스 버그 보고, canvas 구현 글의 본문을 읽고 비교했다. 한국어와 일본어 및 중국어 원문을 포함하며, 영어 글은 작성자가 일본어 사용자임을 밝힌 경험담과 재현 가능한 이슈를 보완 자료로 사용했다. 아래의 사례는 각 작성자가 겪은 현상이며 모든 OS·브라우저에서 재현된다는 뜻이 아니다. 브라우저 표준·현재 지원 범위는 [별도 조사](IME_STANDARDS.md)를 따른다.

## 공통 결론

사용자는 키 하나를 눌러 셀 하나를 쓰는 것이 아니라 **OS 입력기가 관리하는 문자열·후보·선택 범위를 편집한다**. 한글의 종성이 다음 음절로 넘어가고, 일본어의 읽기가 여러 한자로 바뀌고, 중국어의 긴 병음이 짧은 한자 구절로 바뀐다. 조합 문자열을 글자 추가 스트림으로 취급하면 이 세 경우를 모두 잘못 처리한다.

한국어 자료는 미완성 음절의 외부 상태 반영과 DOM 재동기화 문제를, 일본어 자료는 후보 선택용 키를 앱 명령이 빼앗는 문제와 후보창 위치를, 중국어 자료는 임시 조합 범위의 반복 교체와 그 영역의 소유권을 강조한다. Textworld에서는 브라우저가 처리한 편집 범위와 실제 텍스트를 읽고, 미리보기와 세계의 확정 덮어쓰기를 나누는 모델이 적합하다. 나라별 자모·병음·로마자 변환기는 만들지 않는다.

## 읽은 자료와 적용 범위

| 자료 | 본문에서 확인한 내용 | 적용할 판단과 한계 |
| --- | --- | --- |
| 한국어 — [contentEditable에서 한글 입력을 처리하는 방법](https://www.leejss.im/notes/ime-composition/), leejss, 2026-06-21 | 조합 중 contenteditable의 DOM과 앱 상태를 다시 맞추면 중복 입력·커서 이동이 생기는 경험을 설명한다. Enter의 후보 확정과 앱 동작이 중복되는 문제도 다룬다. | 활성 native 편집 영역을 앱 렌더링 때문에 지우거나 다시 생성하지 않는다. 글의 특정 이벤트 순서는 경험적 예시이며 모든 브라우저의 계약으로 사용하지 않는다. |
| 한국어 — [개발자는 한국어가 어렵다](https://zakklee.dev/blog/2026-03-08), zakklee, 2026-03-08 | 검색어 변경마다 URL을 갱신했더니 `ㅅ → 사 → 삭 → 사고 → 사과` 같은 조합 중 상태가 외부 기록에 남는 사례를 설명한다. 사용자에게 보이는 native 입력 갱신과 외부 반영 시점을 구분한다. | 미완성 한글을 영구 셀 쓰기·네트워크 이력으로 확정하지 않는다. 같은 글의 선택 범위 처리 성능에 대한 추측은 근거로 채택하지 않는다. |
| 한국어 입력의 실제 이슈 — [Draft.js #2005](https://github.com/facebookarchive/draft-js/issues/2005), palindrom615, 2019-02-18 | Linux Chrome/Electron에서 한글 조합 종료 뒤 첫 글자가 누락된다는 재현과 OS별 차이를 보고한다. 일본어 fcitx-mozc 사용자도 참여한다. | 언어 이름만으로 테스트 환경을 대표할 수 없다. OS·IME·브라우저 조합을 기록한다. 2019년 버그의 우회 코드를 현재 구현에 옮기지는 않는다. |
| 일본어 — [入力フォームで IME 確定時の Enter 誤判定を何とかする](https://webfrontend.ninja/js-input-ime-enter/), ninja, 2023-12-09 | macOS에서 후보 확정 Enter가 `key === "Enter"`로 전달되고, 저자의 Safari에서는 compositionend 이후 keydown으로 `isComposing`만 검사한 구현도 실패했다고 설명한다. | 텍스트 편집 동작은 Enter 키 자체보다 브라우저의 편집 의도로 받는다. 이 글의 `keyCode === 229`·`keypress` 호환책은 이번 최신 브라우저용 설계에 채택하지 않는다. 글의 관찰을 현재 Safari 재검증 결과로 표현하지 않는다. |
| 일본어 사용자 경험 — [If You Handle Enter, Check event.isComposing](https://dev.to/yukimi-inu/why-16-billion-east-asians-are-quietly-raging-at-your-enter-key-handler-1po0), mi-inu, 2025-09-30 | 일본어 사용자라고 밝힌 저자가 `yoroshiku → よろしく → 후보 선택` 과정에서 Enter·Space·위/아래·Esc가 자주 필요하다고 설명한다. 조합 중 입력 요소 재생성으로 문장이 사라지는 경험도 지적한다. | 지도 이동·줄바꿈·Escape 명령이 후보 선택을 빼앗지 않아야 한다. 글의 인구 수·보편적 주장과 해결 예제의 정확성까지 검증한 것은 아니다. 특히 composition 플래그만으로 모든 이벤트 순서가 해결된다고 보지 않는다. |
| 일본어 실제 이슈 — [promptfoo #7185](https://github.com/promptfoo/promptfoo/issues/7185), pokutuna, 2026-01-21 | `nihongo → 日本語` 확정 Enter가 이름 변경 창을 닫아, 다른 앱에서 입력해 붙여넣어야 했다는 재현을 보고한다. Enter 외 Esc·방향키·Tab·Backspace의 충돌 가능성도 열거한다. | 후보 확정과 앱 명령의 구분은 드문 주변 사례가 아니라 사용 가능 여부를 결정한다. 보고자의 환경 주장을 우리가 모두 재현한 것으로 취급하지 않는다. |
| 일본어 — [EditContext APIを理解する](https://zenn.dev/cybozu_frontend/articles/5667796d4168bc), irico / Cybozu Frontend, 2024-04-19 | 숨은 native 편집기와 별도 시각적 편집기의 동기화 복잡성을 설명하고, EditContext의 텍스트 모델·표시 분리와 control/selection bounds 전달을 소개한다. | canvas 입력에는 EditContext도 구조적으로 타당한 후보다. 다만 글 당시 Chromium 지원은 2026년 모든 최신 엔진의 지원 증거가 아니므로 현재 호환성은 별도로 판단한다. |
| 일본어 — [EditContextAPI触ってみた](https://qiita.com/shisojuice/items/d88564f6e03702a29e72), shisojuice, 2024-12-04 | 실제 canvas에 EditContext를 붙여 textupdate로 그리고, 후보창이 잘못된 곳에 나타나는 문제를 characterboundsupdate/updateCharacterBounds로 해결한다. textformatupdate로 변환 밑줄도 그린다. | 후보창 위치와 조합 구간 표시까지 입력 품질이다. 예제의 고정폭 글꼴·코드 단위 커서 이동·clipboard 키 처리를 Textworld 규칙으로 복사하지 않는다. |
| 일본어 — [Canvasベースのリモートブラウザで日本語入力(IME)を実装する](https://qiita.com/wown-fujioka/items/e58dbfb01d1c81e8e418), wown-fujioka, 2026-06-08 | canvas 원격 화면에서 keydown을 전달하는 방식으로는 `きょう → 今日`가 되지 않아 native textarea와 조합 이벤트로 문자열을 전달하는 구현을 설명한다. | 키 전달과 텍스트 입력은 다르다는 실제 사례다. 글의 229 처리·compositionend에서 value 비우기·EditContext를 고려하지 않은 canvas 설명은 채택하지 않는다. |
| 중국어 — [从零开始，开发一个 Web Office 套件（11）：支持中文输入法](https://cloud.tencent.com/developer/article/2344432), zhaokang555, 게시 2023-10-17 | canvas 문서 편집기에서 조합 중 임시 문자열을 갱신하고, 다음 후보가 오면 그 임시 구간을 교체하며, 확정 때 보통 텍스트로 바꾸는 방식을 설명한다. composition 이벤트·InputEvent를 사용한다. | `nihao`의 각 키를 셀에 쓰는 대신 후보 구간 전체를 변경할 수 있어야 한다. Tencent 개발자 커뮤니티 기고이며 Tencent 제품팀의 공식 가이드가 아니다. 옛 코드의 세부 이벤트 순서를 현재 계약으로 삼지 않는다. |
| 중국어 — [Composition 与 IME：中文输入法事件的处理](https://www.ximing.ren/post/2018/02-28-ProseMirrorView%E4%B9%8BComposition%E4%B8%8EIME/), 一席之地, 페이지 표시일 2018-02-28 | 중국어 `nihao → 你好`와 ProseMirror 구현을 분석하며, 원격 변경이 와도 조합 중인 DOM 노드를 제거·재생성하지 않는 이유를 설명한다. 조합 거래와 undo 묶음도 구분한다. | 세계의 원격 갱신은 계속 그리되 OS가 소유한 native 조합 버퍼는 건드리지 않는 분리가 필요하다. 글의 날짜와 분석한 코드 버전의 관계를 확인하지 못했으므로 현재 구현의 정확한 설명으로 사용하지 않는다. 타이머·229·브라우저별 패치는 채택하지 않는다. |

## 구조 비교와 제안

| 방법 | 현지 경험과 맞는 점 | Textworld에서의 판단 |
| --- | --- | --- |
| keydown마다 문자 쓰기, 국가별 조합 구현 | 없음. 후보 선택·재변환·모바일 입력·붙여넣기와 다른 길이의 교체를 표현하지 못한다. | 제외한다. |
| textarea + composition/input + 실제 value | 브라우저가 각국 IME를 처리한다. canvas 입력기에서 흔히 사용하는 유효한 native 접근이다. | textarea 자체가 잘못은 아니다. 그러나 target ranges가 없으므로 기존의 끝부분 diff·32글자 추정 대신 정확한 selection/문맥 모델이 추가로 필요하다. |
| plaintext-only contenteditable + beforeinput/input | native 조합을 유지하고 서식 입력도 제한할 수 있어 처음에는 가장 적합해 보였다. | **실측 후 기각.** 현재 Chromium에서 이 모드는 beforeinput target ranges가 비어 있었다. API의 일반 설명만으로 실제 교체 범위를 얻는다고 판단하면 안 된다. |
| contenteditable=true + beforeinput/input + 명시적 plain-text 처리 | 브라우저가 native 조합을 유지하며 실제 target ranges와 DOM 결과를 제공한다. | 현재 선택. 비텍스트 서식 의도는 거부하고 붙여넣기는 text/plain을 DOM Range로 삽입한다. 활성 DOM 재작성 금지, 실제 결과 확인, UTF-16 범위→공간 매핑이 핵심이다. |
| canvas + EditContext | 일본어 canvas 구현처럼 textupdate 범위·선택, 후보창 기하, 변환 밑줄을 직접 연결할 수 있다. | 가장 직접적인 분리 모델이지만 현재 Safari·Firefox 지원을 확인해야 한다. 최신 브라우저만 지원한다는 요청을 Chromium 전용 동의로 해석하지 않는다. 양쪽 입력기를 병행하기보다 한 가지 경로를 선택한다. |

한 언어의 조합은 한 글자, 한 번의 compositionend는 항상 새 문자열 추가, Enter는 항상 줄바꿈이라는 가정은 두지 않는다. native 범위는 UTF-16 기준, 사람이 보는 단위는 grapheme, 지도 폭은 1/2칸이다. 서로 다른 단위를 별도로 변환한다. 네이티브 편집 중에 NFC 정규화로 원문 offset을 바꾸지 않는다.

2026-11-02 구현 실험으로 위 선택을 수정했다. Node 24·Playwright·Linux headless Chromium 154.0.8037.57에서 최소 div의 contenteditable 값을 비교했다. 실제 키보드 `d` 입력·Backspace, CDP `Input.insertText('ㅎ')`와 `imeSetComposition('하', replacementStart: 0, replacementEnd: 1)` 및 `insertText('한')` 경로 모두 plaintext-only에서는 target ranges가 `[]`였다. 같은 요소의 true 모드에서는 변경 구간의 StaticRange를 얻었다. 이 결과는 입력 구현 담당자가 실행했고 [범위 계약 브라우저 테스트](../../tests/standard-input.mjs)로 보존한다. OS별 실제 IME 검증과는 다른 브라우저 API 검증이다. 최초의 plaintext-only 추천을 유지하기 위한 추가 추측 경로를 넣지 않고 호스트 선택을 바꾼다.

표준 조사 담당자가 확인한 [Blink 공식 구현](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/editing/editing_utilities.cc)도 이 차이를 설명한다. `TargetRangesForInputEvent()`는 `!IsRichlyEditable(node)`이면 `nullptr`를 반환하고, 같은 파일의 `HasEditableLevel()`은 `kReadWritePlaintextOnly`를 richly editable 범주에서 제외한다. 이것은 모든 브라우저에 대한 일반 규칙이 아니라 현재 Chromium의 구체적인 호스트 선택 근거다.

## 검증 행렬

아래는 **검증할 항목**이며 이 문서가 실행 결과를 주장하지 않는다. 합성 DOM 이벤트, 브라우저의 CDP 조합 명령, 실제 OS IME 후보창을 사용하는 검증은 서로 구분해 기록한다.

| 입력 경험 | 조작 예시 | 통과 조건 |
| --- | --- | --- |
| 한국어 음절 조합 | 두벌식 `ㅎ → 하 → 한`; `사과`, `테스트` 연속 입력 | 중간 낱자를 확정 셀로 중복 저장하지 않는다. 종성 재분배와 다음 음절 시작 후 이전 음절이 손상되지 않는다. |
| 한국어 조합 수정 | 조합 중 Backspace, 한/영 전환, 후보 확정 뒤 곧바로 다음 음절 | OS가 보이는 조합 결과와 세계에 확정되는 문자열이 같다. 조합 Backspace가 이전 세계 글자를 지우지 않는다. |
| 일본어 후보 변환 | `きょう → 今日`, `にほんごをにゅうりょく → 日本語を入力` | 문자열 길이가 달라져도 같은 조합 범위를 교체한다. 여러 변환 구절을 한 글자로 가정하지 않는다. |
| 일본어 후보 탐색 | Space·위/아래·좌/우·Enter·Esc, 마우스로 후보 선택 | IME가 소비하는 키로 지도 이동·공백 삽입·새 줄·앱 종료가 일어나지 않는다. 확정 뒤 별도 Enter는 정상 줄바꿈한다. |
| 중국어 후보 변환 | 병음 `nihao → 你好`, 긴 구절을 입력해 한 번에 후보 선택 | 병음이 영구 셀에 남지 않고 후보 구절이 한 번 확정된다. 길이 증가·축소가 모두 동작한다. |
| 중국어 후보 선택 | 숫자·Space·Enter로 후보 선택, 후보 취소·수정 | 후보용 숫자·공백·Enter가 지도 문자/줄바꿈으로 중복 실행되지 않는다. |
| 재변환·선택 교체 | IME/OS가 지원하는 기존 구절 재변환 또는 선택한 문자열 대체 | 제공된 교체 범위를 사용한다. 직전 한 글자나 고정 길이 꼬리를 추정해서 다른 셀을 바꾸지 않는다. |
| 언어 혼합과 Unicode | `A한日本語你好`, 분해 한글, 결합 악센트, emoji와 ZWJ, 붙여넣기 | native offset·grapheme·세계 칸 수를 혼동하지 않는다. 비키보드 입력도 같은 경로에서 처리한다. |
| 동시 편집과 화면 | 조합 중 다른 사용자의 셀 쓰기, 화면/세계 크기 변경 | 원격 변화가 native 편집 노드를 갈아 끼우지 않는다. 후보창이 작성 위치를 따라가고 조합 구간을 구별할 수 있다. |
| 취소와 위치 이동 | 조합 중 이동, 포커스 변경, 후보 취소 | 채택한 공간 이동 정책에 따라 조합을 정리하며, 늦게 도착한 확정 이벤트가 새 위치나 다른 셀에 쓰이지 않는다. |

실제 기기 검증은 Windows의 한국어·Microsoft 일본어/중국어 IME, macOS의 한국어·일본어·병음, Linux의 IBus/Fcitx, Android와 iOS를 각각 기록해야 한다. 모든 조합을 즉시 지원 완료했다고 선언하기보다 실제 실행한 OS·브라우저·IME 버전과 미검증 항목을 남긴다. 번체·주음 입력은 병음 입력과 같다고 가정하지 않고 별도 후보로 둔다.

## 남는 위험과 다음 실험

브라우저 자동화로 조합 문자열 치환이 통과해도 실제 후보창의 위치, 일본어 구절별 변환, 한국어 IME의 연속 입력, 모바일 자동 교정까지 입증하지는 못한다. 다음 실험은 동일한 짧은 시나리오를 native 일반 입력란과 Textworld에 나란히 수행하고, 결과 문자열·후보 선택·Enter·Backspace·취소가 일치하는지 기록하는 것이다. 불일치가 보이면 언어별 키 코드를 덧붙이기 전에 브라우저가 소유한 편집 상태를 앱이 언제 바꿨는지 먼저 조사한다.
