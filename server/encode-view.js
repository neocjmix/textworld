// Cells in incremental views have already been filtered by this participant's
// view and CJK closure. Their immutable projections are shared across observers.
// Only these public records may contribute reusable wire bytes.
import { sections, cellColumns, peerColumns } from '../shared/wire.js';
const encodedRecords = new WeakMap(), compactCells = new WeakMap(), compactPeers = new WeakMap();
const compactWorlds = new WeakMap();
const counters = { records: 0, reused: 0, compactViews: 0 };
export const encodingCounters = () => ({ ...counters });
function encodeRecord(record) {
  if (!Object.isFrozen(record)) return JSON.stringify(record);
  let encoded = encodedRecords.get(record);
  if (encoded === undefined) {
    encoded = JSON.stringify(record);
    encodedRecords.set(record, encoded);
  }
  return encoded;
}

function compactRecord(record, columns, cache) {
  let encoded = Object.isFrozen(record) ? cache.get(record) : undefined;
  if (encoded !== undefined) { counters.reused++; return encoded; }
  encoded = JSON.stringify(columns.map(key => record[key]));
  counters.records++;
  if (Object.isFrozen(record)) cache.set(record, encoded);
  return encoded;
}
const compactCellList = cells => '[' + cells.map(cell => compactRecord(cell, cellColumns, compactCells)).join(',') + ']';
const compactPeerList = peers => '[' + peers.map(peer => compactRecord(peer, peerColumns, compactPeers)).join(',') + ']';
const pointList = points => JSON.stringify(points.map(({ x, y }) => [x, y]));
const markList = marks => JSON.stringify(marks.map(({ x, y, version }) => [x, y, version]));

function compactObservation(o) {
  const values = [];
  let mask = 0;
  for (let i = 0; i < sections.length; i++) {
    const key = sections[i], value = o[key];
    if (!value || !(Array.isArray(value) ? value.length : Object.keys(value).length)) continue;
    mask |= 1 << i;
    values.push(key === 'cells' ? compactCellList(value) : key === 'peers' ? compactPeerList(value)
      : key === 'forget' || key === 'unmark' ? pointList(value) : key === 'marks' ? markList(value) : JSON.stringify(value));
  }
  const { x, y, cols, rows } = o.view;
  return `[${o.revision},${o.partial ? 1 : 0},${o.reset ? 1 : 0},${JSON.stringify([x, y, cols, rows])},${mask}`
    + (values.length ? ',' + values.join(',') : '') + ']';
}

export function encodeCompactView(message) {
  counters.compactViews++;
  const w = message.world;
  let metadata = Object.isFrozen(w) ? compactWorlds.get(w) : undefined;
  if (metadata === undefined) {
    metadata = JSON.stringify([w.width, w.height, w.epoch, w.textLayout]);
    if (Object.isFrozen(w)) compactWorlds.set(w, metadata);
  }
  return '[' + metadata + ',' + compactObservation(message.observation) + ']';
}

export function encodeCompactSnapshot(message) {
  const { type, cells, peers, marks, patch, ...metadata } = message;
  const contents = patch ? 'null,' + compactObservation(patch)
    : compactCellList(cells) + ',' + compactPeerList(peers) + ',' + markList(marks || []);
  return '["tw1","s",' + JSON.stringify(metadata) + ',' + contents + ']';
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
