import {
  UNICODE_WIDTH_VERSION, wideRanges, combiningRanges, emojiPresentationRanges,
  extendedPictographicRanges, emojiVariationRanges,
} from './unicode-width-data.js';

export { UNICODE_WIDTH_VERSION };

function includes(ranges, point) {
  let low = 0, high = ranges.length / 2 - 1;
  while (low <= high) {
    const index = (low + high) >>> 1, start = ranges[index * 2], end = ranges[index * 2 + 1];
    if (point < start) high = index - 1;
    else if (point > end) low = index + 1;
    else return true;
  }
  return false;
}

/**
 * Display columns for one already-segmented grapheme, using Unicode 17 data.
 * W/F and emoji presentation use two columns; ambiguous characters use one.
 * Combining marks/joiners do not add columns to their base. An isolated mark
 * still receives one addressable column rather than silently disappearing.
 * This is a layout rule, independent of font measurement and UTF-8 byte count.
 */
export function graphemeWidth(text) {
  const points = [...text.normalize('NFC')].map(char => char.codePointAt(0));
  // Keycaps have a standardized optional VS16; arbitrary "A + VS16" does not.
  if (/^[#*0-9]\uFE0F?\u20E3$/u.test(text)) return 2;
  if (points.length === 2 && points.every(point => point >= 0x1f1e6 && point <= 0x1f1ff)) return 2;
  let pictographs = 0, joined = false, wide = false;
  for (let index = 0; index < points.length; index++) {
    const point = points[index], following = points[index + 1];
    if (point === 0x200d) joined = true;
    if (includes(extendedPictographicRanges, point)) pictographs++;
    if (following === 0xfe0f && includes(emojiVariationRanges, point)) return 2;
    // VS15 suppresses emoji presentation for its base, but does not override
    // that base's independent East Asian W/F classification.
    if (following !== 0xfe0e && includes(emojiPresentationRanges, point)) return 2;
    if (!includes(combiningRanges, point) && includes(wideRanges, point)) wide = true;
  }
  // Extended-pictographic ZWJ clusters keep one two-column allocation even
  // when the platform has no ligature for a newer or non-RGI sequence.
  return wide || (joined && pictographs >= 2) ? 2 : 1;
}
