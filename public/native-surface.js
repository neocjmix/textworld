/**
 * Paint the live composition with the browser's existing editing host.
 * Only geometry and clipping change: no mirrored text, rewritten DOM, native
 * selection changes, or per-character renderer participates in a draft.
 */
export function createNativeSurface(host) {
  const measure = document.createElement('canvas').getContext('2d');
  let measuredFont = '', fontAscent = 0;

  function rangeAt(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
    const range = document.createRange();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node, offset = 0, foundStart = false;
    while ((node = walker.nextNode())) {
      const limit = offset + node.length;
      if (!foundStart && start <= limit) { range.setStart(node, start - offset); foundStart = true; }
      if (foundStart && end <= limit) { range.setEnd(node, end - offset); return range; }
      offset = limit;
    }
    return null;
  }

  function hide() {
    delete host.dataset.nativePreview;
    host.style.removeProperty('opacity');
    host.style.removeProperty('clip-path');
    host.style.removeProperty('transform');
  }

  function show({ start, end, x, y, cellHeight, fontSize }) {
    const range = rangeAt(start, end);
    if (!range || ![x, y, cellHeight, fontSize].every(Number.isFinite)) { hide(); return false; }
    host.dataset.nativePreview = '';
    host.style.fontSize = `${fontSize}px`;
    host.style.lineHeight = `${cellHeight}px`;
    const rectangles = [...range.getClientRects()], first = rectangles[0], box = host.getBoundingClientRect();
    if (!first || !rectangles.some(rect => rect.width && rect.height)) { hide(); return false; }
    const style = getComputedStyle(host), font = `${fontSize}px ${style.fontFamily}`;
    if (font !== measuredFont) {
      measure.font = font; measure.textBaseline = 'middle';
      fontAscent = measure.measureText('한').fontBoundingBoxAscent;
      measuredFont = font;
    }
    const left = first.left - box.left, top = first.top - box.top;
    // Match canvas fillText(..., cellTop + cellHeight / 2 + 1) at a middle
    // baseline. Native Range bounds describe the font box, not the line box.
    const targetTop = y + cellHeight / 2 + 1 - fontAscent;
    host.style.transform = `translate(${x - left}px, ${targetTop - top}px)`;
    // A multiline range's bounding box also encloses unrelated prefix/suffix
    // text. Clip its individual rectangles instead of exposing that text.
    const path = rectangles.filter(rect => rect.width && rect.height).map(rect => {
      const l = rect.left - box.left, t = rect.top - box.top;
      return `M ${l} ${t} h ${rect.width} v ${rect.height} h ${-rect.width} Z`;
    }).join(' ');
    host.style.clipPath = `path('${path}')`;
    host.style.opacity = '1';
    return true;
  }

  hide();
  return { show, hide };
}
