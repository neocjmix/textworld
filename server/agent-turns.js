import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { graphemes, wrap } from '../shared/world.js';
import { WritingSession } from '../shared/writing.js';
import { PolicyError } from './participant-policy.js';

export const TURN_LIMITS = Object.freeze({
  actions: 16, graphemes: 256, utf16: 4096, durationMs: 30_000,
  typingPerSecond: 10, movementPerSecond: 160, movementStep: 8,
  recentResults: 16, lifetimeTurns: 1024,
});

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

const bad = message => { throw new PolicyError('BAD_TURN', message); };
const tooLarge = message => { throw new PolicyError('TOO_LARGE', message, { status: 413 }); };
const point = peer => ({ x: peer.x, y: peer.y });
const clone = value => structuredClone(value);
const errorRecord = error => ({ code: error.code || 'TURN_FAILED', message: error.message || '행동을 완료하지 못했습니다.',
  status: error.status || (error.code === 'STALE_EPOCH' ? 409 : 500), ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) });
const fields = (action, allowed) => {
  if (Object.keys(action).some(key => !allowed.includes(key))) bad('지원하지 않는 행동 필드가 있습니다.');
};

function moveSteps(dx, dy) {
  const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / TURN_LIMITS.movementStep));
  let x = 0, y = 0;
  return Array.from({ length: count }, (_, index) => {
    const nextX = Math.round(dx * (index + 1) / count), nextY = Math.round(dy * (index + 1) / count);
    const step = { kind: 'move', dx: nextX - x, dy: nextY - y };
    step.durationMs = Math.max(1, Math.hypot(step.dx, step.dy) * 1000 / TURN_LIMITS.movementPerSecond);
    x = nextX; y = nextY;
    return step;
  });
}

/** Validate the complete batch before making any world or cursor change. */
function prepare(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) bad('행동 요청은 객체여야 합니다.');
  if (typeof request.id !== 'string' || !request.id || request.id.length > 64) bad('1~64자 요청 id가 필요합니다.');
  if (!Array.isArray(request.actions) || !request.actions.length) bad('관측만 하는 빈 행동 요청은 HTTP 관측 경로를 사용하세요.');
  if (request.actions.length > TURN_LIMITS.actions) tooLarge('한 요청에는 16개 행동까지 보낼 수 있습니다.');
  let totalGraphemes = 0, totalUtf16 = 0, durationMs = 0;
  const actions = request.actions.map(action => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) bad('행동은 객체여야 합니다.');
    let normalized, steps;
    switch (action.type) {
      case 'type': {
        fields(action, ['type', 'text']);
        if (typeof action.text !== 'string' || !action.text.length) bad('type에는 비어 있지 않은 text가 필요합니다.');
        totalUtf16 += action.text.length;
        if (totalUtf16 > TURN_LIMITS.utf16) tooLarge('한 요청의 원문은 4096 UTF-16 단위까지 허용됩니다.');
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(action.text)) bad('제어 문자는 입력할 수 없습니다.');
        const text = action.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').normalize('NFC');
        const chars = graphemes(text);
        totalGraphemes += chars.length;
        if (totalGraphemes > TURN_LIMITS.graphemes) tooLarge('한 요청은 256개 표시 문자까지 예약할 수 있습니다.');
        normalized = { type: 'type', text };
        steps = chars.map(text => ({ kind: 'type', text, durationMs: 1000 / TURN_LIMITS.typingPerSecond }));
        break;
      }
      case 'move': {
        fields(action, ['type', 'dx', 'dy']);
        if (!Number.isSafeInteger(action.dx) || !Number.isSafeInteger(action.dy)) bad('move의 dx, dy는 정수여야 합니다.');
        if (Math.hypot(action.dx, action.dy) > TURN_LIMITS.durationMs * TURN_LIMITS.movementPerSecond / 1000) tooLarge('이동 예약이 30초를 넘습니다.');
        normalized = { type: 'move', dx: action.dx, dy: action.dy };
        steps = moveSteps(action.dx, action.dy);
        break;
      }
      case 'wait':
        fields(action, ['type', 'ms']);
        if (!Number.isSafeInteger(action.ms) || action.ms < 0) bad('wait의 ms는 0 이상의 정수여야 합니다.');
        if (action.ms > TURN_LIMITS.durationMs) tooLarge('대기는 30초까지 허용됩니다.');
        normalized = { type: 'wait', ms: action.ms };
        steps = [{ kind: 'wait', durationMs: action.ms }];
        break;
      case 'enter': case 'backspace': case 'delete': case 'home':
        fields(action, ['type']);
        normalized = { type: action.type };
        steps = [{ kind: action.type, durationMs: 1000 / TURN_LIMITS.typingPerSecond }];
        break;
      default: bad('지원하는 행동은 type, move, enter, backspace, delete, home, wait입니다.');
    }
    durationMs += steps.reduce((sum, step) => sum + step.durationMs, 0);
    if (durationMs > TURN_LIMITS.durationMs) tooLarge('한 번에 30초까지 행동을 예약할 수 있습니다.');
    return { normalized, steps };
  });
  const fingerprint = createHash('sha256').update(JSON.stringify(actions.map(action => action.normalized))).digest('hex');
  return { id: request.id, fingerprint, actions };
}

