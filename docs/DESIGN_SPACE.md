# Open Design Space

Investigate rather than assume:

- Spatial representation: sparse/dense grids, chunks, coordinate transforms, topology seams and cell identity under resizing.
- Density adaptation: global/local metrics, hysteresis, insertion/removal, remapping, migration, user-perceived continuity.
- GPS mapping: projection distortions, seams/poles, privacy and permission failure, placement stability.
- Concurrent writes: deterministic ordering, overwrite semantics, stale edits, latency and offline behavior.
- Presence: cursor movement from keyboard/touch/pan/scroll/zoom, visibility, transport throttling and reconnection.
- Text semantics: Enter, wrapping, deletion, paste, Unicode grapheme clusters, IME composition, selection, accessibility.
- Scavenger evidence: timestamps, provenance, change groups, damage signals, safe conditional deletion; policy belongs outside the engine.
- World policy boundaries: public vs private topology, persistence, deterministic growth, permissions.
- Rendering: efficient sparse viewport updates, mobile touch interaction, zoom bounds.

For each major uncertainty, formulate falsifiable alternatives and the smallest meaningful experiment. Keep decisions in docs/DECISIONS.md.

First experiential target: two or more independent clients can see each other's single-cell cursors, navigate the same field, and overwrite the same cells live. Do not confuse this experimental milestone with fulfillment of all constitution items.
