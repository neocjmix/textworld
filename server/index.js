import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { World, WorldError } from './world.js';
import { wrap } from '../shared/world.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const palette = ['#ffbe75', '#79d4cd', '#c4a7ff', '#ff8fa3', '#a3d977', '#86b7ff'];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createTextworld({ storagePath = process.env.TEXTWORLD_DB || resolve(root, 'data/world.sqlite'), scavengerToken = process.env.SCAVENGER_TOKEN || '', now = Date.now } = {}) {
  const world = new World({ storagePath, now });
  const clients = new Map();
  let colorIndex = 0;
  const peers = () => [...clients.values()].map(client => client.peer);
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, 'Slow client; reconnect for snapshot'); return; }
    socket.send(JSON.stringify(message));
    return true;
  };
  const broadcast = message => { for (const socket of clients.keys()) send(socket, message); };
  const snapshot = (socket, extra = {}) => {
    const client = clients.get(socket);
    if (send(socket, { type: 'snapshot', ...world.snapshot(), selfId: client.peer.id, peers: peers(), ...extra })) {
      client.lastSnapshotEpoch = world.epoch;
    }
  };
  const snapshots = extra => { for (const socket of clients.keys()) snapshot(socket, extra); };
  const presence = () => broadcast({ type: 'presence', peers: peers() });
  const publish = result => { if (!result.duplicate) broadcast({ type: 'cells', ...result }); };
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const authorized = req => {
    if (!scavengerToken) return false;
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${scavengerToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const body = async req => {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 65536) throw new WorldError('TOO_LARGE', 'Request too large'); }
    return JSON.parse(text);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://textworld.local');
      if (url.pathname === '/health') return json(res, 200, { ok: true, world: world.metadata(), peers: clients.size });
      if (url.pathname.startsWith('/api/scavenger/')) {
        if (!authorized(req)) return json(res, 404, { error: 'Not found' });
        if (url.pathname === '/api/scavenger/evidence' && req.method === 'GET') {
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : now();
          if (!Number.isFinite(before)) throw new WorldError('BAD_TIME', 'Invalid timestamp');
          return json(res, 200, { epoch: world.epoch, cells: world.evidence({ before }) });
        }
        if (url.pathname === '/api/scavenger/delete' && req.method === 'POST') {
          const result = world.conditionalDelete(await body(req));
          publish(result);
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
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return json(res, 404, { error: 'Not found' });
      json(res, error instanceof WorldError || error instanceof SyntaxError ? 400 : 500, { error: error instanceof WorldError ? error.message : 'Request failed' });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (new URL(req.url, 'http://textworld.local').pathname !== '/ws') return socket.destroy();
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return socket.destroy();
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } catch { socket.destroy(); }
  });
  wss.on('connection', socket => {
    const peer = { id: randomUUID(), name: `여행자 ${clients.size + 1}`, color: palette[colorIndex++ % palette.length], x: Math.floor(world.width / 2), y: Math.floor(world.height / 2) };
    const client = { peer, hello: false, alive: true, tokens: 160, lastRefill: now(), lastSnapshotEpoch: null };
    clients.set(socket, client);
    snapshot(socket);
    presence();
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', raw => {
      let message;
      try {
        const elapsed = Math.max(0, now() - client.lastRefill);
        client.tokens = Math.min(160, client.tokens + elapsed * 0.08);
        client.lastRefill = now();
        if (--client.tokens < 0) { socket.close(1008, 'Too many messages'); return; }
        message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new WorldError('BAD_MESSAGE', '잘못된 요청입니다.');
        if (message.type === 'hello') {
          if (client.hello) return;
          client.hello = true;
          if (typeof message.name === 'string') peer.name = message.name.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 24) || peer.name;
          if (message.x !== undefined && message.y !== undefined) {
            world.assertPosition(message.x, message.y);
            peer.x = wrap(message.x, world.width); peer.y = wrap(message.y, world.height);
          }
          presence();
        } else if (message.type === 'move') {
          world.assertEpoch(message.epoch);
          world.assertPosition(message.x, message.y);
          peer.x = wrap(message.x, world.width); peer.y = wrap(message.y, world.height);
          presence();
        } else if (message.type === 'write' || message.type === 'erase') {
          if (message.layout !== 2) throw new WorldError('CLIENT_UPDATE_REQUIRED', '입력 방식이 업데이트되었습니다. 페이지를 새로고침해 주세요.');
          const operation = { ...message, author: peer.id };
          const result = message.type === 'write' ? world.applyWrite(operation) : world.erase(operation);
          if (!result.duplicate) {
            peer.x = result.cursor.x; peer.y = result.cursor.y;
            publish(result); presence();
          }
          send(socket, { type: 'ack', id: message.id, seq: result.seq, epoch: result.epoch, cursor: result.cursor, duplicate: !!result.duplicate });
        } else if (message.type === 'sync') snapshot(socket);
        else throw new WorldError('UNKNOWN_MESSAGE', '알 수 없는 요청입니다.');
      } catch (error) {
        send(socket, { type: 'error', code: error.code || 'BAD_MESSAGE', message: error instanceof WorldError ? error.message : '요청을 처리하지 못했습니다.', id: message?.id });
        // Ordered WebSocket delivery guarantees a previously sent epoch snapshot arrives first.
        // Repeating it for queued stale frames would reset valid new-epoch client input.
        if (error.code === 'STALE_EPOCH' && client.lastSnapshotEpoch !== world.epoch) snapshot(socket, { reason: 'stale-epoch' });
      }
    });
    socket.on('close', () => { clients.delete(socket); presence(); });
    socket.on('error', () => {});
  });
  const heartbeat = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.alive) { socket.terminate(); continue; }
      client.alive = false; socket.ping();
    }
  }, 15000);
  const adaptation = setInterval(() => {
    try { const result = world.adapt(peers()); if (result.changed) snapshots({ reason: 'density-resize', resize: result }); }
    catch (error) { console.error('Density adaptation failed:', error.message); }
  }, 10000);
  return {
    server, world, wss,
    listen: (port = 3000, host = '0.0.0.0') => new Promise(resolve => server.listen(port, host, () => resolve(server.address()))),
    close: async () => {
      clearInterval(heartbeat); clearInterval(adaptation);
      for (const socket of clients.keys()) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
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
