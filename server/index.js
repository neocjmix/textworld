import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { World, WorldError } from './world.js';
import { WritingSession } from '../shared/writing.js';
import { VIEW_LIMITS } from '../shared/participant-rules.js';
import { LIMITS, NetworkBudgets, ParticipantPolicy, PolicyError } from './participant-policy.js';
import { Observer, contains, viewRectangle, validateView } from './visibility.js';
import { createTurnRunner } from './agent-turns.js';
import { createAgentHTTP } from './agent-http.js';
import { createMCPAgent } from './mcp-agent.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const palette = ['#ffbe75', '#79d4cd', '#c4a7ff', '#ff8fa3', '#a3d977', '#86b7ff'];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const publicWorld = world => ({ width: world.width, height: world.height, epoch: world.epoch, textLayout: 2 });
const errorRecord = error => ({ code: error.code || 'BAD_MESSAGE',
  message: error instanceof WorldError || error instanceof PolicyError || error.status ? error.message : '요청을 처리하지 못했습니다.',
  status: error.status || (error instanceof WorldError || error instanceof SyntaxError ? 400 : 500),
  ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) });

/** Only enable the documented edge header when all public traffic uses Railway. */
export function networkKey(req, trustProxy = false) {
  const real = req.headers['x-real-ip'];
  let address = trustProxy === 'railway' && typeof real === 'string' && isIP(real) ? real : req.socket.remoteAddress || 'unknown';
  if (/^::ffff:/i.test(address) && isIP(address.slice(7)) === 4) address = address.slice(7);
  // IPv6 privacy-address rotation within a normal /64 must not reset a budget.
  if (isIP(address) === 6) {
    const expanded = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
    const [left, right = ''] = expanded.split('::');
    const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
    address = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b].slice(0, 4).map(s => s.padStart(4, '0')).join(':') + '::/64';
  }
  return address;
}

