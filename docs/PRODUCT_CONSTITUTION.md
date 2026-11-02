# Product Constitution

These are product-level invariants, not implementation prescriptions.

1. Multiple users inhabit the same live, spatial, two-dimensional character field.
2. Text input overwrites addressed cells; it never inserts cells or shifts existing text. Deletion must not collapse surrounding content.
3. The default public world's topology is toroidal.
4. Public space can expand and contract in response to density. The metric and algorithm are deliberately unspecified.
5. Each user's cursor points to exactly one character cell and represents their presence and input position.
6. Other users' cursors are visible in real time. Exposure is the default, including approximate reading location through cursor position.
7. Viewport navigation and cursor position are coupled: the cursor need not be centered, but scrolling brings it within the visible viewport. Zoom is bounded.
8. Geographic position informs initial placement; users can return to the world location corresponding to their current GPS location.
9. Public-world character permanence is not guaranteed. Characters may fragment, be overwritten or disappear.
10. A separate scavenger program may remove aged or damaged text; the core must retain sufficient evidence for its decisions, without embedding scavenger policy.
11. Future private/collaboration worlds may configure different topology, persistence, scavenger activity, and deterministic expansion rules.
12. Mobile interaction is a first-class design concern. The aim is spatial co-presence through cursors and text, not a simulated 3D office.

Do not silently reinterpret the world as a document with lines that reflow, a timeline of messages, or a set of owned posts.

Not constitutionally fixed: Enter/Backspace behavior, cursor styling, coordinate encoding, resize algorithms, GPS projection, transport, conflict arbitration, persistence technology, rendering, UI framework, hosting, and implementation milestones.
