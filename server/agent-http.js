import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PolicyError } from './participant-policy.js';

export const AGENT_HTTP_LIMITS = Object.freeze({ sessionIdleMs: 120_000, maxWaitMs: 25_000, bodyBytes: 65_536 });
const base = '/api/agents/v1';
const fail = (code, message, status = 400, retryAfterMs = 0) => new PolicyError(code, message, { status, retryAfterMs });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));

function json(res, status, value, retryAfterMs = 0) {
  if (res.destroyed || res.writableEnded) return;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (status === 429 || retryAfterMs > 0) headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : JSON.stringify(value));
}

function readBody(req) {
  const contentType = req.headers['content-type'];
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    req.resume();
    return Promise.reject(fail('BAD_CONTENT_TYPE', 'application/json 요청을 사용하세요.', 415));
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const error = cause => { cleanup(); reject(cause); };
    const aborted = () => error(fail('BAD_BODY', '요청 본문이 중단되었습니다.'));
    const data = chunk => {
      size += chunk.length;
      if (size > AGENT_HTTP_LIMITS.bodyBytes) {
        cleanup(); req.resume();
        reject(fail('TOO_LARGE', '요청 본문이 너무 큽니다.', 413));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(fail('BAD_JSON', '올바른 JSON 본문이 필요합니다.')); }
    };
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
  });
}

function publicError(error) {
  return { code: error.code || 'REQUEST_FAILED', message: error.status || error.name === 'WorldError'
    ? error.message : '요청을 처리하지 못했습니다.', retryAfterMs: error.retryAfterMs || 0 };
}