export function createTextworld({ storagePath = process.env.TEXTWORLD_DB || resolve(root, 'data/world.sqlite'),
  scavengerToken = process.env.SCAVENGER_TOKEN || '', now = Date.now, policyNow = () => performance.now(),
  trustProxy = process.env.TEXTWORLD_TRUST_PROXY || (process.env.RAILWAY_ENVIRONMENT_ID ? 'railway' : false) } = {}) {
  const world = new World({ storagePath, now });
  const clients = new Map(), actors = new Set(), listeners = new Set();
  const networks = new NetworkBudgets({ now: policyNow });
  let colorIndex = 0, closing = false;
  const limits = { ...LIMITS, view: VIEW_LIMITS, turn: { maxActions: 16, maxGraphemes: 256, maxUtf16: 4096,
    maxDurationMs: 30000, typingPerSecond: 10, movementPerSecond: 160 }, sessionIdleMs: 120000, maxWaitMs: 25000 };
  const peers = () => [...actors].filter(actor => !actor.closed).map(actor => actor.peer);
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, 'Slow client; reconnect for current view'); return false; }
    socket.send(JSON.stringify(message)); return true;
  };
  const notify = () => { for (const listener of listeners) listener(); };
  const scopedUpdate = (socket, actor, { snapshot = false, ...extra } = {}) => {
    try {
      const previous = actor.observer.revision;
      const observation = actor.observer.read(peers(), { since: previous, force: snapshot });
      clearTimeout(actor.retry); actor.retry = null;
      if (snapshot) {
        send(socket, { type: 'snapshot', world: publicWorld(world), selfId: actor.peer.id,
          cells: observation.cells, peers: observation.peers, view: observation.view, viewRevision: observation.revision, limits, ...extra });
        actor.lastSnapshotEpoch = world.epoch;
      } else if (observation.revision !== previous || extra.force) send(socket, { type: 'view', world: publicWorld(world), observation });
    } catch (error) {
      if (!actor.retry) {
        send(socket, { type: 'error', ...errorRecord(error), requestType: 'view', cursor: { x: actor.peer.x, y: actor.peer.y } });
        if (error.status === 429) actor.retry = setTimeout(() => {
          actor.retry = null;
          if (!actor.closed) scopedUpdate(socket, actor, { snapshot: actor.lastSnapshotEpoch !== world.epoch, reason: 'observation-retry' });
        }, Math.max(1, error.retryAfterMs));
      }
    }
  };
  const presence = () => {
    if (closing) return;
    for (const [socket, actor] of clients) scopedUpdate(socket, actor);
    notify();
  };
  const publish = result => { if (!result.duplicate) presence(); };
  const runner = createTurnRunner({ world, publish, presence, now: policyNow });
  const createActor = (req, { name, view, position } = {}) => {
    const acceptedView = validateView(view);
    const network = networks.acquire(networkKey(req, trustProxy));
    const peer = { id: randomUUID(), name: typeof name === 'string' ? name.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 24) : '',
      color: palette[colorIndex++ % palette.length], x: Math.floor(world.width / 2), y: Math.floor(world.height / 2) };
    peer.name ||= `여행자 ${actors.size + 1}`;
    const actor = { peer, network, closed: false, hello: false, alive: true, lastSnapshotEpoch: null };
    actor.policy = new ParticipantPolicy({ world, peer, now: policyNow, network,
      isVisible: (x, y) => {
        const rectangle = viewRectangle(world, peer, actor.observer.view);
        return contains(rectangle, x, y, world)
          || world.spanAt(x, y).some(cell => contains(rectangle, cell.x, cell.y, world));
      } });
    actor.observer = new Observer({ world, peer, view: acceptedView, charge: cost => actor.policy.acceptObservation(cost) });
    try {
      if (position !== undefined) {
        if (!position || typeof position !== 'object' || Array.isArray(position)) throw new PolicyError('BAD_POSITION', '셀 좌표가 필요합니다.');
        actor.policy.acceptMove({ ...position, epoch: world.epoch });
      }
      actor.writing = new WritingSession(peer);
      actors.add(actor); return actor;
    } catch (error) { networks.release(network); throw error; }
  };
  const removeActor = actor => {
    if (actor.closed) return;
    actor.closed = true; clearTimeout(actor.retry); runner.cancel(actor);
    actors.delete(actor); networks.release(actor.network); presence();
  };
  const agentHTTP = createAgentHTTP({ world, createActor: (req, options) => {
    const actor = createActor(req, options); queueMicrotask(presence); return actor;
  }, removeActor, peers, runner, limits, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
  const mcp = createMCPAgent({ agentHTTP,
    acceptRequest: req => networks.get(networkKey(req, trustProxy)).request.spend() });
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const authorized = req => {
    if (!scavengerToken) return false;
    const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${scavengerToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const body = async req => {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 65536) throw new PolicyError('TOO_LARGE', 'Request too large', { status: 413 }); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://textworld.local');
      if (await mcp.handle(req, res, url)) return;
      if (await agentHTTP.handle(req, res, url)) return;
      if (url.pathname === '/health') return json(res, 200, { ok: true, world: publicWorld(world), peers: actors.size });
      if (url.pathname.startsWith('/api/scavenger/')) {
        if (!authorized(req)) return json(res, 404, { error: 'Not found' });
        if (url.pathname === '/api/scavenger/evidence' && req.method === 'GET') {
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : now();
          if (!Number.isFinite(before)) throw new WorldError('BAD_TIME', 'Invalid timestamp');
          return json(res, 200, { epoch: world.epoch, cells: world.evidence({ before }) });
        }
        if (url.pathname === '/api/scavenger/delete' && req.method === 'POST') {
          const result = world.conditionalDelete(await body(req)); publish(result);
          return json(res, 200, { deleted: result.cells.length, seq: result.seq });
        }
        return json(res, 405, { error: 'Unsupported method' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Unsupported method' });
      const decoded = decodeURIComponent(url.pathname);
      const base = decoded.startsWith('/shared/') ? resolve(root, 'shared') : resolve(root, 'public');
      const relative = decoded.startsWith('/shared/') ? decoded.slice(8) : decoded === '/' ? 'index.html' : decoded.slice(1);
      const file = resolve(base, relative);
      if (!file.startsWith(base + sep)) return json(res, 404, { error: 'Not found' });
      const content = await readFile(file);
      const versionedFont = /^\/fonts\/[A-Za-z0-9._-]+-\d+\.\d+\.\d+\.woff2$/.test(decoded);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': versionedFont ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return json(res, 404, { error: 'Not found' });
      const record = errorRecord(error);
      if (record.retryAfterMs) res.setHeader('Retry-After', Math.max(1, Math.ceil(record.retryAfterMs / 1000)));
      json(res, record.status, { error: record });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (req, socket, head) => {
    let actor;
    try {
      if (new URL(req.url, 'http://textworld.local').pathname !== '/ws') return socket.destroy();
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return socket.destroy();
      actor = createActor(req);
      let transferred = false;
      socket.once('close', () => { if (!transferred) removeActor(actor); });
      wss.handleUpgrade(req, socket, head, ws => {
        transferred = true;
        wss.emit('connection', ws, actor);
      });
    } catch (error) {
      if (actor) removeActor(actor);
      const status = error.status || 400;
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n${error.retryAfterMs ? `Retry-After: ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))}\r\n` : ''}Content-Length: 0\r\n\r\n`);
    }
  });
  wss.on('connection', (socket, actor) => {
    const { peer, policy } = actor;
    clients.set(socket, actor); scopedUpdate(socket, actor, { snapshot: true }); presence();
    socket.on('pong', () => { actor.alive = true; });
    socket.on('message', raw => {
      let message;
      try {
        policy.acceptRequest();
        message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new WorldError('BAD_MESSAGE', '잘못된 요청입니다.');
        if (message.type === 'hello') {
          if (actor.hello) return;
          actor.hello = true;
          if (message.view) actor.observer.setView(message.view);
          if (typeof message.name === 'string') peer.name = message.name.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 24) || peer.name;
          if (message.x !== undefined || message.y !== undefined) policy.acceptMove({ x: message.x, y: message.y, epoch: world.epoch });
          presence();
        } else if (message.type === 'move') { policy.acceptMove(message); presence(); }
        else if (message.type === 'view') {
          actor.observer.setView({ cols: message.cols, rows: message.rows });
          scopedUpdate(socket, actor, { force: true });
        } else if (message.type === 'write' || message.type === 'erase') {
          const result = message.type === 'write' ? policy.acceptWrite(message) : policy.acceptErase(message);
          publish(result);
          send(socket, { type: 'ack', id: message.id, seq: result.seq, epoch: result.epoch, cursor: result.cursor, duplicate: !!result.duplicate });
        } else if (message.type === 'sync') scopedUpdate(socket, actor, { snapshot: true });
        else throw new WorldError('UNKNOWN_MESSAGE', '알 수 없는 요청입니다.');
      } catch (error) {
        send(socket, { type: 'error', ...errorRecord(error), id: message?.id, requestType: message?.type, cursor: { x: peer.x, y: peer.y } });
        if (error.code === 'STALE_EPOCH' && actor.lastSnapshotEpoch !== world.epoch) scopedUpdate(socket, actor, { snapshot: true, reason: 'stale-epoch' });
      }
    });
    socket.on('close', () => { clients.delete(socket); removeActor(actor); });
    socket.on('error', () => {});
  });
  const heartbeat = setInterval(() => {
    networks.prune();
    for (const [socket, actor] of clients) {
      if (!actor.alive) { socket.terminate(); continue; }
      actor.alive = false; socket.ping();
    }
  }, 15000);
  const adaptation = setInterval(() => {
    try {
      const result = world.adapt(peers());
      if (result.changed) {
        for (const [socket, actor] of clients) scopedUpdate(socket, actor, { snapshot: true, reason: 'density-resize', resize: result });
        notify();
      }
    } catch (error) { console.error('Density adaptation failed:', error.message); }
  }, 10000);
  return {
    server, world, wss,
    listen: (port = 3000, host = '0.0.0.0') => new Promise(resolve => server.listen(port, host, () => resolve(server.address()))),
    close: async () => {
      closing = true; clearInterval(heartbeat); clearInterval(adaptation);
      agentHTTP.close(); await runner.shutdown(); await mcp.close();
      for (const actor of actors) removeActor(actor);
      for (const socket of clients.keys()) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); }
      world.close();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createTextworld();
  const address = await app.listen(Number(process.env.PORT || 3000));
  console.log(`Textworld listening on http://localhost:${address.port}`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
