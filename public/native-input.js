const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const segments = text => [...segmenter.segment(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').normalize('NFC'))].map(part => part.segment);
const isReturn = type => type === 'insertLineBreak' || type === 'insertParagraph';
const isDelete = type => type === 'deleteContentBackward' || type === 'deleteContentForward';
const isComposition = event => event.isComposing || ['insertCompositionText', 'insertFromComposition'].includes(event.inputType);
const isInsertion = type => !type || ['insertText', 'insertFromPaste', 'insertCompositionText', 'insertFromComposition'].includes(type);

/** Keep the OS-owned text/range intact. The world receives only committed tail edits. */
export function createNativeInput(input, {
  onEdit, onPreedit = () => {}, onCommand = () => {}, onUnsupported = () => {},
  onCompositionChange = () => {}, onInvalidated = () => {},
}) {
  let baseline = input.value, session = null, cancelled = false, confirmingEnter = false, ended = null;
  let preview = '', previewRemove = 0;

  function show(text = '', remove = 0) {
    preview = text; previewRemove = remove;
    onPreedit(text, { remove });
  }
  function restore() {
    input.value = baseline;
    input.setSelectionRange(baseline.length, baseline.length);
  }
  function tailEdit(next) {
    const before = segments(baseline), after = segments(next);
    let common = 0;
    while (common < before.length && common < after.length && before[common] === after[common]) common++;
    // A retained suffix implies insertion/replacement inside a string. Spatial
    // cells must never be shifted to imitate such a native document edit.
    if (common < before.length && common < after.length && before.at(-1) === after.at(-1)) return null;
    return { remove: before.length - common, text: after.slice(common).join('') };
  }
  function accept(next) {
    const edit = tailEdit(next);
    if (!edit) { restore(); onUnsupported('insertReplacementText'); return; }
    if (!edit.remove && !edit.text) { baseline = next; return; }
    if (onEdit(edit) === false) { restore(); onUnsupported('insertReplacementText'); return; }
    baseline = next;
  }
  function begin(implicit = false) {
    if (session) return;
    ended = null;
    confirmingEnter = false;
    cancelled = false;
    session = { before: baseline, start: input.selectionStart, end: input.selectionEnd, implicit, valid: true };
    onCompositionChange(true);
  }
  function update(text) {
    if (!session?.valid) return;
    if (session.implicit) {
      let index = 0;
      while (index < baseline.length && index < input.value.length && baseline[index] === input.value[index]) index++;
      session.start = index; session.end = baseline.length;
    }
    const remove = segments(session.before.slice(session.start, session.end)).length;
    show(text ?? input.value.slice(session.start, input.selectionEnd), remove);
  }
  function clearBuffer() {
    baseline = ''; input.value = ''; input.setSelectionRange(0, 0);
  }
  function reset() {
    const hadComposition = !!session;
    cancelled ||= hadComposition;
    session = null; confirmingEnter = false; ended = null; clearBuffer(); show();
    if (hadComposition) onCompositionChange(false);
  }
  function cancel() {
    if (session) {
      session.valid = false;
      cancelled = true; show();
      // Do not blur/refocus here: that can reopen the mobile keyboard and cause
      // synchronous compositionend. Discard the late end at its original boundary.
      clearBuffer();
    } else clearBuffer();
  }
  function command(type) {
    if (session) return false;
    if (isReturn(type) && confirmingEnter) { confirmingEnter = false; return true; }
    reset();
    onCommand(type);
    return true;
  }

  input.addEventListener('compositionstart', () => {
    // A new composition is a fresh native range, even after cancelling navigation.
    if (session) { session = null; onCompositionChange(false); }
    begin();
  });
  input.addEventListener('compositionupdate', event => {
    if (!session && !cancelled) begin(true);
    update(event.data);
  });
  input.addEventListener('compositionend', event => {
    const finished = session;
    session = null;
    onCompositionChange(false); show();
    if (cancelled || (finished && !finished.valid)) {
      cancelled = true; clearBuffer(); onInvalidated(); return;
    }
    if (!finished) {
      // Some engines emit an end without a start. A prior input may already
      // have accepted the same value, in which case this is an exact no-op.
      accept(input.value); return;
    }
    const next = finished.before.slice(0, finished.start) + (event.data ?? '') + finished.before.slice(finished.end);
    accept(next);
    ended = { text: event.data, value: next };
    // Never clear or rewrite .value here. Native IME may still own its range,
    // or deliver the final input in a later task. Comparing to baseline dedupes it.
  });
  input.addEventListener('beforeinput', event => {
    if (isComposition(event)) {
      if (!session && ended && event.data === ended.text && input.value === ended.value) return;
      if (!session && !cancelled && event.inputType !== 'insertFromComposition') begin(true);
      return;
    }
    if (session) return;
    if (isReturn(event.inputType) || isDelete(event.inputType)) {
      if (event.cancelable) { event.preventDefault(); command(event.inputType); }
    } else if (!isInsertion(event.inputType)) {
      if (event.cancelable) { event.preventDefault(); onUnsupported(event.inputType); }
    } else {
      // A normal native insertion starts a new input after an explicitly
      // cancelled range; stale composition-specific events remain suppressed.
      cancelled = false;
      confirmingEnter = false;
    }
  });
  input.addEventListener('input', event => {
    // Chromium normalizes some IME inputType values (including synthetic
    // insertFromComposition) to ''. A cancelled range stays blocked until a
    // fresh beforeinput/keydown/compositionstart proves a new user intention.
    if (cancelled) { clearBuffer(); return; }
    if (!session && isComposition(event) && input.value === baseline) return;
    if (!session && isComposition(event) && event.inputType !== 'insertFromComposition') begin(true);
    if (session) {
      if (session.implicit && !event.isComposing && ['insertText', 'insertFromComposition'].includes(event.inputType)) {
        const valid = session.valid;
        session = null; onCompositionChange(false); show();
        if (valid) accept(input.value);
        return;
      }
      if (session.valid) update(event.data);
      return;
    }
    if (isReturn(event.inputType) || isDelete(event.inputType)) {
      command(event.inputType); return;
    }
    if (!isInsertion(event.inputType)) { restore(); onUnsupported(event.inputType); return; }
    if (input.selectionEnd !== input.value.length || input.selectionStart !== input.selectionEnd) {
      restore(); onUnsupported('selection'); return;
    }
    accept(input.value);
  });
  input.addEventListener('paste', event => {
    if (session) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    reset();
    if (text) onEdit({ remove: 0, text });
  });
  for (const type of ['copy', 'cut']) input.addEventListener(type, event => {
    if (session) return;
    event.preventDefault(); onUnsupported('selection');
  });

  return {
    get composing() { return !!session; },
    get preedit() { return preview; },
    get preeditRemove() { return previewRemove; },
    handleKeydown(event) {
      if (session || event.isComposing || event.keyCode === 229) {
        if (event.key === 'Enter') confirmingEnter = true;
        return true;
      }
      confirmingEnter = false;
      if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || event.key === 'Process')) cancelled = false;
      return false;
    },
    command, cancel, reset,
  };
}
