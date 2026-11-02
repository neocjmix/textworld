import { cellKey, wrap, writePlan } from './world.js';

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const samePoint = (a, b) => a.x === b.x && a.y === b.y;
const segments = text => [...segmenter.segment(text)].map(({ segment, index }) => ({
  start: index, end: index + segment.length, text: segment,
}));

export class NativeProjectionError extends Error {}

/**
 * A ledger for the native editor's temporary UTF-16 context. It is not a world
 * document: unchanged suffixes keep their original cell addresses after edits.
 * Raw native strings are never normalized; writePlan normalizes committed glyphs.
 */
export class NativeProjection {
  constructor(cursor = { x: 0, y: 0 }) { this.reset(cursor); }

  reset(cursor = this.cursor) {
    this.text = '';
    this.entries = [];
    this.anchor = { ...cursor };
    this.cursor = { ...cursor };
    this.selectionStart = this.selectionEnd = 0;
    this.revision = (this.revision || 0) + 1;
  }

  pointAt(offset, entries = this.entries, text = this.text, anchor = this.anchor) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
      throw new NativeProjectionError('Native selection is outside its known UTF-16 context.');
    }
    if (!entries.length) return { ...anchor };
    if (entries === this.entries && offset === this.selectionStart && offset === this.selectionEnd) return { ...this.cursor };
    // At a boundary prefer the end of the glyph to the left. Native insertion
    // follows that glyph even when a previous replacement left a spatial gap.
    const left = entries.find(entry => entry.start < offset && offset <= entry.end);
    const right = entries.find(entry => entry.start === offset);
    const entry = left || right;
    if (!entry?.valid) throw new NativeProjectionError('Native selection refers to overwritten input context.');
    return { ...(left ? entry.to : entry.from) };
  }

  rangePoint(start, end = start) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this.text.length) {
      throw new NativeProjectionError('Native replacement range is outside its known context.');
    }
    const touched = this.entries.find(entry => entry.start < end && entry.end > start
      || start === end && entry.start < start && start < entry.end);
    if (touched) {
      if (!touched.valid) throw new NativeProjectionError('Native replacement refers to overwritten input context.');
      return { ...touched.from };
    }
    return this.pointAt(start);
  }

  plan(edit, cursor, world, { lineStartX = cursor.x } = {}) {
    const { before, start, end, text, after } = edit;
    if (before !== this.text || typeof text !== 'string' || typeof after !== 'string'
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > before.length
      || before.slice(0, start) + text + before.slice(end) !== after) {
      throw new NativeProjectionError('Native edit does not match its authoritative UTF-16 range.');
    }
    const selectionStart = edit.selectionStart ?? start + text.length;
    const selectionEnd = edit.selectionEnd ?? selectionStart;
    if (!Number.isSafeInteger(selectionStart) || !Number.isSafeInteger(selectionEnd)
      || selectionStart < 0 || selectionEnd < selectionStart || selectionEnd > after.length) {
      throw new NativeProjectionError('Native selection is outside the resulting context.');
    }
    const fits = point => point.x >= 0 && point.x < world.width && point.y >= 0 && point.y < world.height;
    const nextSegments = segments(after), old = this.entries, delta = after.length - before.length;
    let prefix = 0;
    // The authoritative range determines what may be reused. Exact grapheme
    // boundaries expand combining-mark/ZWJ edits; this is not a text diff guess.
    while (prefix < old.length && prefix < nextSegments.length && old[prefix].end <= start) {
      const a = old[prefix], b = nextSegments[prefix];
      if (a.start !== b.start || a.end !== b.end || a.text !== b.text) break;
      prefix++;
    }
    let oldEnd = old.length, newEnd = nextSegments.length;
    while (oldEnd > prefix && newEnd > prefix && old[oldEnd - 1].start >= end) {
      const a = old[oldEnd - 1], b = nextSegments[newEnd - 1];
      if (a.start + delta !== b.start || a.end + delta !== b.end || a.text !== b.text) break;
      oldEnd--; newEnd--;
    }
    const removed = old.slice(prefix, oldEnd);
    if (removed.some(entry => !entry.valid || !fits(entry.from) || !fits(entry.to))) {
      throw new NativeProjectionError('Native edit refers to an unknown or remapped spatial range.');
    }
    let origin;
    if (removed.length) origin = removed[0].from;
    else if (start === end && start === this.selectionStart && end === this.selectionEnd) origin = cursor;
    else if (prefix > 0) {
      if (!old[prefix - 1].valid) throw new NativeProjectionError('Native insertion follows overwritten context.');
      origin = old[prefix - 1].to;
    } else if (old.length) {
      if (!old[0].valid) throw new NativeProjectionError('Native insertion precedes overwritten context.');
      origin = old[0].from;
    } else origin = cursor;
    if (!fits(origin)) throw new NativeProjectionError('Native insertion address no longer exists.');
    const replacement = nextSegments.slice(prefix, newEnd);
    const replacementText = replacement.map(segment => segment.text).join('');
    const write = writePlan(replacementText, origin.x, origin.y, world, { lineStartX });
    const clear = new Map();
    for (const entry of removed) for (const point of entry.cells) clear.set(cellKey(point.x, point.y), { x: point.x, y: point.y });
    const touched = new Set([...clear.keys(), ...write.cells.map(cell => cellKey(cell.x, cell.y))]);
    const preserved = entry => ({
      ...entry, valid: entry.valid && !entry.cells.some(cell => touched.has(cellKey(cell.x, cell.y))),
    });
    const entries = old.slice(0, prefix).map(preserved);
    let position = { ...origin };
    for (const segment of replacement) {
      const planned = writePlan(segment.text, position.x, position.y, world, { lineStartX });
      const occupied = new Set(planned.cells.map(cell => cellKey(cell.x, cell.y)));
      for (const previous of entries) {
        if (previous.valid && previous.cells.some(cell => occupied.has(cellKey(cell.x, cell.y)))) previous.valid = false;
      }
      entries.push({ ...segment, from: { ...position }, to: { ...planned.cursor },
        steps: planned.steps, cells: planned.cells.map(({ x, y }) => ({ x, y })), valid: true });
      position = planned.cursor;
    }
    for (let index = oldEnd; index < old.length; index++) {
      entries.push({ ...preserved(old[index]), start: old[index].start + delta, end: old[index].end + delta });
    }
    const changed = before !== after;
    // A no-op conversion changes neither cells nor known range ownership.
    if (!changed) {
      entries.splice(0, entries.length, ...old.map(entry => ({ ...entry })));
      clear.clear();
    }
    // Deleting a prefix can leave a gap before an unchanged suffix. The native
    // caret stays at the edited address, rather than jumping to that suffix.
    const caret = changed && selectionEnd === start + text.length
      ? { ...write.cursor } : this.pointAt(selectionEnd, entries, after, origin);
    const candidates = entries.filter(entry => entry.start < selectionEnd);
    const history = [];
    let at = caret, complete = true;
    outer: for (let index = candidates.length - 1; index >= 0; index--) {
      const entry = candidates[index];
      if (!entry.valid) { complete = false; break; }
      for (let stepIndex = entry.steps.length - 1; stepIndex >= 0; stepIndex--) {
        const step = entry.steps[stepIndex];
        if (!samePoint(step.to, at)) { complete = false; break outer; }
        history.unshift(step); at = step.from;
      }
    }
    const connectsToBase = complete && samePoint(at, this.anchor);
    return {
      changed, x: origin.x, y: origin.y, text: changed ? replacementText : '', clear: [...clear.values()],
      cursor: caret, writeCursor: { ...write.cursor }, steps: changed ? write.steps : [], historyToCursor: history, connectsToBase,
      nativeText: after, selectionStart, selectionEnd, entries, revision: this.revision,
    };
  }

  accept(plan) {
    if (plan.revision !== this.revision) throw new NativeProjectionError('Native projection changed before this edit was accepted.');
    this.text = plan.nativeText;
    this.entries = plan.entries;
    this.cursor = { ...plan.cursor };
    this.selectionStart = plan.selectionStart;
    this.selectionEnd = plan.selectionEnd;
    this.revision++;
  }
}
