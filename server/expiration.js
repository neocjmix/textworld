import { randomUUID } from 'node:crypto';
import { EXPIRY_AGE_MS } from '../shared/freshness.js';

export const EXPIRY_BATCH = 64;

// Shared timestamps may precede a write by up to five seconds. Wait that
// additional interval so no glyph expires before its actual lifetime ends.
export function expire(world, publish = () => {}, limit = EXPIRY_BATCH, recordLag) {
  const cutoff = world.now() - EXPIRY_AGE_MS - 5000;
  const candidates = world.expiredCandidates(cutoff, limit);
  if (!candidates.length) return 0;
  if (recordLag) {
    const oldest = Math.min(...candidates.map(({x, y}) => world.getCell(x, y).updatedAt));
    recordLag(cutoff - oldest);
  }
  const result = world.conditionalDelete({ id: randomUUID(), epoch: world.epoch, candidates });
  if (result.cells.length) publish(result);
  return result.cells.length;
}
