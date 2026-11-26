// Cells in incremental views have already been filtered by this participant's
// view and CJK closure. Their immutable projections are shared across observers.
// Only these public records may contribute reusable wire bytes.
const encodedRecords = new WeakMap();
function encodeRecord(record) {
  if (!Object.isFrozen(record)) return JSON.stringify(record);
  let encoded = encodedRecords.get(record);
  if (encoded === undefined) {
    encoded = JSON.stringify(record);
    encodedRecords.set(record, encoded);
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
  return fields + ',"observation":' + contents + ',"cells":[' + cells.map(encodeRecord).join(',') + ']}}';
}


// A simultaneous resize sends different rectangles of the same cell and cursor records.
export function encodeSnapshot(message) {
  const { cells, peers, ...metadata } = message;
  return JSON.stringify(metadata).slice(0, -1)
    + ',"cells":[' + cells.map(encodeRecord).join(',') + '],"peers":[' + peers.map(encodeRecord).join(',') + ']}';
}
