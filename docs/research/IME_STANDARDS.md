# CJK 입력: 표준·브라우저 벤더 조사

조사일: 2026-11-02. 구현 전에 W3C 관련 절, MDN 설명, Chrome/Edge 공식 소개, Mozilla/WebKit 입장과 최신 지원 현황을 검색하고 대조했다. 아래는 기술 선택의 근거이며 실제 OS 한국어·일본어·중국어 키보드를 검증했다는 뜻이 아니다. Input Events 2와 EditContext는 조회 시점에 Working Draft이므로 완성된 W3C Recommendation처럼 표현하지 않는다.

## 핵심 판단

사용자의 키를 앱이 조립해 문자를 만드는 방식을 사용하지 않는다. OS IME와 브라우저가 조합·후보 선택·범위 교체를 수행하고, 앱은 **편집 의도와 실제 편집 결과**를 공간의 덮어쓰기로 변환한다.

최신 Chromium·Safari·Firefox에 하나의 입력 경로를 제공하려면 `contenteditable="true"`에 **plain-text 편집 정책**을 적용한 native 입력 호스트를 두고 `beforeinput`의 `getTargetRanges()`, `input`의 실제 DOM 상태, `compositionstart/end`의 조합 수명을 사용하는 방법이 적합하다. 서식 명령은 취소하고 붙여넣기는 `text/plain`으로 제한한다. 이는 별도 시각적 입력 패널을 만들라는 제안이 아니다. 지도 위 현재 작성 위치에 연결한 native 호스트의 역할을 명확히 하자는 제안이다.

초기 가설은 `contenteditable="plaintext-only"`였다. 그러나 이번 구현 실험에서 Chromium 154.0.8037.57의 해당 호스트는 `insertText`, `insertCompositionText`, `deleteContentBackward` 모두 빈 target ranges를 반환했고, 같은 실험의 `contenteditable="true"`는 StaticRange를 반환했다. [현재 Blink 공식 소스](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/editing/editing_utilities.cc)의 `TargetRangesForInputEvent()`는 `!IsRichlyEditable(node)`이면 `nullptr`를 반환한다. 같은 파일의 `HasEditableLevel()`은 `kReadWritePlaintextOnly`를 richly editable에서 제외한다. 따라서 plaintext-only의 Baseline 지원 여부만 보고 필요한 범위 정보까지 제공된다고 판단한 초기 선택을 철회했다. 이는 검증된 구현 차이이며, 이 조사만으로 어느 사양 조항의 버그인지까지 단정하지는 않는다.

`textarea`도 표준 native 입력 호스트다. 다만 그 `getTargetRanges()`는 **항상 빈 배열**이므로, 범위 기반 편집을 정확히 전달하려면 selection/value 모델을 별도로 유지해야 한다. 현재처럼 두 문자열의 공통 접두사·마지막 문자 일치로 교체 범위를 추측하는 방법보다, 브라우저가 실제 교체 범위를 제공하는 호스트가 Textworld의 요구에 직접 맞는다.

`EditContext`는 canvas와 OS 입력 문맥을 분리하는 가장 직접적인 API다. 그러나 조회한 최신 지원 자료에서도 Safari·Firefox에는 없고 MDN은 Limited availability/Experimental로 표시한다. “최신 브라우저만 지원”을 “Chromium만 지원”으로 자동 확대 해석해서는 안 된다. 최신 Safari·Firefox까지 포함할 경우 EditContext와 DOM 폴백을 병행하기보다 하나의 현대 DOM 입력 경로를 선택할 수 있다.

## 근거와 구현에 주는 의미

