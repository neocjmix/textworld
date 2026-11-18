import { DENSITY } from './density.js';
import { coherentSeams } from './coherent-seams.js';
import { remesh } from './topology.js';

export function selectResize(cells, from, control, seed) {
  const grow = control.mode === 'grow';
  const preferWidth = grow ? from.width / from.height <= 2 : from.width / from.height > 2;
  const dimensions = [
    { axis: 'width', other: from.height, size: from.width, min: DENSITY.minWidth, max: DENSITY.maxWidth },
    { axis: 'height', other: from.width, size: from.height, min: DENSITY.minHeight, max: DENSITY.maxHeight },
  ].filter(d => grow ? d.size < d.max : d.size > d.min)
    .sort((a, b) => Number(b.axis === (preferWidth ? 'width' : 'height')) - Number(a.axis === (preferWidth ? 'width' : 'height')));
  let best, candidate = 0;
  for (const d of dimensions) {
    const goal = Math.ceil(control.targetArea / d.other);
    // Blank preservation must not turn a 2D world into an ever longer strip.
    const min = Math.max(d.min, d.axis === 'width' ? d.other : Math.ceil(d.other / 4));
    const max = Math.min(d.max, d.axis === 'width' ? d.other * 4 : d.other);
    const room = grow ? max - d.size : d.size - min;
    if (room <= 0) continue;
    const requested = Math.min(room, Math.max(1, Math.floor(d.size * DENSITY.stepFraction)), Math.max(1, Math.abs(goal - d.size)));
    // A large blank deletion may not fit where several smaller ones would.
    // Exhaust smaller blank steps before forcing deletion; growth of a band
    // has the same cut locations regardless of its inserted width.
    for (let step = requested; step >= 1; step = grow || step === 1 ? 0 : Math.max(1, Math.floor(step / 2))) {
      const to = { ...from, [d.axis]: d.size + (grow ? step : -step) };
      for (let attempt = 0; attempt < 2; attempt++) {
        const candidateSeed = (seed + candidate++ * 0x9e3779b9) >>> 0;
        const seams = coherentSeams(cells, from, d.axis, grow ? step : -step, candidateSeed);
        const plan = remesh(cells, from, to, candidateSeed, { seams });
        if (plan.preservesText) return { to, seed: candidateSeed, seams, preservation: 'text' };
        // Forced progress must still provide the requested capacity, not an
        // arbitrarily tiny safe-looking change that cannot catch up to input.
        if (step !== requested) continue;
        const score = plan.summary.lostTextCells * (2 * from.width * from.height + 1) + plan.summary.brokenAdjacencies;
        if (!best || score < best.score) best = { to, seed: candidateSeed, seams, score };
      }
    }
  }
  if (!best) return null;
  return { ...best, preservation: 'forced' };
}
