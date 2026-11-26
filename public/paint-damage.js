// Paint invalidation only. Network observations and intermediate overwrites are
// still applied in order; this remembers the pixels from the last animation frame.
export const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;

export function* visibleInstances(value, period, first, last) {
  const start = value + Math.ceil((first - value) / period) * period;
  for (let n = start; n <= last; n += period) yield n;
}

export function createPaintDamage() {
  let previous = new Map(), signature;
  return {
    invalidate() { signature = undefined; },
    plan(items, key, width, height, dpr = 1) {
      const next = new Map(items.map(item => [item.key, item]));
      const dirty = [];
      const add = rect => {
        const x = Math.max(0, Math.floor(rect.x * dpr) / dpr);
        const y = Math.max(0, Math.floor(rect.y * dpr) / dpr);
        const right = Math.min(width, Math.ceil((rect.x + rect.width) * dpr) / dpr);
        const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * dpr) / dpr);
        if (right > x && bottom > y) dirty.push({ x, y, width: right - x, height: bottom - y });
      };
      let full = signature !== key;
      if (!full) {
        for (const [id, item] of next) {
          const old = previous.get(id);
          if (!old || old.paint !== item.paint) { if (old) add(old.bounds); add(item.bounds); }
        }
        for (const [id, old] of previous) if (!next.has(id)) add(old.bounds);
      }
      previous = next; signature = key;
      // A busy frame stays bounded. Large/overlapping changes use the simple full draw.
      if (dirty.length > 64) full = true;
      const regions = [];
      if (!full) for (const rect of dirty) {
        let box = rect;
        for (let i = regions.length - 1; i >= 0; i--) {
          const other = regions[i];
          if (!intersects(box, other)) continue;
          const x = Math.min(box.x, other.x), y = Math.min(box.y, other.y);
          box = { x, y, width: Math.max(box.x + box.width, other.x + other.width) - x,
            height: Math.max(box.y + box.height, other.y + other.height) - y };
          regions.splice(i, 1); i = regions.length;
        }
        regions.push(box);
      }
      let area = regions.reduce((sum, r) => sum + r.width * r.height, 0);
      if (regions.length > 16 || area > width * height * .45) full = true;
      if (full) { regions.splice(0, regions.length, { x: 0, y: 0, width, height }); area = width * height; }
      return { full, regions, fraction: area / (width * height),
        includes: bounds => full || regions.some(rect => intersects(rect, bounds)) };
    }
  };
}