/**
 * Transport batching does not batch world effects. Each step uses the same
 * participant policy as the browser, and publishes its ordinary local change.
 * publish(result, actor) includes the resulting presence notification; presence
 * is called separately only for navigation without a world mutation.
 * Results contain progress only; the HTTP layer reads the final current view.
 */
export function createTurnRunner({ world, publish = () => {}, presence = () => {},
  now = () => performance.now(), delay = abortableDelay } = {}) {
  if (!world) throw new TypeError('A world is required.');
  const states = new WeakMap(), running = new Set();
  let stopped = false;
  const stateFor = actor => {
    let state = states.get(actor);
    if (!state) { state = { seen: new Map(), results: new Map(), active: null, readyAt: now() }; states.set(actor, state); }
    actor.writing ||= new WritingSession(actor.peer);
    return state;
  };
  const summary = (actor, active, status = active.status) => ({ id: active.id, status,
    completedActions: active.completedActions, completedSteps: active.completedSteps,
    cursor: point(actor.peer), epoch: world.epoch, elapsedMs: Math.max(0, Math.round(now() - active.startedAt)),
    ...(active.error ? { error: active.error } : {}) });
  const check = (actor, active) => {
    if (actor.closed || stopped || active.controller.signal.aborted) {
      throw new PolicyError('CANCELLED', '남은 행동을 취소했습니다.', { status: 409 });
    }
  };
  const pause = async (actor, active, deadline) => {
    check(actor, active);
    while (deadline > now()) {
      await delay(deadline - now(), active.controller.signal);
      check(actor, active);
    }
    check(actor, active);
  };
  const mutationId = (active, ordinal) => `${active.id}:${ordinal}`;
  const step = (actor, active, operation) => {
    const { peer, policy, writing } = actor;
    const common = { id: mutationId(active, active.completedSteps), epoch: world.epoch, layout: 2 };
    if (operation.kind === 'type' || operation.kind === 'enter') {
      const text = operation.kind === 'enter' ? '\n' : operation.text;
      const plan = writing.plan(text, peer, world);
      const result = policy.acceptWrite({ ...common, ...point(peer), text, lineStartX: writing.lineStartX });
      writing.accept(plan);
      return result;
    } else if (operation.kind === 'move') {
      policy.acceptMove({ epoch: world.epoch, x: wrap(peer.x + operation.dx, world.width), y: wrap(peer.y + operation.dy, world.height) });
      writing.reset(peer);
    } else if (operation.kind === 'home') {
      policy.acceptMove({ epoch: world.epoch, x: writing.lineStartX, y: peer.y });
      writing.reposition(peer);
    } else if (operation.kind === 'backspace') {
      const saved = { lineStartX: writing.lineStartX, active: writing.active, trail: [...writing.trail] };
      try {
        const action = writing.backspace(peer, world, world.cells);
        if (action.erase) return policy.acceptErase({ ...common, ...action.cursor, intent: 'backspace' });
        else policy.acceptMove({ epoch: world.epoch, ...action.cursor });
      } catch (error) { Object.assign(writing, saved); throw error; }
    } else if (operation.kind === 'delete') {
      return policy.acceptErase({ ...common, ...point(peer) });
    }
    return null;
  };
  const execute = async (actor, state, active, prepared) => {
    try {
      for (const action of prepared.actions) {
        for (const [index, operation] of action.steps.entries()) {
          await pause(actor, active, state.readyAt);
          if (operation.kind === 'wait') {
            await pause(actor, active, now() + operation.durationMs);
            state.readyAt = now();
          } else {
            const result = step(actor, active, operation);
            state.readyAt = now() + operation.durationMs;
            // Record committed work before notifying transports: an observation
            // failure cannot make a successfully applied step look unexecuted.
            active.completedSteps++;
            if (index === action.steps.length - 1) active.completedActions++;
            if (result) publish(result, actor);
            else presence(actor);
            continue;
          }
          active.completedSteps++;
          if (index === action.steps.length - 1) active.completedActions++;
        }
      }
      active.status = 'completed';
    } catch (error) {
      active.status = active.controller.signal.aborted || actor.closed || stopped || error.code === 'CANCELLED' ? 'cancelled' : 'blocked';
      if (active.status === 'blocked') active.error = errorRecord(error);
    }
    const result = summary(actor, active);
    state.results.set(active.id, clone(result));
    while (state.results.size > TURN_LIMITS.recentResults) state.results.delete(state.results.keys().next().value);
    if (state.active === active) state.active = null;
    running.delete(active);
    return result;
  };
  return {
    async run(actor, request) {
      if (!actor?.peer || !actor?.policy) throw new TypeError('An actor needs a peer and participant policy.');
      const prepared = prepare(request), state = stateFor(actor);
      if (state.seen.has(prepared.id)) {
        if (state.seen.get(prepared.id) !== prepared.fingerprint) throw new PolicyError('ID_CONFLICT', '같은 요청 id에 다른 행동을 보낼 수 없습니다.', { status: 409 });
        if (state.active?.id === prepared.id) return summary(actor, state.active, 'running');
        if (state.results.has(prepared.id)) return clone(state.results.get(prepared.id));
        throw new PolicyError('IDEMPOTENCY_EXPIRED', '이 요청의 실행 결과 보관 기간이 끝났습니다. 현재 관측으로 결과를 확인하세요.', { status: 409 });
      }
      if (stopped || actor.closed) throw new PolicyError('SESSION_CLOSED', '참여 세션이 종료되었습니다.', { status: 410 });
      if (state.active) throw new PolicyError('TURN_BUSY', '이전 행동이 실행 중입니다. 완료를 기다리거나 취소하세요.', { status: 429, retryAfterMs: 100 });
      if (state.seen.size >= TURN_LIMITS.lifetimeTurns) throw new PolicyError('SESSION_TURN_LIMIT', '이 세션의 행동 예약 수를 모두 사용했습니다. 새 세션을 열어 주세요.', { status: 409 });
      const active = { id: prepared.id, startedAt: now(), status: 'running',
        completedActions: 0, completedSteps: 0, controller: new AbortController() };
      state.seen.set(prepared.id, prepared.fingerprint);
      state.active = active; running.add(active);
      active.promise = execute(actor, state, active, prepared);
      return active.promise;
    },
    cancel(actor) {
      const active = states.get(actor)?.active;
      if (!active) return false;
      active.controller.abort(new PolicyError('CANCELLED', '남은 행동을 취소했습니다.', { status: 409 }));
      return true;
    },
    shutdown() {
      stopped = true;
      const pending = [...running];
      for (const active of pending) active.controller.abort(new PolicyError('CANCELLED', '서버가 종료되어 남은 행동을 취소했습니다.', { status: 409 }));
      return Promise.allSettled(pending.map(active => active.promise));
    },
  };
}
