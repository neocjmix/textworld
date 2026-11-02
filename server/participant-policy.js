import { cellKey, cellSpan, graphemes, occupiedCell, wrap, writePlan } from '../shared/world.js';

export const LIMITS = Object.freeze({
  request: { ratePerSecond: 80, burst: 160 },
  write: { ratePerSecond: 12, burst: 64 },
  move: { ratePerSecond: 320, burst: 640 },
  read: { ratePerSecond: 32768, burst: 49152 },
  network: {
    request: { ratePerSecond: 160, burst: 320 },
    write: { ratePerSecond: 24, burst: 128 },
    move: { ratePerSecond: 640, burst: 1280 },
    read: { ratePerSecond: 65536, burst: 98304 },
    create: { ratePerSecond: 1, burst: 8 },
    sessions: 8,
  },
  atomicGraphemes: 64, atomicUtf16: 4096, clearAddresses: 128,
  recentAddresses: 512, recentOrigins: 16,
});
export const limits = LIMITS;

export class PolicyError extends Error {
  constructor(code, message, { status = 400, retryAfterMs = 0 } = {}) {
    super(message); this.name = 'PolicyError';
    this.code = code; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}

/** A time budget shared by every transport, independent of a client's label. */
export class Budget {
  constructor({ rate, capacity, now = Date.now }) {
    if (!(rate > 0) || !(capacity > 0)) throw new TypeError('Budget rate and capacity must be positive.');
    this.rate = rate; this.capacity = capacity; this.now = now;
    this.tokens = capacity; this.updatedAt = now();
  }
  refill() {
    const time = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, time - this.updatedAt) * this.rate / 1000);
    this.updatedAt = Math.max(this.updatedAt, time);
  }
  check(cost = 1) {
    if (!Number.isFinite(cost) || cost < 0) throw new TypeError('Budget cost must be finite and non-negative.');
    if (cost > this.capacity) throw new PolicyError('TOO_LARGE', '한 번의 행동이 허용 범위를 넘었습니다.', { status: 413 });
    this.refill();
    if (cost > this.tokens + 1e-9) {
      throw new PolicyError('RATE_LIMITED', '행동이 너무 빠릅니다. 잠시 기다린 뒤 다시 시도하세요.', {
        status: 429, retryAfterMs: Math.max(1, Math.ceil((cost - this.tokens) * 1000 / this.rate)),
      });
    }
    return true;
  }
  spend(cost = 1) { this.check(cost); this.tokens = Math.max(0, this.tokens - cost); }
  refund(cost) { this.refill(); this.tokens = Math.min(this.capacity, this.tokens + cost); }
}

const budget = (limit, now) => new Budget({ rate: limit.ratePerSecond, capacity: limit.burst, now });
function consumeTogether(budgets, cost) {
  let failure;
  for (const item of budgets.filter(Boolean)) {
    try { item.check(cost); }
    catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      if (!failure || error.retryAfterMs > failure.retryAfterMs) failure = error;
    }
  }
  if (failure) throw failure;
  for (const item of budgets.filter(Boolean)) item.spend(cost);
}

/** Entries survive disconnects; reconnecting does not refill an address's burst. */
export class NetworkBudgets {
  constructor({ now = Date.now, idleMs = 600_000, maxEntries = 10_000 } = {}) {
    this.now = now; this.idleMs = Math.max(600_000, idleMs); this.maxEntries = maxEntries; this.entries = new Map();
  }
  get(key) {
    if (typeof key !== 'string' || !key) throw new TypeError('A resolved network key is required.');
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) this.prune();
      if (this.entries.size >= this.maxEntries) throw new PolicyError('SERVER_BUSY', '새 참여 요청이 많습니다. 잠시 뒤 다시 접속해 주세요.', { status: 503, retryAfterMs: 1000 });
      entry = { key, sessions: 0, touchedAt: this.now() };
      for (const kind of ['request', 'write', 'move', 'read', 'create']) entry[kind] = budget(LIMITS.network[kind], this.now);
      this.entries.set(key, entry);
    }
    entry.touchedAt = this.now();
    return entry;
  }
  acquire(key) {
    const entry = this.get(key);
    if (entry.sessions >= LIMITS.network.sessions) throw new PolicyError('TOO_MANY_SESSIONS', '같은 접속 주소의 동시 참여 수를 넘었습니다.', { status: 429, retryAfterMs: 1000 });
    entry.create.spend(); entry.sessions++;
    return entry;
  }
  release(key) {
    const entry = typeof key === 'string' ? this.entries.get(key) : key;
    if (entry) { entry.sessions = Math.max(0, entry.sessions - 1); entry.touchedAt = this.now(); }
  }
  prune() {
    const cutoff = this.now() - this.idleMs;
    for (const [key, entry] of this.entries) if (entry.sessions === 0 && entry.touchedAt < cutoff) this.entries.delete(key);
  }
}

