// Cells in incremental views have already been filtered by this participant's
// view and CJK closure. Their immutable projections are shared across observers.
// Only these public records may contribute reusable wire bytes.
const encodedCells = new WeakMap();
function encodeCell(cell) {
  if (!Object.isFrozen(cell)) return JSON.stringify(cell);
  let encoded = encodedCells.get(cell);
  if (encoded === undefined) {
    encoded = JSON.stringify(cell);
    encodedCells.set(cell, encoded);
  }
  return encoded;
}

export function encodeView(message) {
  if (!message.observation?.partial || !message.observation.cells.length) return JSON.stringify(message);
  const { observation, ...envelope } = message;
  const { cells, ...metadata } = observation;
  // Encode keys, text, peer names and every other value with JSON.stringify.
  // Only the fixed structural punctuation is assembled here.
  const fields = JSON.stringify(envelope).slice(0, -1);
  const contents = JSON.stringify(metadata).slice(0, -1);
  return fields + ',"observation":' + contents + ',"cells":[' + cells.map(encodeCell).join(',') + ']}}';
}
