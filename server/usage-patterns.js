// Small, fixed vocabulary shared by the collector and its offline report.
// Each connected actor holds only times and flags. No action history is kept.
export const SOURCES = ['public_ws', 'agent_api', 'playtest'];
export const ACTIONS = ['write', 'erase', 'move'];
export const MODES = ['observing', 'moving', 'editing'];
export const ROLES = ['observer', 'mover', 'editor', 'writer'];
export const USAGE_SAMPLE = 'usage.v1_sample';
export const usageMetrics = new Set([USAGE_SAMPLE, ...SOURCES.flatMap(source => {
  const suffixes = [
    'opened', 'short_stay', 'first_write_ms', 'visible_others', 'shared_view', 'view_cells', 'write_graphemes',
    'join_full', 'join_limited',
    ...ROLES.map(role => 'stay.' + role + '_ms'),
    ...MODES.map(mode => 'time.' + mode + '_ms'),
    ...ACTIONS.flatMap(action => [action + '.ok', action + '.gap_ms']),
    ...[...ACTIONS, 'other'].flatMap(action => [action + '.busy', action + '.limited']),
  ];
  return suffixes.map(key => 'usage.' + source + '.' + key);
})]);

export function writeKind(text, hasClear = false) {
  if (typeof text !== 'string' || text.length > 4096) return 'other';
  if (/[^\r\n]/u.test(text)) return 'write';
  return hasClear || !text ? 'erase' : 'move';
}

// Only used if request throttling fires before a server plan exists.
function requestedKind(message) {
  if (message?.type === 'write') return writeKind(message.text, message.clear?.length > 0);
  if (message?.type === 'move' || message?.type === 'erase') return message.type;
  if (message?.type !== 'input') return 'other';
  const action = message.action;
  switch (action?.kind) {
    case 'type': return writeKind(action.text);
    case 'native': {
      const edit = action.edit;
      if (edit?.text === '' && Number.isSafeInteger(edit.start) && edit.start === edit.end) return 'move';
      return writeKind(edit?.text);
    }
    case 'backspace': case 'delete': return 'erase';
    case 'move': case 'goto': case 'home': return 'move';
    default: return 'other';
  }
}

export class UsageSession {
  constructor(measurements, source, now = () => performance.now()) {
    this.measurements = measurements;
    this.prefix = 'usage.' + source + '.';
    this.now = now;
    this.started = this.intervalStart = now();
    this.mode = 'observing';
    this.role = 'observer';
    this.firstWriteMs = null;
    this.lastAction = {};
    this.record('opened');
  }

  record(suffix, value = 1) {
    this.measurements.record(this.prefix + suffix, value);
  }

  accepted(kind, graphemes = 0, hasInk = false) {
    const at = this.now();
    this.record(kind + '.ok');
    if (this.lastAction[kind] !== undefined) this.record(kind + '.gap_ms', at - this.lastAction[kind]);
    this.lastAction[kind] = at;
    if (kind === 'move') {
      if (this.mode === 'observing') this.mode = 'moving';
      if (this.role === 'observer') this.role = 'mover';
      return;
    }
    this.mode = 'editing';
    if (this.role !== 'writer') this.role = 'editor';
    if (kind === 'write') this.record('write_graphemes', graphemes);
    if (hasInk && this.firstWriteMs === null) {
      this.firstWriteMs = at - this.started;
      this.role = 'writer';
    }
  }

  denied(kind, error, request) {
    if (error.status === 429) this.record((kind ?? requestedKind(request)) +
      (error.code === 'WORLD_BUSY' ? '.busy' : '.limited'));
  }

  // Sample a cached observation in O(1), including the final short interval.
  sample(lastView, closing = false) {
    const at = this.now();
    this.record('time.' + this.mode + '_ms', at - this.intervalStart);
    if (lastView) {
      const others = Math.max(0, lastView.peers.size - 1);
      this.record('visible_others', others);
      if (others) this.record('shared_view');
      this.record('view_cells', lastView.view.cols * lastView.view.rows);
    }
    this.intervalStart = at;
    this.mode = 'observing';
    if (closing) {
      this.record('stay.' + this.role + '_ms', at - this.started);
      if (at - this.started < 60000) this.record('short_stay');
      if (this.firstWriteMs !== null) this.record('first_write_ms', this.firstWriteMs);
    }
  }
}
