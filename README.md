# Textworld

A shared, spatial, real-time text world. People inhabit a 2D character grid as visible cursors, move, read, and overwrite cells together.

## Principles
- Public world uses toroidal topology and density-responsive expansion/contraction.
- Writing overwrites cells, never inserts or shifts neighboring content.
- Each user is represented by a visible, single-cell cursor; browsing and scrolling affect presence, and the cursor remains in the viewport.
- Zoom is bounded; GPS determines initial placement and supports return to current geographic position.
- Public text is ephemeral. An independent scavenger can use cell provenance and history to remove old or damaged content.
- Future private worlds may choose different topology, persistence, deterministic growth, and scavenger policies.
- Mobile usability matters.

See [AGENTS.md](AGENTS.md) for agent operating instructions. The product principles are binding; implementation details remain open for autonomous exploration.
