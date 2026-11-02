const isReturn = type => type === 'insertLineBreak' || type === 'insertParagraph';
const isCellDelete = type => type === 'deleteContentBackward' || type === 'deleteContentForward';
const isTextEdit = type => type.startsWith('insert') || type.startsWith('delete');

/**
 * A modern contenteditable editing host, not a keyboard decoder.
 * InputEvent target ranges describe UTF-16 edits; the browser owns composition
 * and its DOM until completion. No keyCode, timer or language-specific rules.
 */
export function createNativeInput(input, {
  onEdit, onPreedit = () => {}, onCommand = () => {}, onUnsupported = () => {},
  onCompositionChange = () => {}, onInvalidated = () => {}, onReset = () => {},
}) {
  let committed = input.textContent, pending = null, session = null, preview = '';

  function offset(node, index) {
    if (node !== input && !input.contains(node)) return null;
    const range = document.createRange();
    range.selectNodeContents(input);
    try { range.setEnd(node, index); } catch { return null; }
    return range.toString().length;
  }
  function selection() {
    const selected = document.getSelection();
    if (!selected?.rangeCount) return { selectionStart: committed.length, selectionEnd: committed.length };
    const range = selected.getRangeAt(0);
    const start = offset(range.startContainer, range.startOffset), end = offset(range.endContainer, range.endOffset);
    return { selectionStart: start ?? committed.length, selectionEnd: end ?? committed.length };
  }
  function target(event) {
    const ranges = event.getTargetRanges();
    if (ranges.length !== 1) return null;
    const range = ranges[0], start = offset(range.startContainer, range.startOffset), end = offset(range.endContainer, range.endOffset);
    return start === null || end === null ? null : { start, end };
  }
  function show(text = '', range = { start: 0, end: 0, before: committed }) {
    preview = text;
    onPreedit(text, range);
  }
  function replaceDOM(text, caret = text.length) {
    input.textContent = text;
    // Resetting a background input context must not move focus out of help or
    // another control. A focused editing host still receives its native caret.
    if (document.activeElement !== input && !input.contains(document.activeElement)) return;
    const range = document.createRange();
    if (input.firstChild) range.setStart(input.firstChild, Math.max(0, Math.min(caret, text.length)));
    else range.setStart(input, 0);
    range.collapse(true);
    const selected = document.getSelection(); selected.removeAllRanges(); selected.addRange(range);
  }
  function clearDOM() { committed = ''; pending = null; replaceDOM(''); }
  function descriptor(before, after, range, inputType) {
    if (!range) return null;
    const { start, end } = range;
    const length = after.length - before.length + end - start;
    if (start < 0 || end < start || end > before.length || length < 0
      || !after.startsWith(before.slice(0, start)) || !after.endsWith(before.slice(end))) return null;
    return { before, start, end, text: after.slice(start, start + length), after, inputType, ...selection() };
  }
  function accept(edit) {
    if (!edit || edit.before !== committed) {
      replaceDOM(committed); onUnsupported('missingNativeRange'); return false;
    }
    if (edit.after !== edit.before && onEdit(edit) === false) {
      replaceDOM(committed, edit.start); onUnsupported(edit.inputType); return false;
    }
    committed = edit.after;
    return true;
  }
  function finish() {
    const ended = session;
    if (!ended) return;
    session = null; pending = null;
    onCompositionChange(false); show();
    if (!ended.valid) { clearDOM(); onInvalidated(); return; }
    const after = input.textContent;
    if (after === ended.before) return;
    accept(descriptor(ended.before, after, ended.range, 'insertCompositionText'));
  }
  function reset() {
    pending = null; committed = ''; show(); onReset();
    if (session) {
      // Changing the native DOM while IME owns it destroys its replacement range.
      session.valid = false;
    } else clearDOM();
  }
  function command(type) {
    if (session) return false;
    reset(); onCommand(type); return true;
  }
  function addCompositionRange(range, before) {
    if (!session.range) { session.range = range; return; }
    const old = session.range;
    const draftEnd = before.length - (session.before.length - old.end);
    const original = (point, end) => point <= old.start ? point
      : point >= draftEnd ? point + old.end - draftEnd : end ? old.end : old.start;
    session.range = { start: Math.min(old.start, original(range.start, false)), end: Math.max(old.end, original(range.end, true)) };
  }
  input.addEventListener('compositionstart', () => {
    if (session?.ending) finish();
    session = { before: committed, range: null, valid: input.textContent === committed, ending: false };
    pending = null; onCompositionChange(true);
  });
  input.addEventListener('compositionend', event => {
    if (!session) return;
    session.ending = true;
    if (!session.valid) { finish(); return; }
    const edit = descriptor(session.before, input.textContent, session.range, 'insertCompositionText');
    // UI Events allows the final input before or after compositionend. The DOM
    // is authoritative; data only tells us whether that final change is here.
    if (input.textContent === session.before && !event.data) finish();
    else if (edit?.text === event.data) finish();
  });
  input.addEventListener('beforeinput', event => {
    const type = event.inputType;
    if (session?.ending && (isReturn(type) || isCellDelete(type))) finish();
    const before = input.textContent, range = target(event);
    if (!session && (event.isComposing || type === 'insertCompositionText')) {
      // The browser says this is a draft, but we did not observe its start.
      // Never reinterpret an unknown native composition as committed text.
      session = { before: committed, range: null, valid: false, ending: false };
      onCompositionChange(true); onUnsupported('compositionLifecycle');
    }
    if (session) {
      if (!range) session.valid = false;
      else if (session.valid) addCompositionRange(range, before);
      pending = { before, range, inputType: type, composition: true };
      return;
    }
    if (isReturn(type) || (isCellDelete(type) && range && range.start === range.end)) {
      if (event.cancelable) { event.preventDefault(); command(type); }
      else pending = { before, range, inputType: type, command: true };
      return;
    }
    if (!isTextEdit(type) || type === 'insertFromDrop' || !range) {
      if (event.cancelable) event.preventDefault();
      pending = { before, range, inputType: type, rejected: true };
      onUnsupported(!range ? 'missingNativeRange' : type);
      return;
    }
    if (type === 'insertFromPaste' && event.cancelable) {
      event.preventDefault();
      const text = event.dataTransfer?.getData('text/plain') ?? event.data ?? '';
      const after = before.slice(0, range.start) + text + before.slice(range.end);
      replaceDOM(after, range.start + text.length);
      accept(descriptor(before, after, range, type));
      pending = null; return;
    }
    pending = { before, range, inputType: type };
  });
  input.addEventListener('input', event => {
    const transaction = pending; pending = null;
    const after = input.textContent;
    if (session) {
      if (!transaction || !descriptor(transaction.before, after, transaction.range, event.inputType)) session.valid = false;
      if (session.ending) { finish(); return; }
      if (session.valid) {
        const edit = descriptor(session.before, after, session.range, 'insertCompositionText');
        if (edit) show(edit.text, { start: edit.start, end: edit.end, before: edit.before });
        else session.valid = false;
      }
      return;
    }
    if (!transaction) {
      if (after !== committed) { replaceDOM(committed); onUnsupported('missingNativeRange'); }
      return;
    }
    if (transaction.command) { replaceDOM(committed); command(transaction.inputType); return; }
    if (transaction.rejected) { replaceDOM(committed); return; }
    accept(descriptor(transaction.before, after, transaction.range, transaction.inputType));
  });
  for (const type of ['copy', 'cut']) input.addEventListener(type, event => {
    if (session) return;
    event.preventDefault(); onUnsupported('selection');
  });
  return {
    get composing() { return !!session; }, get preedit() { return preview; }, get text() { return committed; },
    cancel: reset, reset, command,
  };
}
