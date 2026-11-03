// Policy, deliberately separate from topology and character expiration.
export const DENSITY = Object.freeze({ lower: .04, target: .08, upper: .125,
  intervalMs: 1000, shrinkDelayMs: 30000, shrinkIntervalMs: 5000,
  forecastSeconds: 10, smoothingSeconds: 5, stepFraction: 1 / 8,
  minWidth: 32, minHeight: 16, maxWidth: 1024, maxHeight: 512 });

// Count displayed columns, not UTF-16 bytes, tombstones, written whitespace,
// or a fixed allowance for idle connections. Wide heads account for both cells.
export const inkArea = cell => cell?.width !== 0 && cell?.text?.trim() ? (cell.width ?? 1) : 0;

export class DensityController {
  constructor(now, occupied) {
    this.sampleAt = now; this.occupied = occupied; this.rate = 0;
    this.mode = null; this.lowSince = null;
  }

  decide({ now, occupied, width, height, lastResize, cooldown }) {
    const dt = Math.max(0, (now - this.sampleAt) / 1000);
    if (dt > 0) {
      const weight = 1 - Math.exp(-dt / DENSITY.smoothingSeconds);
      this.rate += weight * ((occupied - this.occupied) / dt - this.rate);
      this.sampleAt = now; this.occupied = occupied;
    }
    const area = width * height, density = occupied / area;
    const projected = occupied + Math.max(0, this.rate) * DENSITY.forecastSeconds;
    const projectedDensity = projected / area;
    if (projectedDensity > DENSITY.upper) this.mode = 'grow';
    else if (this.mode === 'grow' && projectedDensity <= DENSITY.target) this.mode = null;
    if (projectedDensity < DENSITY.lower) this.lowSince ??= now;
    else this.lowSince = null;
    if (this.mode === 'shrink' && projectedDensity >= DENSITY.target) this.mode = null;
    if (!this.mode && this.lowSince !== null && now - this.lowSince >= DENSITY.shrinkDelayMs) this.mode = 'shrink';
    const targetArea = Math.max(DENSITY.minWidth * DENSITY.minHeight,
      Math.min(DENSITY.maxWidth * DENSITY.maxHeight, Math.ceil(projected / DENSITY.target)));
    this.goalArea = targetArea;
    const result = { density, projectedDensity, occupied, netCellsPerSecond: this.rate,
      targetArea, mode: this.mode, changed: false };
    const interval = cooldown ?? (this.mode === 'shrink' ? DENSITY.shrinkIntervalMs : DENSITY.intervalMs);
    if (now - lastResize < interval) return { ...result, reason: 'cooldown' };
    if (!this.mode) return { ...result, reason: this.lowSince === null ? 'stable' : 'settling' };
    if (this.mode === 'grow' ? area >= targetArea : area <= targetArea) {
      this.mode = null;
      return { ...result, mode: null, reason: density > DENSITY.upper || density < DENSITY.lower ? 'limit' : 'stable' };
    }
    return { ...result, reason: 'due' };
  }

  resized(occupied, area) {
    // Geometry losses are not negative writing traffic.
    this.occupied = occupied;
    // Finish on the successful commit, not on the next sample: otherwise new
    // arrivals move the target before we can ever leave the growth mode.
    if (this.mode === 'grow' && area >= this.goalArea || this.mode === 'shrink' && area <= this.goalArea) this.mode = null;
  }
}
