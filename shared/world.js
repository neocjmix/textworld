/** Cell addresses are integer coordinates in the current topology epoch. */
export const wrap = (n, size) => ((n % size) + size) % size;
export const cellKey = (x, y) => `${x},${y}`;
const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
export const graphemes = text => [...segmenter.segment(text.normalize('NFC'))].map(part => part.segment);

/** Equal-area cylindrical projection; precise coordinates stay in the browser. */
export function gpsToCell(latitude, longitude, { width, height }) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('유효하지 않은 지리 좌표입니다.');
  }
  const u = wrap(longitude + 180, 360) / 360;
  const v = (1 - Math.sin(latitude * Math.PI / 180)) / 2;
  return { x: Math.min(width - 1, Math.floor(u * width)), y: Math.min(height - 1, Math.floor(v * height)) };
}

export function writePlan(text, x, y, world, { lineStartX = x } = {}) {
  const cells = new Map();
  const steps = [];
  // The writing origin survives input-event boundaries; the first glyph still
  // belongs to the current cursor, and only a newline returns to this column.
  const originX = wrap(lineStartX, world.width);
  x = wrap(x, world.width);
  y = wrap(y, world.height);
  for (const char of graphemes(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    '))) {
    const from = { x, y };
    if (char === '\n') {
      x = originX;
      y = wrap(y + 1, world.height);
      steps.push({ kind: 'return', from, to: { x, y } });
      continue;
    }
    cells.set(cellKey(x, y), { x, y, text: char });
    x = wrap(x + 1, world.width);
    steps.push({ kind: 'write', from, to: { x, y } });
  }
  return { cells: [...cells.values()], cursor: { x, y }, steps };
}
