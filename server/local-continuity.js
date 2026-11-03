import { insideRelocation, writingFits } from '../shared/relocation.js';

// Prove a local rectangle, including empty addresses and the glyph margins,
// undergoes one rigid translation. Wrapping/clipped views conservatively reset.
// The proof is bounded by one participant's permitted viewport, not world area.
export function localContinuity(before, peer, result, policy, writing) {
  const { view, requested } = before;
  if (view.cols !== requested.cols || view.rows !== requested.rows) return null;
  const bounds = { x: view.x - 2, y: view.y - 2, cols: view.cols + 4, rows: view.rows + 4 };
  const relocation = { bounds, dx: peer.x - before.peer.x, dy: peer.y - before.peer.y };
  if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.cols > result.from.width || bounds.y + bounds.rows > result.from.height
    || bounds.x + relocation.dx < 0 || bounds.y + relocation.dy < 0
    || bounds.x + bounds.cols + relocation.dx > result.width || bounds.y + bounds.rows + relocation.dy > result.height) return null;
  for (let y = bounds.y; y < bounds.y + bounds.rows; y++) for (let x = bounds.x; x < bounds.x + bounds.cols; x++) {
    const point = result.mapping(x, y);
    if (!point || point.x !== x + relocation.dx || point.y !== y + relocation.dy) return null;
  }
  if (!writingFits(writing, relocation)
    || [...policy.recent.values(), ...policy.carets.values()].some(p => !insideRelocation(p, relocation))
    || [...policy.origins].some(x => x < bounds.x || x >= bounds.x + bounds.cols)) return null;
  return relocation;
}
