// Versioned, stateless wire representation. No observations, intermediate
// overwrites, peer moves or per-client sequence numbers are discarded.
export const WIRE_VERSION = 1;
export const sections = ['cells', 'forget', 'marks', 'unmark', 'freshness', 'colors', 'forgetVersions', 'peers', 'departed'];
export const cellColumns = ['x', 'y', 'text', 'width', 'leadX', 'version'];
export const peerColumns = ['id', 'name', 'color', 'x', 'y'];
const points = rows => rows.map(([x, y]) => ({ x, y }));
const marks = rows => rows.map(([x, y, version]) => ({ x, y, version }));
const cells = rows => rows.map(([x, y, text, width, leadX, version]) => ({ x, y, text, width, leadX, version }));
const peers = rows => rows.map(([id, name, color, x, y]) => ({ id, name, color, x, y }));

function observation(row) {
  const [revision, partial, reset, rectangle, mask] = row;
  const [x, y, cols, rows] = rectangle;
  const out = { revision, view: { x, y, cols, rows }, cells: [], forget: [], marks: [], freshness: {}, colors: {}, peers: [] };
  if (partial) Object.assign(out, { partial: true, unmark: [], forgetVersions: [], departed: [] });
  else out.reset = !!reset;
  let index = 5;
  for (let i = 0; i < sections.length; i++) {
    if (!(mask & (1 << i))) continue;
    const value = row[index++], key = sections[i];
    out[key] = key === 'cells' ? cells(value) : key === 'peers' ? peers(value)
      : key === 'forget' || key === 'unmark' ? points(value) : key === 'marks' ? marks(value) : value;
  }
  return out;
}
function view(row) {
  const [width, height, epoch, textLayout] = row[0];
  return { type: 'view', world: { width, height, epoch, textLayout }, observation: observation(row[1]) };
}

export function decodeWire(value) {
  if (!Array.isArray(value) || value[0] !== 'tw1') return value;
  if (value[1] === 'b') return { type: 'batch', messages: value[2].map(view) };
  if (value[1] === 'v') return view(value[2]);
  if (value[1] === 's') {
    const out = { ...value[2], type: 'snapshot' };
    if (value[3] !== null) Object.assign(out, { cells: cells(value[3]), peers: peers(value[4]), marks: marks(value[5]) });
    else out.patch = observation(value[4]);
    return out;
  }
  throw new Error('Unsupported Textworld wire envelope');
}
