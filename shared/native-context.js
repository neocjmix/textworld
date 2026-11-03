const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Bound temporary OS context while retaining complete graphemes around its
 * selection. In particular keep the last syllable available for reconversion.
 */
export function nativeWindow(text, selectionStart = text.length, selectionEnd = selectionStart) {
  if (text.length <= 256) return null;
  let start = Math.max(0, selectionStart - 128);
  let end = Math.min(text.length, Math.max(selectionEnd, start + 256));
  for (const { index, segment } of segmenter.segment(text)) {
    const next = index + segment.length;
    if (index < start && start < next) start = index;
    if (index < end && end < next) end = next;
  }
  return start === 0 && end === text.length ? null : { start, end };
}
