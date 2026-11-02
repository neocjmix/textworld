# Engineering Principles

- Optimize for a working experience and rapid learning, not speculative completeness.
- Separate hard product invariants from hypotheses and implementation decisions.
- Make local, reversible UX decisions autonomously. Infer intent from spatial interaction rather than asking the owner for routine editor behavior.
- For high-impact architecture, compare substantively different options, including simpler alternatives.
- Validate core invariants with executable tests: overwrite without reflow; topology wrap; concurrent edits; presence and viewport coupling; coordinate transformations as introduced.
- Test Unicode grapheme clusters and Korean IME; do not assume one code point equals one displayed cell.
- Make synchronization and resize operations explicit, observable and recoverable. Avoid silent data corruption.
- Treat geographic position as sensitive: minimize collection, avoid exposing precise GPS without a deliberate product decision, and handle denial gracefully while preserving the agreed GPS feature.
- Make expiration conditional on current cell version, preventing stale cleanup from erasing new writes.
- Avoid building complex policy infrastructure before its first real use, while preserving clean seams for future worlds.
- Maintain honest reporting of verified behavior and known gaps.
