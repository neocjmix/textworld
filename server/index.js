import http from 'node:http';
import { randomUUID, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { World, WorldError } from './world.js';
import { VIEW_LIMITS } from '../shared/participant-rules.js';
import { LIMITS, NetworkBudgets, ParticipantPolicy, PolicyError } from './participant-policy.js';
import { Observer, contains, viewRectangle, validateView } from './visibility.js';
import { createTurnRunner } from './agent-turns.js';
import { createAgentHTTP } from './agent-http.js';
import { Measurements, route as measurementRoute } from './measurements.js';
import { createMCPAgent } from './mcp-agent.js';
import { expire } from './expiration.js';
import { DENSITY } from './density.js';
import { localContinuity } from './local-continuity.js';
import { translateTrail } from '../shared/relocation.js';
import { CursorInput, remapWriting } from '../shared/cursor-input.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
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
  now = Date.now, policyNow = () => performance.now(),
  metricsPath, metricsToken = process.env.TEXTWORLD_METRICS_TOKEN || '', metricsEnabled = true,
  trustProxy = process.env.TEXTWORLD_TRUST_PROXY || (process.env.RAILWAY_ENVIRONMENT_ID ? 'railway' : false) } = {}) {
  const world = new World({ storagePath, now });
  world.storagePath = storagePath;
  const measurements = new Measurements({path:metricsPath || (storagePath === ':memory:' ? ':memory:' : storagePath + '.metrics.sqlite'),enabled:metricsEnabled});
  const commit = world.commit.bind(world);
  world.commit = (...args) => {const started=performance.now();try {const result=commit(...args);measurements.record('commit.count');measurements.record('commit.cells',result.cells.length);return result;}finally {measurements.record('commit.ms',performance.now()-started);}};
  const resizeWorld=world.resize.bind(world);
  world.resize=(width,height,participants=peers(),options)=>{
    const started=performance.now();
    try {
      const before = new Map([...actors].map(actor => [actor, { peer: { ...actor.peer }, requested: actor.observer.view,
        view: viewRectangle(world, actor.peer, actor.observer.view) }]));
      const result=resizeWorld(width,height,[...new Set([...participants,...peers()])],options);
      if(result.changed){
        measurements.record('topology.changed');measurements.record('topology.lost_text_cells',result.lostTextCells);measurements.record('topology.broken_adjacencies',result.brokenAdjacencies);measurements.record('topology.destroyed_cells',result.destroyedCells);measurements.record('topology.surviving_cells',result.survivingCells);
        const relocations = new Map();
        const browserActors = new Set(clients.values());
        for(const actor of actors){
          const relocation = localContinuity(before.get(actor), actor.peer, result, actor.policy, actor.writing);
          if (relocation) {
            // Only WebSockets receive the per-view translation with an eager
            // snapshot. HTTP/MCP must retain the old baseline until their next
            // read returns a reset with the newly addressed cells.
            if (browserActors.has(actor)) actor.observer.relocate(relocation);
            relocations.set(actor, relocation); measurements.record('topology.local_preserved');
          } else { measurements.record('topology.local_reset'); }
          const oldCursor = before.get(actor).peer;
          actor.policy.remap(result, oldCursor);
          remapWriting(actor.writing, oldCursor, actor.peer, result);
          actor.input.cursor = { x: actor.peer.x, y: actor.peer.y };
          actor.input.native.remap(result, actor.peer, (x,y) => world.spanAt(x,y));
          actor.input.nativeBase = relocation ? translateTrail(actor.input.nativeBase, relocation) : [];
        }
        for(const [socket,actor] of clients)scopedUpdate(socket,actor,{snapshot:true,reason:'density-resize',resize:{ ...result, relocation:relocations.get(actor) }});
        notify();
      }
      return result;
    } finally {measurements.record('topology.ms',performance.now()-started);}
  };
  const clients = new Map(), actors = new Set(), listeners = new Set();
  const networks = new NetworkBudgets({ now: policyNow });
  let closing = false, population=0,lastPopulationAt=performance.now();
  const updatePopulation=()=>{const time=performance.now();measurements.record('activity.peer_ms',(time-lastPopulationAt)*population);population=actors.size;lastPopulationAt=time;};
  const limits = { ...LIMITS, view: VIEW_LIMITS, turn: { maxActions: 16, maxGraphemes: 256, maxUtf16: 4096,
    maxDurationMs: 30000, typingPerSecond: 10, movementPerSecond: 160 }, sessionIdleMs: 120000, maxWaitMs: 25000 };
  const peers = () => [...actors].filter(actor => !actor.closed).map(actor => actor.peer);
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { measurements.record('ws.slow_disconnects'); socket.close(1013, 'Slow client; reconnect for current view'); return false; }
    const encoded = JSON.stringify(message);
    measurements.record('ws.tx_bytes',Buffer.byteLength(encoded));measurements.record('ws.buffered_bytes',socket.bufferedAmount);
    if(message.type==='error')measurements.record(message.status===429?'ws.error_429':'ws.error_other');
    socket.send(encoded); return true;
  };
  const notify = () => { for (const listener of listeners) listener(); };
  const scopedUpdate = (socket, actor, { snapshot = false, ...extra } = {}) => {
    try {
      const previous = actor.observer.revision;
      const observation = actor.observer.read(peers(), { since: previous, force: snapshot });
      clearTimeout(actor.retry); actor.retry = null;
      if (snapshot) {
        actor.input.cursor = { x: actor.peer.x, y: actor.peer.y };
        measurements.record('input.snapshot_bytes', Buffer.byteLength(JSON.stringify(actor.input.snapshot())));
        send(socket, { type: 'snapshot', world: publicWorld(world), selfId: actor.peer.id,
          cells: observation.cells, marks: observation.marks, freshness: observation.freshness, colors: observation.colors, peers: observation.peers, view: observation.view, viewRevision: observation.revision, limits,
          input: { sequence: actor.inputSequence, state: actor.input.snapshot() }, ...extra });
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
    const started=performance.now();
    for (const [socket, actor] of clients) scopedUpdate(socket, actor);
    notify();measurements.record('presence.ms',performance.now()-started);measurements.record('presence.recipients',clients.size);
  };
  const publish = result => { if (!result.duplicate) presence(); };
  const runner = createTurnRunner({ world, publish, presence, now: policyNow });
  const runTurn=runner.run.bind(runner);runner.run=async(...args)=>{const started=performance.now();try{const result=await runTurn(...args);measurements.record('turn.'+result.status);measurements.record('turn.steps',result.completedSteps);return result;}catch(error){measurements.record('turn.error');throw error;}finally{measurements.record('turn.ms',performance.now()-started);}};
  const createActor = (req, { name, view, position } = {}) => {
    const acceptedView = validateView(view);
    if (world.usedColors.size >= 113 ** 3) throw new PolicyError('COLOR_CAPACITY', '새 사용자 색을 배정할 수 없습니다.', { status: 503 });
    const network = networks.acquire(networkKey(req, trustProxy));
    const usedColors = world.usedColors;
    let color;
    do { color = '#' + [randomInt(113), randomInt(113), randomInt(113)].map(v => v.toString(16).padStart(2, '0')).join(''); } while (usedColors.has(color));
    const peer = { id: randomUUID(), name: typeof name === 'string' ? name.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 24) : '',
      color, x: Math.floor(world.width / 2), y: Math.floor(world.height / 2) };
    world.reserveAuthor(peer.id, color);
    peer.name ||= `여행자 ${actors.size + 1}`;
    const actor = { peer, network, closed: false, hello: false, alive: true, lastSnapshotEpoch: null };
    actor.policy = new ParticipantPolicy({ world, peer, now: policyNow, network,
      isVisible: (x, y) => {
        const rectangle = viewRectangle(world, peer, actor.observer.view);
        return contains(rectangle, x, y, world)
          || world.spanAt(x, y).some(cell => contains(rectangle, cell.x, cell.y, world));
      } });
    actor.observer = new Observer({ world, peer, view: acceptedView, charge: cost => actor.policy.acceptObservation(cost) });
    const readObservation=actor.observer.read.bind(actor.observer);
    actor.observer.read=(...args)=>{const started=performance.now();try{const result=readObservation(...args);measurements.record('observer.ink_density',actor.observer.density);measurements.record('observer.cells',result.cells.length);measurements.record('observer.marks',result.marks.length);measurements.record('observer.changed',Number(result.reset||result.cells.length>0||result.forget.length>0));return result;}finally{measurements.record('observer.ms',performance.now()-started);measurements.record('observer.cols',Math.min(world.width,actor.observer.view.cols));measurements.record('observer.rows',Math.min(world.height,actor.observer.view.rows));measurements.record('observer.area',Math.min(world.width,actor.observer.view.cols)*Math.min(world.height,actor.observer.view.rows));}};
    try {
      if (position !== undefined) {
        if (!position || typeof position !== 'object' || Array.isArray(position)) throw new PolicyError('BAD_POSITION', '셀 좌표가 필요합니다.');
        actor.policy.acceptMove({ ...position, epoch: world.epoch });
      }
      actor.input = new CursorInput(peer);
      actor.writing = actor.input.writing;
      actor.inputSequence = 0;
      actors.add(actor);updatePopulation();measurements.record('activity.session_created'); return actor;
    } catch (error) { world.releaseAuthor(peer.id); networks.release(network); throw error; }
  };
  const removeActor = actor => {
    if (actor.closed) return;
    actor.closed = true; clearTimeout(actor.retry); runner.cancel(actor);
    actors.delete(actor);world.releaseAuthor(actor.peer.id);updatePopulation();measurements.record('activity.session_closed'); networks.release(actor.network); presence();
  };
  const agentHTTP = createAgentHTTP({ world, createActor: (req, options) => {
    const actor = createActor(req, options); queueMicrotask(presence); return actor;
  }, removeActor, peers, runner, limits, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
  const mcp = createMCPAgent({ agentHTTP,
    acceptRequest: req => networks.get(networkKey(req, trustProxy)).request.spend() });
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    const started=performance.now(),route=measurementRoute(req.url.split('?')[0]);let bytes=0;
    const length=(chunk,encoding)=>typeof chunk==='string'?Buffer.byteLength(chunk,typeof encoding==='string'?encoding:'utf8'):Buffer.isBuffer(chunk)||ArrayBuffer.isView(chunk)?chunk.byteLength:0;
    const write=res.write,end=res.end;
    res.write=function(chunk,...args){bytes+=length(chunk,args[0]);return write.call(this,chunk,...args);};
    res.end=function(chunk,...args){bytes+=length(chunk,args[0]);return end.call(this,chunk,...args);};
    let accounted=false;const account=()=>{if(accounted)return;accounted=true;measurements.record(`http.${route}.ms`,performance.now()-started);measurements.record(`http.${route}.tx_bytes`,bytes);measurements.record(`http.${route}.status_${[200,201,202,204,400,401,403,404,405,413,415,429,500,503].includes(res.statusCode)?res.statusCode:'other'}`);if(!res.writableFinished)measurements.record(`http.${route}.aborted`);const rx=Number(req.headers['content-length']);if(Number.isSafeInteger(rx)&&rx>=0)measurements.record(`http.${route}.declared_rx_bytes`,rx);};
    res.once('finish',account);res.once('close',account);
    try {
      const url = new URL(req.url, 'http://textworld.local');
      if (url.pathname === '/api/metrics') {
        const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+metricsToken);
        if(!metricsToken||actual.length!==expected.length||!timingSafeEqual(actual,expected))return json(res,404,{error:'Not found'});
        if(req.method!=='GET')return json(res,405,{error:'GET required'});
        const period=Number(url.searchParams.get('period')||3600),since=Number(url.searchParams.get('since')||0),limit=Number(url.searchParams.get('limit')||2000),before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER);
        if(![60,3600].includes(period)||!Number.isFinite(since)||!Number.isFinite(before)||!Number.isSafeInteger(limit)||limit<1)return json(res,400,{error:'Bad query'});
        return json(res,200,{schema:1,builds:measurements.builds(),runtime:measurements.runtime,revision:measurements.revision,enabled:measurements.enabled,failures:measurements.failures,rows:measurements.read({period,since,before,limit})});
      }
      if (await mcp.handle(req, res, url)) return;
      if (await agentHTTP.handle(req, res, url)) return;
      if (url.pathname === '/health') return json(res, 200, { ok: true, world: publicWorld(world), peers: actors.size });
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
      let message, newInput = false;
      measurements.record('ws.rx_bytes',raw.length);
      try {
        try { message = JSON.parse(raw.toString()); }
        catch (error) { policy.acceptRequest(); throw error; }
        // Request throttling also consumes a valid stream ordinal, so a 429
        // cannot create a permanent hole in subsequent input sequences.
        newInput = message?.type === 'input' && Number.isSafeInteger(message.sequence) && message.sequence === actor.inputSequence + 1;
        if (newInput) actor.inputSequence = message.sequence;
        policy.acceptRequest();
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new WorldError('BAD_MESSAGE', '잘못된 요청입니다.');
        const mode = message.type === 'input' ? 'cursor'
          : ['move','write','erase'].includes(message.type) || message.type === 'hello' && (message.x !== undefined || message.y !== undefined) ? 'coordinates' : null;
        if (mode) {
          if (actor.inputMode && actor.inputMode !== mode) throw new PolicyError('INPUT_MODE_CONFLICT', '한 연결에서 입력 프로토콜을 혼합할 수 없습니다.', { status: 409 });
          actor.inputMode = mode;
        }
        if (message.type === 'hello') {
          if (actor.hello) return;
          actor.hello = true;
          if (message.view) actor.observer.setView(message.view);
          if (typeof message.name === 'string') peer.name = message.name.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 24) || peer.name;
          if (message.x !== undefined || message.y !== undefined) policy.acceptMove({ x: message.x, y: message.y, epoch: world.epoch });
          presence();
        } else if (message.type === 'telemetry') {
          try {measurements.mergeClient(message,actor);} catch {measurements.record('telemetry.rejected');}
        } else if (message.type === 'input') {
          if (!Number.isSafeInteger(message.sequence) || message.sequence < 1 || message.sequence > actor.inputSequence) {
            throw new PolicyError('BAD_SEQUENCE', '입력 순서를 확인할 수 없습니다.', { status: 409 });
          }
          if (!newInput) {
            send(socket, { type: 'ack', id: message.id, inputSequence: message.sequence, duplicate: true }); return;
          }
          // Every attempt consumes its place in the ordered stream, including
          // a 429. A retry cannot later execute an already refused intention.
          actor.input.cursor = { x: peer.x, y: peer.y };
          let plan;
          const plannedAt = performance.now();
          try { plan = actor.input.plan(message.action, world, world.cells); }
          catch { throw new PolicyError('BAD_INPUT', '네이티브 입력 범위를 확인할 수 없습니다.'); }
          measurements.record('input.plan_ms', performance.now() - plannedAt);
          const result = policy.acceptCursorPlan(plan, `${peer.id}:input:${message.sequence}`);
          actor.input.restore(plan.next.snapshot());
          if (plan.operation) publish(result); else presence();
          measurements.record('input.cursor_actions');
          measurements.record('input.context_entries', actor.input.native.entries.length);
          if (message.epoch !== world.epoch) measurements.record('input.after_resize');
          send(socket, { type: 'ack', id: message.id, inputSequence: message.sequence, epoch: world.epoch, cursor: { x: peer.x, y: peer.y } });
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
        send(socket, { type: 'error', ...errorRecord(error), id: message?.id, requestType: message?.type, cursor: { x: peer.x, y: peer.y },
          ...(message?.type === 'input' ? { inputSequence: actor.inputSequence } : {}) });
        if (error.code === 'STALE_EPOCH' && actor.lastSnapshotEpoch !== world.epoch) scopedUpdate(socket, actor, { snapshot: true, reason: 'stale-epoch' });
      }
    });
    socket.on('close', () => { clients.delete(socket); removeActor(actor); });
    socket.on('error', () => {});
  });
  const sampleMeasurements=()=>{updatePopulation();measurements.sample(world,{peers:actors.size,network_entries:networks.entries.size,waiters:listeners.size,ws_peers:clients.size,http_peers:actors.size-clients.size});};
  const measurementTimer=metricsEnabled?setInterval(()=>{sampleMeasurements();measurements.flush();},60000):null;
  measurementTimer?.unref();
  const heartbeat = setInterval(() => {
    networks.prune();
    for (const [socket, actor] of clients) {
      if (!actor.alive) { socket.terminate(); continue; }
      actor.alive = false; socket.ping();
    }
  }, 15000);
  // Only visible age-band transitions produce packets; no per-frame age updates.
  const aging = setInterval(() => {
    const expirationStarted = performance.now();
    try {
      const deleted = expire(world, publish);
      measurements.record('expiration.deleted_cells', deleted);
      measurements.record('expiration.batch_full', Number(deleted >= 500));
    } catch (error) { console.error('Text expiration failed:', error.message); }
    finally { measurements.record('expiration.ms', performance.now() - expirationStarted); }
    for (const [socket, actor] of clients) if (world.now() >= actor.observer.nextFreshnessAt) scopedUpdate(socket, actor);
    notify();
  }, 5000);
  const adaptation = setInterval(() => {
    const started = performance.now();
    try {
      const result = world.adapt(peers());
      measurements.record('density.actual', result.density);
      measurements.record('density.projected', result.projectedDensity);
      measurements.record('density.target_area', result.targetArea);
      measurements.record('density.net_growth_cells_per_second', Math.max(0,result.netCellsPerSecond));
      measurements.record('density.net_decay_cells_per_second', Math.max(0,-result.netCellsPerSecond));
      measurements.record('density.above_band', Number(result.density > DENSITY.upper));
      measurements.record('density.at_limit', Number(result.reason === 'limit'));
      if (result.changed) {
        const delta=world.width * world.height - result.from.width * result.from.height;
        measurements.record('topology.area_delta', Math.abs(delta));
        measurements.record(delta>0?'topology.growth':'topology.shrink');
      }
      if (result.preservation === 'forced') measurements.record('topology.forced');
      // world.resize atomically remaps actors and publishes the new topology.
    } catch (error) { console.error('Density adaptation failed:', error.message); }
    finally { measurements.record('topology.adapt_ms', performance.now() - started); }
  }, DENSITY.intervalMs);
  return {
    server, world, wss, measurements,
    listen: (port = 3000, host = '0.0.0.0') => new Promise(resolve => server.listen(port, host, () => resolve(server.address()))),
    close: async () => {
      closing = true; clearInterval(measurementTimer); clearInterval(heartbeat); clearInterval(adaptation); clearInterval(aging);
      agentHTTP.close(); await runner.shutdown(); await mcp.close();
      for (const actor of actors) removeActor(actor);
      for (const socket of clients.keys()) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); }
      sampleMeasurements();measurements.close();
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
