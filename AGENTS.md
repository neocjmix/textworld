# Agent operating contract

Read README.md, docs/PRODUCT_CONSTITUTION.md, docs/DESIGN_SPACE.md, and docs/ENGINEERING.md before acting.

## Authority
Product constitution is immutable without explicit owner approval. All other design and implementation choices are delegated to you. Do not elevate conversational examples, provisional suggestions, or implementation shortcuts into product requirements.

## 출시 전 운영 원칙

Textworld가 정식 출시될 때까지 변경을 직접 체험하고 검증하는 곳은 기존 Railway `production/textworld`의 공개 지도다. 체험용 월드나 두 번째 공개 배포를 만들지 않는다. 이 원칙은 기능, 실험, 성능 개선, UI와 문서 등 모든 변경에 적용한다.

- 응집된 변경이 준비되는 즉시 커밋하여 `main`에 반영하고 기존 서비스에 배포를 시작한다. PR 대기나 전체 시험 완료를 배포의 선행 조건으로 삼지 않는다. 출시 전에는 일시적인 불안정을 감수하고 프로덕션에서 발견한 문제를 바로 고쳐 다시 배포한다.
- 배포는 항상 비동기로 시작한다. 푸시 직후 `npm run deploy:production`으로 원격 `main`의 배포 접수를 확인한다. 자동 트리거가 빠지면 이 명령이 같은 서비스에 빌드를 요청한다. 빌드와 전환이 진행되는 동안 구현·회귀 시험·문서 작업을 병행한다. 연속된 변경에서는 최신 커밋이 최종 서비스되도록 확인한다. 완료 보고 전에는 해당 배포의 성공 상태와 실제 공개 HTTPS 지도·WebSocket 동작을 확인하고 사용자가 들어갈 링크를 제공한다.
- 봇을 동원하는 체험·부하 실행은 사용자가 명시적으로 시작을 요청할 때 같은 프로덕션 월드에서 진행한다. 배포·재시작·방문은 실행 신호가 아니다. 각 실행에 수명과 예산을 적용하고, 실행 위치 링크·종료 결과를 공유한다. 일반 단위 시험과 재현용 로컬 fixture는 독립적으로 실행할 수 있다.

## Autonomous judgment
Infer unspecified interactions from the product's purpose. Decide reversible details yourself (including keyboard behavior, focus, navigation and rendering). For consequential choices, investigate structurally different alternatives, test assumptions, and record tradeoffs. Ask only when a product invariant must change or a consequential irreversible choice cannot be resolved empirically.

## Exploration
Do not prematurely converge on a conventional document editor, chat product, CRDT, database, rendering engine, or architecture. Challenge assumptions and consider radically different approaches. Preserve user intent while seeking better solutions than those previously suggested.

## Execution
Deliver an end-to-end multi-user experience early. Build thin vertical slices, run actual tests, inspect the user experience on desktop and mobile, and iterate. Keep experiments reversible. Prefer measurable experiments over speculative abstraction. Record decisions and failures in docs/DECISIONS.md.

## Reporting
Report what runs, what was actually verified, important design decisions, rejected alternatives, risks, and the next experiment. Never claim tests passed without running them.