| 자료 | 확인한 내용 | Textworld에 적용할 판단 |
| --- | --- | --- |
| [W3C Input Events 2](https://www.w3.org/TR/input-events-2/), 조회판 2026-10-15 WD, §6–7 | 키보드·IME·음성 등은 사용자의 편집 의도를 표현하는 여러 수단이다. 조합 중 `insertCompositionText`는 비취소 `beforeinput`/`input`으로 전달되고 실제 DOM 갱신은 둘 사이에 일어난다. | 키 이벤트에서 문자열을 만들거나 조합 중 `preventDefault()`로 native 편집을 대체하지 않는다. 미리보기와 실제 확정을 분리한다. |
| 같은 문서의 `getTargetRanges()` 정의·호스트 표 | contenteditable은 변경 대상 StaticRange를 제공하고 input/textarea는 빈 배열이라고 설명한다. 변경 대상은 grapheme 전체가 아닌 일부 code point일 수도 있다. | 실제 호스트의 반환값까지 검증한다. 범위 정보를 먼저 UTF-16 DOM 좌표로 보존하고, 세계 주소와 문자 폭은 별도의 변환에서 계산한다. |
| [MDN beforeinput](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event) | `beforeinput`은 Baseline Widely available. 하지만 IME·자동 교정 등 일부 수정은 비취소이거나 beforeinput이 발생하지 않을 수 있어 `input`도 처리해야 한다. | `beforeinput`만으로 최종 결과를 단정하지 않는다. `input`에서 브라우저가 실제 만든 상태를 읽는 것은 레거시 폴백이 아니라 현재 API의 성질에 맞는 처리다. |
| [MDN getTargetRanges](https://developer.mozilla.org/en-US/docs/Web/API/InputEvent/getTargetRanges) | textarea/input의 빈 배열과 contenteditable의 StaticRange 구분을 명시한다. | textarea를 그대로 두고 존재하지 않는 target range를 가정해서는 안 된다. |
| [web.dev: plaintext-only Baseline](https://web.dev/blog/contenteditable-plaintext-only-baseline), 2025-03-20 | `contenteditable="plaintext-only"`는 2025-03-04부터 세 주요 엔진에서 Baseline Newly available. | 속성의 지원과 필요한 이벤트 데이터의 동등성은 다르다. 이번 Chromium 실측은 plaintext-only를 선택할 근거로 Baseline 정보만 사용하는 판단을 반증했다. |
| [Blink editing_utilities.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/editing/editing_utilities.cc), 2026-11-02 조회 | `TargetRangesForInputEvent()`는 richly editable일 때만 범위를 생성한다. `HasEditableLevel()`은 plaintext-only를 해당 분류에서 제외한다. | 범위 기반 native 편집을 위해 `contenteditable="true"`를 사용하고 앱에서 plain-text 정책을 적용한다. 브라우저 이름별 분기나 plaintext-only 폴백을 추가하지 않는다. |
| [Chrome/Edge EditContext 소개](https://developer.chrome.com/blog/introducing-editcontext-api), 2024-02-02 | 조합 중 DOM의 입력 영역을 수정하면 조합이 조기에 취소될 수 있다. Word Online 협업 지연 사례를 설명하고 textupdate 기반 모델과 화면 분리를 제안한다. | 조합 중 input 호스트의 값/DOM을 비우거나 재생성하지 않는다. 원격 셀 갱신은 canvas에 반영하되 OS가 소유한 조합 DOM을 재작성하지 않는다. |
| [W3C Input Events 이슈 #135](https://github.com/w3c/input-events/issues/135), [UI Events 알고리즘](https://www.w3.org/TR/uievents/event-algo.html) | compositionupdate와 beforeinput 순서 및 최종 input의 위치에 사양 간·브라우저 간 차이가 있음을 기록한다. UI Events 문서 자체에 Chrome/Safari 차이와 미해결 사항이 있다. | 고정된 이벤트 횟수·동일 task 여부·한 키당 한 글자 가정을 없앤다. 실제 편집 상태와 명시적인 조합 수명으로 처리한다. |
| [Input Events 이슈 #134](https://github.com/w3c/input-events/issues/134) | Gecko 입력 담당자 Masayuki Nakano가 키보드 없이 발생하는 문자 입력과 composition 최종 input의 `isComposing` 차이를 설명한다. | `isComposing === false`인 input 하나만을 유일한 확정 통로로 삼으면 안 된다. 조합 종료도 실제 상태를 확정하는 경계로 다룬다. |

## 이벤트 처리 원칙

1. `compositionstart`는 조합 거래의 시작이다. 그때의 native 문맥과 공간 매핑을 보관한다. 조합 중에는 기존 작성 호스트의 노드·값·선택을 앱이 재설정하지 않는다.
2. `beforeinput`은 의도와 대상 범위를 읽는 지점이다. `inputType`과 `getTargetRanges()`를 이벤트 핸들러 안에서 native UTF-16 offset으로 복사한다. 이벤트가 끝난 뒤 `getTargetRanges()`를 다시 읽는 방법은 피한다. 조합 중 범위 교체는 브라우저가 처리하게 둔다.
3. `input`은 DOM이 이미 변경된 뒤의 통지다. 실제 native 텍스트와 선택을 읽어 미리보기를 갱신한다. `event.data`를 “이번에 확정된 한 문자”로 단정하지 않는다. 후보 선택으로 긴 구절이 통째로 교체될 수 있다.
4. 조합 종료는 해당 native 거래를 확정하는 경계다. `compositionend.data`만으로 원문을 재구성하지 말고 실제 호스트 상태를 사용한다. 마지막 `input`이 종료 전/후 어느 쪽에 오더라도 같은 최종 상태를 두 번 커밋하지 않도록 편집 거래의 상태로 중복을 방지한다.
5. Enter·Backspace·Delete의 텍스트 편집 의미는 조합 밖 `beforeinput.inputType`으로 처리한다. 조합 중 Enter·방향키·Backspace는 후보 선택·확정·조합 수정일 수 있으므로 앱의 지도 명령이 먼저 가로채지 않는다. `keydown`은 지도 탐색/명시적 단축키처럼 텍스트 생성과 다른 명령에 제한한다.
6. 공간 이동은 새 native 편집 문맥을 만드는 명시적 경계다. 반면 서버가 주소·작성 경로의 연속성을 보존한 세계 크기 갱신은 조합 문맥을 불필요하게 없애지 않는다. 동기화 불확실성·실제 위치 변화는 별도로 취소한다.
7. native DOM offset과 세계의 셀 개수는 다르다. UTF-16 범위 → 원문 구간 → grapheme → 1/2칸 폭의 변환을 명시한다. 조합 중 NFC 정규화로 원문 길이·offset을 바꾸지 않는다.

`keyCode === 229`, 타입 없는 입력을 임의의 조합으로 추정하는 분기, 종료 직후 companion 이벤트를 일정 시간 무시하는 타이머, 나라별 자모를 앱에서 조립하는 코드가 기본 알고리즘이 되어서는 안 된다. 최신 브라우저만 지원하라는 요청은 이런 legacy·추측 경로를 제거할 근거다. 다만 현대 표준 자체가 정하는 비취소 편집과 조합 수명은 여전히 처리해야 한다.

`beforeinput` 없이 실제 `input`이 오는 경우도 MDN에 명시되어 있다. 정확한 대상 범위가 없는데 문자열의 공통 접두사·접미사만으로 기존 세계 셀을 지울 범위를 추정해서는 안 된다. 현재의 범위 기반 모델에서 이런 변경을 지원하지 못한다면 이를 명시적인 미지원 편집으로 보고 세계 변경을 거부해야 한다. 비취소 조합의 DOM 복원이 필요하면 활성 조합 중 즉시 재작성하지 말고 안전한 종료 경계를 사용한다. 이는 일반적인 현대 IME까지 모두 처리했다는 증거가 아니므로 OS별 실제 입력 검증에서 누락 경로를 확인해야 한다.

## EditContext를 비교한 이유와 현재 보류 근거

자료: [W3C EditContext](https://www.w3.org/TR/edit-context/) / [MDN 개요](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API) / [MDN TextUpdateEvent](https://developer.mozilla.org/en-US/docs/Web/API/TextUpdateEvent) / [MDN updateCharacterBounds](https://developer.mozilla.org/en-US/docs/Web/API/EditContext/updateCharacterBounds).

EditContext의 `textupdate`는 이전 텍스트의 `updateRangeStart`, `updateRangeEnd`와 그 범위를 대체할 `text`, 갱신된 선택을 제공한다. OS가 고른 한글 음절·일본어 변환 구절·중국어 후보의 범위 교체를 키별 추측 없이 받는 모델이다. 이때 native 문맥의 DOMString/UTF-16 인덱스와 Textworld의 grapheme/셀 좌표는 여전히 별도다. W3C 예제는 “UTF-16 codepoints”라는 표현을 쓰는데, 이를 사용자에게 보이는 grapheme 개수로 해석해서는 안 된다.

Canvas에 연결한 EditContext는 앱이 다음 의무를 가진다.

- `updateControlBounds()`와 `updateSelectionBounds()`로 화면 좌표를 알린다.
- OS의 `characterboundsupdate`에 `updateCharacterBounds()`로 응답한다. 늦으면 후보창이 잘못된 위치에 나타났다 이동할 수 있다.
- `textformatupdate`의 조합 구간 밑줄/두께를 실제 화면에 그린다. 일본어 변환 중 활성 구간의 표시를 앱이 임의로 생략해서는 안 된다.
- caret navigation/selection과 canvas 접근성을 별도로 구현한다. API를 썼다는 이유로 screen reader 접근성이 해결되지는 않는다.
- EditContext가 붙은 호스트의 DOM `input`을 주 입력 통로로 기대하지 않는다. 표준은 해당 호스트에서 DOM 자동 변경·input 발행을 하지 않으며, composition 이벤트는 EditContext에 발행한다.

지원 판단: [Chrome 공식 소개](https://developer.chrome.com/blog/introducing-editcontext-api)는 Chrome/Edge 121부터의 Chromium 구현을 설명한다. 조회한 [현재 지원 표](https://caniuse.com/mdn-api_editcontext)에서 Safari·Firefox는 여전히 미지원이며 MDN도 Baseline이 아니라고 표시한다. [Mozilla 공식 입장 #199](https://github.com/mozilla/standards-positions/issues/199)는 positive지만 호환성·접근성 우려가 남아 있고, [WebKit 입장 요청 #243](https://github.com/WebKit/standards-positions/issues/243)은 열린 상태다. **긍정적인 표준 입장은 실제 출시 지원과 다르다.**

따라서 현재 제안은 최신 세 엔진에서 사용할 수 있는 `contenteditable="true"` 기반 plain-text DOM 입력 모델 한 가지다. Chromium만 지원하는 별도 제품 결정을 한다면 EditContext를 다시 선택할 근거는 충분하지만, 그것은 사용자의 이번 “최신 브라우저” 조건과 같은 말이 아니다.

## 검증할 가설

- 실제 native CDP 범위 치환으로 첫 자모 `ㅎ` → 완성 음절 `한`이 같은 위치에 남고, 연속 음절에서도 앞부분이 재삽입되지 않는다.
- 일본어 읽기 → 여러 한자 후보의 구절 교체, 중국어 병음 → 한자 후보의 길이 변화가 한 번의 확정 편집으로 반영된다.
- 조합 중 Backspace·방향키·Enter가 세계 셀 삭제/지도 이동/줄바꿈으로 실행되지 않는다.
- 한 번의 후보 선택이 여러 글자를 만들거나 기존 조합 범위를 줄여도 native 원문과 공간 매핑이 일치한다.
- 분해 한글·결합 문자·서로게이트 쌍·ZWJ emoji 범위를 grapheme/UTF-16/셀 개수로 혼동하지 않는다.
- plain-text 붙여넣기·줄바꿈·범위 교체가 같은 의미의 native 편집으로 처리된다.
- 주소가 유지되는 세계 갱신과 취소되어야 하는 실제 이동이 구분된다.
- 현재 Chrome·Firefox·WebKit의 실제 DOM 이벤트 경로를 각각 실행한다. 브라우저 자동화와 OS별 실제 키보드 후보창 검증을 구분한다.