/** Anonymous sessions add transport efficiency, never a privileged world handle. */
export function createAgentHTTP({ world, createActor, removeActor, peers, runner, now = Date.now,
  limits = {}, subscribe = () => () => {} }) {
  const sessions = new Map();
  let closed = false;
  const metadata = () => ({ width: world.width, height: world.height, epoch: world.epoch, textLayout: 2 });
  const touch = session => { session.touchedAt = now(); };
  const read = (session, since) => session.actor.observer.read(peers(), { since });
  const payload = (session, observation, turn) => ({
    session: { id: session.actor.peer.id, expiresInMs: AGENT_HTTP_LIMITS.sessionIdleMs },
    world: metadata(), cursor: { x: session.actor.peer.x, y: session.actor.peer.y },
    ...(turn ? { turn } : {}), ...(observation ? { observation } : {}),
  });
  function dispose(session) {
    if (!sessions.delete(session.actor.peer.id)) return;
    session.waiter?.finish();
    runner.cancel(session.actor);
    removeActor(session.actor);
  }
  function prune() {
    const cutoff = now() - AGENT_HTTP_LIMITS.sessionIdleMs;
    for (const session of sessions.values()) {
      if (!session.active && !session.waiter && session.touchedAt <= cutoff) dispose(session);
    }
  }
  const expiry = setInterval(prune, 1000);
  expiry.unref();

  function authenticate(req, id) {
    const session = sessions.get(id);
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${session?.token || randomBytes(32).toString('base64url')}`);
    if (!session || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw fail('UNAUTHORIZED', '유효한 세션 토큰이 필요합니다.', 401);
    }
    if (!session.active && !session.waiter && now() - session.touchedAt >= AGENT_HTTP_LIMITS.sessionIdleMs) {
      dispose(session);
      throw fail('UNAUTHORIZED', '유효한 세션 토큰이 필요합니다.', 401);
    }
    touch(session);
    return session;
  }

  async function observe(session, since, waitMs, res) {
    let observation = read(session, since);
    if (!waitMs || since !== observation.revision || observation.reset) return observation;
    return new Promise((resolve, reject) => {
      let done = false, unsubscribe = () => {}, timer;
      const finish = error => {
        if (done) return;
        done = true; clearTimeout(timer); unsubscribe(); res.off('close', disconnected);
        session.waiter = null; touch(session);
        if (error) reject(error); else resolve(observation);
      };
      const changed = () => {
        try {
          // Invisible changes neither return a response nor advance a revision.
          const next = read(session, since);
          observation = next;
          if (next.revision !== since || next.reset) finish();
        } catch (error) { finish(error); }
      };
      const disconnected = () => finish();
      session.waiter = { finish };
      unsubscribe = subscribe(changed);
      timer = setTimeout(() => { changed(); finish(); }, waitMs);
      res.once('close', disconnected);
    });
  }

  function validateTurn(value) {
    if (!record(value) || !ownKeys(value, ['id', 'actions', 'since', 'waitMs']) || !Array.isArray(value.actions)) {
      throw fail('BAD_TURN', 'actions 배열을 포함한 행동 요청이 필요합니다.');
    }
    if (value.since !== undefined && (!Number.isSafeInteger(value.since) || value.since < 0)) {
      throw fail('BAD_REVISION', 'since는 0 이상의 정수여야 합니다.');
    }
    const waitMs = value.waitMs ?? 0;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > AGENT_HTTP_LIMITS.maxWaitMs || (value.actions.length && waitMs)) {
      throw fail('BAD_WAIT', '빈 actions 관측만 0~25000ms 기다릴 수 있습니다.');
    }
    if (value.id !== undefined && (typeof value.id !== 'string' || !value.id || value.id.length > 64)) {
      throw fail('BAD_ID', '행동 식별자는 1~64자 문자열이어야 합니다.');
    }
    return { ...value, waitMs };
  }

  async function handle(req, res, url = new URL(req.url, 'http://textworld.local')) {
    const path = url.pathname;
    if (path !== '/.well-known/textworld-agent.json' && path !== base && !path.startsWith(`${base}/`)) return false;
    let session, turn;
    try {
      if (closed) throw fail('SERVER_CLOSING', '서버가 다시 시작 중입니다.', 503, 1000);
      if (path === base || path === '/.well-known/textworld-agent.json') {
        if (req.method !== 'GET') throw fail('METHOD_NOT_ALLOWED', 'GET 요청을 사용하세요.', 405);
        json(res, 200, { version: 1, access: 'public-anonymous', sessions: `${base}/sessions`,
          docs: '/agents.html', source: 'https://github.com/neocjmix/textworld/blob/main/docs/AGENT_API.md',
          actions: ['type', 'move', 'enter', 'backspace', 'delete', 'home', 'wait'],
          limits: { ...limits, http: AGENT_HTTP_LIMITS } });
        return true;
      }
      if (path === `${base}/sessions`) {
        if (req.method !== 'POST') throw fail('METHOD_NOT_ALLOWED', 'POST 요청을 사용하세요.', 405);
        const input = await readBody(req);
        if (!record(input) || !ownKeys(input, ['name', 'view', 'position'])) throw fail('BAD_SESSION', '잘못된 세션 설정입니다.');
        if (closed) throw fail('SERVER_CLOSING', '서버가 다시 시작 중입니다.', 503, 1000);
        const actor = createActor(req, input);
        try {
          session = { actor, token: randomBytes(32).toString('base64url'), touchedAt: now(), active: 0, waiter: null };
          const observation = read(session);
          sessions.set(actor.peer.id, session);
          const result = payload(session, observation);
          result.session.token = session.token;
          result.limits = { ...limits, http: AGENT_HTTP_LIMITS };
          json(res, 201, result);
        } catch (error) { removeActor(actor); throw error; }
        return true;
      }
      const match = path.match(/^\/api\/agents\/v1\/sessions\/([^/]+)(?:\/(turn|cancel))?$/);
      if (!match) throw fail('NOT_FOUND', '알 수 없는 경로입니다.', 404);
      session = authenticate(req, match[1]);
      if (!match[2] && req.method === 'DELETE') {
        dispose(session); json(res, 204); return true;
      }
      if (match[2] === 'cancel' && req.method === 'POST') {
        const waiting = !!session.waiter;
        session.waiter?.finish();
        const cancelled = runner.cancel(session.actor) || waiting;
        json(res, 200, { cancelled }); return true;
      }
      if (match[2] !== 'turn' || req.method !== 'POST') throw fail('METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식입니다.', 405);
      session.actor.policy.acceptRequest();
      const request = validateTurn(await readBody(req));
      if (!sessions.has(session.actor.peer.id) || session.actor.closed) throw fail('UNAUTHORIZED', '유효한 세션 토큰이 필요합니다.', 401);
      if (session.waiter || (!request.actions.length && session.active)) {
        throw fail('SESSION_BUSY', '이 세션의 진행 중인 행동이나 관측을 먼저 마쳐 주세요.', 429, 100);
      }
      if (request.actions.length) {
        session.active++;
        try { turn = await runner.run(session.actor, request); }
        finally { session.active--; touch(session); }
        if (turn.status === 'running') {
          json(res, 202, payload(session, undefined, turn));
          return true;
        }
        if (session.active) {
          throw fail('SESSION_BUSY', '진행 중인 행동이 끝난 뒤 현재 시야를 확인하세요.', 429, 100);
        }
        // Never cache observations with idempotency results: retries see only
        // the current bounded view, including when an earlier action was partial.
        const observation = read(session, request.since);
        const result = payload(session, observation, turn);
        if (turn.error) result.error = publicError(turn.error);
        json(res, turn.error?.status || (turn.status === 'running' ? 202 : 200), result, turn.error?.retryAfterMs);
      } else {
        const observation = await observe(session, request.since, request.waitMs, res);
        touch(session); json(res, 200, payload(session, observation));
      }
    } catch (error) {
      req.resume();
      const status = error.status || (error.name === 'WorldError' || error instanceof SyntaxError ? 400 : 500);
      const result = { ...(session && turn ? payload(session, undefined, turn) : {}), error: publicError(error) };
      json(res, status, result, error.retryAfterMs);
    }
    return true;
  }
  return { handle, sessions, prune, close() {
    closed = true; clearInterval(expiry);
    for (const session of sessions.values()) dispose(session);
  } };
}
