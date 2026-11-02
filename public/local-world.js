import { cellKey, cellSpan, occupiedCell, wrap, writePlan } from '../shared/world.js';

/**
 * Paint accepted local edits immediately, without treating them as confirmed
 * server state. Rebuild from authoritative cells and the remaining operations
 * whenever a server patch arrives; never roll back by restoring old cell values.
 */
export function projectLocalCells(authoritative, operations, world) {
  const cells = new Map(authoritative);
  for (const operation of operations) {
    const { id, type } = operation;
    const changes = new Map();
    const spanAt = (x, y) => cellSpan((a, b) => cells.get(cellKey(a, b)), x, y, world);
    const clearAt = (x, y) => {
      const span = spanAt(x, y);
      for (const old of span.length ? span : [{ x, y }]) {
        changes.set(cellKey(old.x, old.y), { x: old.x, y: old.y, text: '' });
      }
    };

    if (type === 'write') {
      const plan = writePlan(operation.text, operation.x, operation.y, world, { lineStartX: operation.lineStartX });
      for (const address of operation.clear || []) clearAt(address.x, address.y);
      // Like the server, all displaced spans come from the state before this
      // operation. Applying clears incrementally could detach a wide glyph.
      for (const cell of plan.cells) clearAt(cell.x, cell.y);
      for (const cell of plan.cells) changes.set(cellKey(cell.x, cell.y), cell);
    } else if (type === 'erase') {
      clearAt(wrap(operation.x, world.width), wrap(operation.y, world.height));
    } else {
      throw new TypeError(`Unknown local operation: ${type}`);
    }

    for (const [key, change] of changes) {
      if (!occupiedCell(change)) { cells.delete(key); continue; }
      cells.set(key, {
        ...change, width: change.width ?? 1, leadX: change.leadX ?? null,
        version: `local:${id}`, author: operation.author ?? 'local', group: id,
      });
    }
  }
  return cells;
}
