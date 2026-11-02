import { randomUUID } from 'node:crypto';
import { EXPIRY_AGE_MS } from '../shared/freshness.js';

// Shared timestamps may precede a write by up to five seconds. Wait that
// additional interval so no glyph expires before its actual lifetime ends.
export function expire(world, publish = () => {}) {
  const candidates = world.expiredCandidates(world.now() - EXPIRY_AGE_MS - 5000);
  if (!candidates.length) return 0;
  const result = world.conditionalDelete({ id: randomUUID(), epoch: world.epoch, candidates });
  if (result.cells.length) publish(result);
  return result.cells.length;
}
