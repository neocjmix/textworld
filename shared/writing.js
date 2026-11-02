import { wrap, writePlan } from './world.js';

/** Local writing intent, never a document boundary or ownership claim. */
export class WritingSession {
  constructor(cursor) { this.reset(cursor); }

  reset(cursor) {
    this.lineStartX = cursor.x;
    this.trail = [];
    this.active = false;
  }

  reposition(cursor) {
    if (!this.active) this.reset(cursor);
    else this.trail = [];
  }

  plan(text, cursor, world) {
    return writePlan(text, cursor.x, cursor.y, world, { lineStartX: this.lineStartX });
  }

  accept(plan) {
    this.active = true;
    this.trail.push(...plan.steps);
    // Bound local traversal memory. This is not a durable undo log.
    if (this.trail.length > 4096) this.trail.splice(0, this.trail.length - 4096);
  }

  backspace(cursor, world, cells = new Map()) {
    const last = this.trail.at(-1);
    if (last && last.to.x === cursor.x && last.to.y === cursor.y) {
      this.trail.pop();
      return { cursor: { ...last.from }, erase: last.kind === 'write' };
    }
    // Outside the known typing path, Backspace addresses the cell on the left.
    const previous = { x: wrap(cursor.x - 1, world.width), y: cursor.y };
    const cell = cells.get(`${previous.x},${previous.y}`);
    if (cell?.width === 0) previous.x = cell.leadX;
    this.reposition(previous);
    return { cursor: previous, erase: true };
  }
}
