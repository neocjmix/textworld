/** Node.js 24+ client for the anonymous, bounded Textworld participant API. */
import { randomUUID } from 'node:crypto';

export class TextworldError extends Error {
  constructor(message, { status, code, retryAfterMs = 0, turn, response, requestId } = {}) {
    super(message);
    this.name = 'TextworldError';
    Object.assign(this, { status, code, retryAfterMs, turn, response, requestId });
  }
}

export class RateLimitError extends TextworldError {
  constructor(message, details) { super(message, details); this.name = 'RateLimitError'; }
}

function retryDelay(response, body) {
  const specified = body?.error?.retryAfterMs;
  if (Number.isFinite(specified) && specified >= 0) return specified;
  const value = response.headers.get('retry-after');
  if (value === null) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
}

async function decode(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch {
    throw new TextworldError('The server returned a non-JSON response.', {
      status: response.status, code: 'BAD_RESPONSE',
    });
  }
}

function check(response, body, requestId) {
  if (response.ok) return;
  const ErrorType = response.status === 429 ? RateLimitError : TextworldError;
  throw new ErrorType(body?.error?.message || `Textworld request failed (${response.status}).`, {
    status: response.status, code: body?.error?.code || 'HTTP_ERROR',
    retryAfterMs: retryDelay(response, body), turn: body?.turn, response: body, requestId,
  });
}

export class TextworldAgent {
  #token;
  #fetch;
  #url;
  #closed = false;

  /** No account or pre-issued API key is required. The returned token is private. */
  static async connect(baseUrl, { name, view, position, fetch: fetchImpl = globalThis.fetch, signal } = {}) {
    const url = new URL('/api/agents/v1/sessions', baseUrl);
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, view, position }), signal,
    });
    const body = await decode(response);
    check(response, body);
    if (!body?.session?.id || !body.session.token) {
      throw new TextworldError('The server did not return a session.', { status: response.status, code: 'BAD_RESPONSE' });
    }
    return new TextworldAgent(url, fetchImpl, body);
  }

  constructor(url, fetchImpl, response) {
    this.#url = new URL(`${url.pathname}/${encodeURIComponent(response.session.id)}`, url);
    this.#fetch = fetchImpl;
    this.#token = response.session.token;
    this.id = response.session.id;
    this.cells = new Map();
    this.peers = [];
    this.revision = undefined;
    this.limits = response.limits;
    this.#apply(response);
  }

  #apply(body) {
    if (!body) return;
    if (body.world) this.world = { ...body.world };
    if (body.cursor) this.cursor = { ...body.cursor };
    if (body.session?.expiresInMs !== undefined) this.expiresInMs = body.session.expiresInMs;
    if (body.turn) this.lastTurn = body.turn;
    const observation = body.observation;
    if (!observation) return;
    if (observation.reset) this.cells.clear();
    for (const { x, y } of observation.forget || []) this.cells.delete(`${x},${y}`);
    for (const cell of observation.cells || []) this.cells.set(`${cell.x},${cell.y}`, { ...cell });
    this.peers = (observation.peers || []).map(peer => ({ ...peer }));
    this.freshness = { ...observation.freshness };
    this.marks = (observation.marks || []).map(mark => ({ ...mark }));
    this.view = { ...observation.view };
    this.revision = observation.revision;
  }

  async #request(path, { method = 'POST', body, signal } = {}) {
    if (this.#closed) throw new TextworldError('This session has been closed.', { code: 'SESSION_CLOSED' });
    const headers = { Authorization: `Bearer ${this.#token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await this.#fetch(`${this.#url}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal,
      });
      const data = await decode(response);
      // A blocked turn can have real, already-committed effects. Retain the
      // returned progress and view before raising its HTTP error to the caller.
      this.#apply(data);
      check(response, data, body?.id);
      return data;
    } catch (error) {
      // Preserve the generated identity even when the response was lost. A
      // caller can query the same turn instead of issuing its effects again.
      if (body?.id && error && typeof error === 'object' && Object.isExtensible(error)) error.requestId = body.id;
      throw error;
    }
  }

  /** Execute a bounded batch. It is paced by the server, never replayed here. */
  turn(actions, { id = randomUUID(), signal } = {}) {
    return this.#request('/turn', { body: { id, actions, since: this.revision }, signal });
  }

  /** Read the current local view, optionally waiting for a visible change. */
  observe({ waitMs = 0, signal } = {}) {
    return this.#request('/turn', { body: { actions: [], since: this.revision, waitMs }, signal });
  }

  /** Stop remaining actions. Completed writes remain in the shared world. */
  cancel({ signal } = {}) { return this.#request('/cancel', { signal }); }

  /** Release presence and stop remaining actions; repeated local close is safe. */
  async close({ signal } = {}) {
    if (this.#closed) return;
    await this.#request('', { method: 'DELETE', signal });
    this.#closed = true;
    this.#token = undefined;
  }
}