const forbidden = message => { throw new PolicyError('OUT_OF_REACH', message, { status: 403 }); };
const position = (x, y) => {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new PolicyError('BAD_POSITION', '셀 좌표는 정수여야 합니다.');
};
const samePoint = (a, b) => a.x === b.x && a.y === b.y;
const shortest = (distance, extent) => wrap(distance + extent / 2, extent) - extent / 2;

export class ParticipantPolicy {
  constructor({ world, peer, now = Date.now, network, isVisible = () => true }) {
    if (!world || !peer) throw new TypeError('World and peer are required.');
    this.world = world; this.peer = peer; this.network = network; this.isVisible = isVisible;
    this.request = budget(LIMITS.request, now);
    this.write = budget(LIMITS.write, now);
    this.move = budget(LIMITS.move, now);
    this.read = budget(LIMITS.read, now);
    this.recent = new Map(); this.carets = new Map(); this.origins = new Set([peer.x]);
  }
  acceptRequest() { consumeTogether([this.request, this.network?.request], 1); }
  acceptObservation(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Observation cost must be a non-negative address count.');
    consumeTogether([this.read, this.network?.read], count);
  }
  assertEpoch(epoch) {
    if (epoch !== this.world.epoch) throw new PolicyError('STALE_EPOCH', '세계 크기가 바뀌었습니다. 새 지도를 확인하고 다시 입력하세요.', { status: 409 });
  }
  canonical(x, y) { position(x, y); return { x: wrap(x, this.world.width), y: wrap(y, this.world.height) }; }
  visible(point) { if (!this.isVisible(point.x, point.y)) forbidden('현재 보이는 범위에서만 글을 바꿀 수 있습니다.'); }
  rememberOrigin(x) {
    this.origins.delete(x); this.origins.add(x);
    while (this.origins.size > LIMITS.recentOrigins) this.origins.delete(this.origins.values().next().value);
  }
  prior(id) {
    if (typeof id !== 'string' || !id || id.length > 100) throw new PolicyError('BAD_ID', '입력 식별자가 필요합니다.');
    return this.world.prior(this.peer.id, id);
  }
  acceptMove({ x, y, epoch, intent }) {
    this.assertEpoch(epoch);
    const point = this.canonical(x, y);
    if (intent !== undefined && intent !== 'native-caret') throw new PolicyError('BAD_MOVE', '알 수 없는 이동 의도입니다.');
    if (intent === 'native-caret') {
      if (!samePoint(point, this.peer) && !this.carets.has(cellKey(point.x, point.y))) {
        forbidden('네이티브 커서는 알려진 입력 경계로만 이동할 수 있습니다.');
      }
    }
    const distance = Math.hypot(shortest(point.x - this.peer.x, this.world.width), shortest(point.y - this.peer.y, this.world.height));
    // A GPS/shared-address relocation may span a large world, but spends an
    // entire burst. Repeating such relocations cannot create a free scan path.
    const cost = Math.min(distance, LIMITS.move.burst);
    consumeTogether([this.move, this.network?.move], cost);
    this.peer.x = point.x; this.peer.y = point.y;
    if (intent !== 'native-caret') {
      this.recent.clear(); this.carets.clear(); this.rememberOrigin(point.x);
    }
    return { cursor: { ...point }, cost };
  }
  acceptWrite(message) {
    const prior = this.prior(message.id);
    if (prior) return prior;
    this.assertEpoch(message.epoch);
    if (message.layout !== 2) throw new PolicyError('CLIENT_UPDATE_REQUIRED', '입력 방식이 업데이트되었습니다. 페이지를 새로고침해 주세요.', { status: 409 });
    const origin = this.canonical(message.x, message.y), { text } = message;
    if (typeof text !== 'string') throw new PolicyError('BAD_TEXT', '입력 내용은 문자열이어야 합니다.');
    if (text.length > LIMITS.atomicUtf16) throw new PolicyError('TOO_LARGE', '한 번의 입력 원문은 4096 UTF-16 단위까지 허용됩니다.', { status: 413 });
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) throw new PolicyError('BAD_TEXT', '제어 문자는 입력할 수 없습니다.');
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    const count = graphemes(normalized).length;
    if (count > LIMITS.atomicGraphemes) throw new PolicyError('TOO_LARGE', '한 번에 64자까지 확정할 수 있습니다. 큰 입력은 나누어 보내세요.', { status: 413 });
    const clear = message.clear === undefined ? [] : message.clear;
    if (!Array.isArray(clear)) throw new PolicyError('BAD_CLEAR', '삭제 주소는 배열이어야 합니다.');
    if (clear.length > LIMITS.clearAddresses) throw new PolicyError('TOO_LARGE', '한 번에 지울 주소 범위를 넘었습니다.', { status: 413 });
    if (!count && !clear.length) throw new PolicyError('EMPTY_EDIT', '변경할 글자가 없습니다.', { status: 422 });
    if (!samePoint(origin, this.peer) && !this.recent.has(cellKey(origin.x, origin.y))) forbidden('현재 커서 또는 최근 입력 문맥에서만 쓸 수 있습니다.');
    let lineStartX = origin.x;
    if (message.lineStartX !== undefined) {
      position(message.lineStartX, origin.y); lineStartX = wrap(message.lineStartX, this.world.width);
      if (lineStartX !== this.peer.x && !this.origins.has(lineStartX)) forbidden('알려진 글쓰기 시작 열을 사용해야 합니다.');
    }
    const plan = writePlan(text, origin.x, origin.y, this.world, { lineStartX });
    const removed = new Set();
    for (const address of clear) {
      if (!address || typeof address !== 'object' || Array.isArray(address)) throw new PolicyError('BAD_CLEAR', '잘못된 삭제 주소입니다.');
      position(address.x, address.y);
      if (address.x < 0 || address.y < 0 || address.x >= this.world.width || address.y >= this.world.height) throw new PolicyError('BAD_CLEAR', '삭제 주소는 현재 세계 안에 있어야 합니다.');
      if (!this.recent.has(cellKey(address.x, address.y))) forbidden('직접 입력한 최근 문맥의 범위만 치환할 수 있습니다.');
      const span = cellSpan((x, y) => this.world.getCell(x, y), address.x, address.y, this.world);
      const head = span.find(cell => cell.width === 2) || span[0] || address;
      removed.add(cellKey(head.x, head.y));
    }
    if (removed.size > LIMITS.atomicGraphemes) throw new PolicyError('TOO_LARGE', '한 번에 64개 글자까지 치환할 수 있습니다.', { status: 413 });
    // A native IME commit can finish beyond the current screen. Its bounded
    // sequential typing path is derived by the server, not supplied as an
    // arbitrary address list. Following that path does not reveal intermediate
    // views. Explicit replacement addresses must belong to the bounded recent
    // input context, which the native editor may retain beyond the screen edge.
    const cost = Math.max(count, removed.size, 1);
    consumeTogether([this.write, this.network?.write], cost);
    let result;
    try { result = this.world.applyWrite({ author: this.peer.id, id: message.id, epoch: message.epoch,
      ...origin, text, clear, lineStartX }); }
    catch (error) { this.write.refund(cost); this.network?.write.refund(cost); throw error; }
    this.peer.x = result.cursor.x; this.peer.y = result.cursor.y;
    this.rememberOrigin(lineStartX);
    // Native selection may place its caret at an unchanged suffix, rather
    // than the end of the replacement. Retain bounded, server-known edges
    // separately from addresses authorized for range replacement.
    for (const point of [origin, plan.cursor, ...plan.steps.flatMap(step => [step.from, step.to])]) {
      const key = cellKey(point.x, point.y);
      this.carets.delete(key); this.carets.set(key, { x: point.x, y: point.y });
    }
    while (this.carets.size > LIMITS.recentAddresses) this.carets.delete(this.carets.keys().next().value);
    for (const cell of result.cells) {
      const key = cellKey(cell.x, cell.y);
      this.recent.delete(key);
      if (occupiedCell(cell)) this.recent.set(key, { x: cell.x, y: cell.y });
    }
    while (this.recent.size > LIMITS.recentAddresses) this.recent.delete(this.recent.keys().next().value);
    return result;
  }
  acceptErase(message) {
    const prior = this.prior(message.id);
    if (prior) return prior;
    this.assertEpoch(message.epoch);
    if (message.layout !== 2) throw new PolicyError('CLIENT_UPDATE_REQUIRED', '페이지를 새로고침해 주세요.', { status: 409 });
    const point = this.canonical(message.x, message.y);
    let allowed = samePoint(point, this.peer);
    if (!allowed && message.intent === 'backspace') {
      const previous = { x: wrap(this.peer.x - 1, this.world.width), y: this.peer.y };
      const cell = this.world.getCell(previous.x, previous.y);
      if (cell?.width === 0) previous.x = cell.leadX;
      allowed = samePoint(point, previous);
    }
    if (!allowed) forbidden('현재 칸 또는 바로 앞 글자만 지울 수 있습니다.');
    const span = cellSpan((x, y) => this.world.getCell(x, y), point.x, point.y, this.world);
    for (const cell of span.length ? span : [point]) this.visible(cell);
    consumeTogether([this.write, this.network?.write], 1);
    let result;
    try { result = this.world.erase({ author: this.peer.id, id: message.id, epoch: message.epoch, ...point }); }
    catch (error) { this.write.refund(1); this.network?.write.refund(1); throw error; }
    this.peer.x = point.x; this.peer.y = point.y;
    for (const cell of result.cells) this.recent.delete(cellKey(cell.x, cell.y));
    return result;
  }
}
