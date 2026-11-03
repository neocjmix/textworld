import { wrap, graphemes } from './world.js';
import { WritingSession } from './writing.js';
import { NativeProjection } from './native-projection.js';
import { nativeWindow } from './native-context.js';

const point = p => ({ x: p.x, y: p.y });
const same = (a, b) => a.x === b.x && a.y === b.y;
const integer = value => { if (!Number.isSafeInteger(value)) throw new Error('An integer is required.'); return value; };
const textInput = text => {
  if (typeof text !== 'string' || text.length > 4096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)
    || graphemes(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')).length > 64) throw new Error('Invalid text.');
};

/** A participant's temporary input context, not a document or a topology lock.
 * Both peers predict the same ordered intentions. Only the server commits cells.
 */
export class CursorInput {
  constructor(cursor) {
    this.cursor = point(cursor);
    this.writing = new WritingSession(cursor);
    this.native = new NativeProjection(point(cursor));
    this.nativeBase = [];
    this.context = null;
  }

  snapshot() {
    return { cursor: point(this.cursor), writing: { ...this.writing }, native: { ...this.native },
      nativeBase: this.nativeBase, context: this.context };
  }

  restore(state) {
    this.cursor = point(state.cursor);
    Object.assign(this.writing, state.writing);
    Object.assign(this.native, state.native);
    this.nativeBase = state.nativeBase;
    this.context = state.context;
  }

  resetNative(context = null) {
    this.native.reset(this.cursor);
    this.nativeBase = this.writing.trail.slice();
    this.context = context;
  }

  plan(action, world, cells = new Map()) {
    // Shallow forks suffice: planners replace arrays instead of mutating their
    // elements. A failed policy/DB operation must not advance this context.
    const next = new CursorInput(this.cursor);
    next.restore(this.snapshot());
    next.writing.trail = this.writing.trail.slice();
    let operation = null, native = false;
    const canonical = p => ({ x: wrap(integer(p.x), world.width), y: wrap(integer(p.y), world.height) });
    if (action.kind === 'native') {
      integer(action.context);
      if (action.context !== next.context) next.resetNative(action.context);
      const before = next.native.text, edit = action.edit;
      if (!edit) throw new Error('Invalid native edit.');
      textInput(edit.text);
      integer(edit.start); integer(edit.end);
      const after = before.slice(0, edit.start) + edit.text + before.slice(edit.end);
      if (after.length > 4352) throw new Error('Native context is too large.');
      const plan = next.native.plan({ ...edit, before, after }, next.cursor, world, { lineStartX: next.writing.lineStartX });
      if (plan.entries.length > 512) throw new Error('Native context is too large.');
      native = true;
      if (plan.changed && (plan.clear.length || plan.steps.some(s => s.kind === 'write'))) {
        operation = { type: 'write', x: plan.x, y: plan.y, text: plan.text, clear: plan.clear, lineStartX: next.writing.lineStartX };
      }
      next.native.accept(plan);
      next.writing.trail = [...(plan.connectsToBase ? next.nativeBase : []), ...plan.historyToCursor].slice(-512);
      next.writing.active = true;
      next.cursor = point(plan.cursor);
      const window = nativeWindow(next.native.text, next.native.selectionStart, next.native.selectionEnd);
      if (window) {
        next.native.retain(window);
        let index = next.writing.trail.length, at = next.cursor;
        while (index > 0 && !same(at, next.native.anchor) && same(next.writing.trail[index - 1].to, at)) at = next.writing.trail[--index].from;
        next.nativeBase = same(at, next.native.anchor) ? next.writing.trail.slice(0, index) : [];
      }
    } else {
      if (action.kind === 'type') {
        textInput(action.text);
        const plan = next.writing.plan(action.text, next.cursor, world);
        if (plan.cells.length) operation = { type: 'write', ...next.cursor, text: action.text, lineStartX: next.writing.lineStartX };
        next.writing.accept(plan); next.cursor = point(plan.cursor);
      } else if (action.kind === 'backspace') {
        const backspace = next.writing.backspace(next.cursor, world, cells);
        next.cursor = point(backspace.cursor);
        if (backspace.erase) operation = { type: 'erase', ...next.cursor, intent: 'backspace' };
      } else if (action.kind === 'delete') {
        operation = { type: 'erase', ...next.cursor };
      } else if (action.kind === 'move' || action.kind === 'goto' || action.kind === 'home') {
        next.cursor = canonical(action.kind === 'move' ? { x: next.cursor.x + integer(action.dx), y: next.cursor.y + integer(action.dy) }
          : action.kind === 'home' ? { x: next.writing.lineStartX, y: next.cursor.y } : action);
        if (action.kind === 'goto' || action.newOrigin !== false) next.writing.reset(next.cursor);
        else next.writing.reposition(next.cursor);
      } else throw new Error('Unknown cursor action.');
      next.writing.trail = next.writing.trail.slice(-512);
      next.resetNative();
    }
    return { next, operation, native, moved: !same(next.cursor, this.cursor) };
  }
}

/** Keep only traversable local Backspace steps; a vanished gap is not an undo.
 * Enter's origin follows the old margin on the participant's current row.
 */
export function remapWriting(writing, oldCursor, newCursor, resize) {
  const map = resize.cursorMapping;
  writing.lineStartX = map({ x: writing.lineStartX, y: oldCursor.y }).x;
  writing.trail = writing.trail.map(step => ({ ...step, from: map(step.from), to: map(step.to) }))
    .filter(step => step.kind === 'return' || step.from.y === step.to.y
      && [1, 2].includes(wrap(step.to.x - step.from.x, resize.width)));
  // Keep a connected suffix ending at the corrected cursor.
  let at = newCursor, start = writing.trail.length;
  while (start > 0 && same(writing.trail[start - 1].to, at)) { at = writing.trail[--start].from; }
  writing.trail = writing.trail.slice(start);
}
