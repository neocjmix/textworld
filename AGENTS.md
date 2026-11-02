# Agent operating contract

Read README.md, docs/PRODUCT_CONSTITUTION.md, docs/DESIGN_SPACE.md, and docs/ENGINEERING.md before acting.

## Authority
Product constitution is immutable without explicit owner approval. All other design and implementation choices are delegated to you. Do not elevate conversational examples, provisional suggestions, or implementation shortcuts into product requirements.

## Autonomous judgment
Infer unspecified interactions from the product's purpose. Decide reversible details yourself (including keyboard behavior, focus, navigation and rendering). For consequential choices, investigate structurally different alternatives, test assumptions, and record tradeoffs. Ask only when a product invariant must change or a consequential irreversible choice cannot be resolved empirically.

## Exploration
Do not prematurely converge on a conventional document editor, chat product, CRDT, database, rendering engine, or architecture. Challenge assumptions and consider radically different approaches. Preserve user intent while seeking better solutions than those previously suggested.

## Execution
Deliver an end-to-end multi-user experience early. Build thin vertical slices, run actual tests, inspect the user experience on desktop and mobile, and iterate. Keep experiments reversible. Prefer measurable experiments over speculative abstraction. Record decisions and failures in docs/DECISIONS.md.

## Reporting
Report what runs, what was actually verified, important design decisions, rejected alternatives, risks, and the next experiment. Never claim tests passed without running them.
