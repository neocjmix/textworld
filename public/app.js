import { wrap, cellKey, graphemes, gpsToCell, writePlan } from '/shared/world.js';

const $ = id => document.getElementById(id);
const app = $('app');
const canvas = $('field');
const ctx = canvas.getContext('2d');
const input = $('input');
const baseCell = { width: 24, height: 30 };
let world = null, selfId = null, cells = new Map(), peers = [];
let cursor = { x: 0, y: 0 }, camera = { x: 0, y: 0 };
let zoom = 1, size = { width: 1, height: 1 }, connected = false, socket;
let firstSnapshot = true, frame, reconnectTimer, noticeTimer;
let id = 0, pending = new Map(), navigationRevision = 0, gpsRequest = 0;
let moveTimer, queuedMove, lastSentPosition;
let composing = false, compositionSession = null, compositionTail = null, preedit = '';
let panRemainder = { x: 0, y: 0 };
const pointers = new Map();
let drag = null, pinch = null;

const dimensions = () => ({ width: baseCell.width * zoom, height: baseCell.height * zoom });
const visible = () => {
  const d = dimensions();
  return { cols: size.width / d.width, rows: size.height / d.height };
};
const isDesktop = () => matchMedia('(pointer: fine)').matches;
function notice(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5500);
}
function send(message) {
  if (!connected || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = null; draw(); });
}
// A single invariant governs navigation, writing, zoom and keyboard resizing:
// the active cell's centre is always the visible map's centre.
function center() {
  if (!world) return;
  const v = visible();
  camera = { x: cursor.x + .5 - v.cols / 2, y: cursor.y + .5 - v.rows / 2 };
  $('coordinates').textContent = `${cursor.x}, ${cursor.y}`;
  schedule();
}
function cancelMove() {
  clearTimeout(moveTimer);
  moveTimer = null;
  queuedMove = null;
}
function queueMove() {
  queuedMove = { type: 'move', ...cursor, epoch: world.epoch };
  if (moveTimer) return;
  moveTimer = setTimeout(() => {
    moveTimer = null;
    const next = queuedMove;
    queuedMove = null;
    if (next && JSON.stringify(next) !== lastSentPosition && send(next)) {
      lastSentPosition = JSON.stringify(next);
    }
  }, 40);
}
function cancelComposition() {
  if (composing || compositionSession) {
    compositionSession = null;
    preedit = '';
    input.value = '';
    schedule();
  }
}
function move(x, y, { manual = true, resetPan = true } = {}) {
  if (!world) return;
  const next = { x: wrap(x, world.width), y: wrap(y, world.height) };
  if (next.x !== cursor.x || next.y !== cursor.y) cancelComposition();
  cursor = next;
  if (manual) navigationRevision++;
  if (resetPan) panRemainder = { x: 0, y: 0 };
  center();
  queueMove();
}
function pan(dx, dy) {
  if (!world) return;
  const d = dimensions();
  panRemainder.x += dx / d.width;
  panRemainder.y += dy / d.height;
  const x = Math.trunc(panRemainder.x), y = Math.trunc(panRemainder.y);
  if (!x && !y) return;
  panRemainder.x -= x;
  panRemainder.y -= y;
  move(cursor.x + x, cursor.y + y, { resetPan: false });
}
function setZoom(value) {
  zoom = Math.min(2, Math.max(.6, value));
  const d = dimensions();
  app.style.setProperty('--cell-width', `${d.width}px`);
  app.style.setProperty('--cell-height', `${d.height}px`);
  $('zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  $('zoom-out').disabled = zoom <= .6;
  $('zoom-in').disabled = zoom >= 2;
  panRemainder = { x: 0, y: 0 };
  center();
}
function paintCursor(peer, x, y, d) {
  const own = peer.id === selfId, color = own ? '#287054' : peer.color || '#b17640';
  ctx.fillStyle = color;
  ctx.globalAlpha = own ? .1 : .15;
  ctx.fillRect(x + 1, y + 1, d.width - 2, d.height - 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = own ? 2 : 1.5;
  ctx.strokeRect(x + 1, y + 1, d.width - 2, d.height - 2);
  ctx.fillRect(x + 2, y + d.height - 4, d.width - 4, 2);
  if (!own) {
    ctx.font = '10px Arial';
    const label = peer.name || '방문자', width = ctx.measureText(label).width + 8;
    ctx.fillRect(x, y - 15, width, 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 4, y - 4);
  }
}
function paintText(text, x, y, d, preview = false) {
  ctx.fillStyle = preview ? '#287054' : '#314137';
  ctx.font = `${Math.round(17 * zoom)}px ui-monospace, "Apple SD Gothic Neo", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + d.width / 2, y + d.height / 2 + 1, d.width - 3);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
function draw() {
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.fillStyle = '#f8f8f2';
  ctx.fillRect(0, 0, size.width, size.height);
  if (!world) return;
  const d = dimensions(), v = visible();
  const startX = Math.floor(camera.x), startY = Math.floor(camera.y);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#e3e8dd';
  ctx.beginPath();
  for (let x = startX; x <= camera.x + v.cols; x++) {
    const px = (x - camera.x) * d.width;
    ctx.moveTo(px + .5, 0); ctx.lineTo(px + .5, size.height);
  }
  for (let y = startY; y <= camera.y + v.rows; y++) {
    const py = (y - camera.y) * d.height;
    ctx.moveTo(0, py + .5); ctx.lineTo(size.width, py + .5);
  }
  ctx.stroke();
  for (let y = startY; y <= camera.y + v.rows; y++) {
    for (let x = startX; x <= camera.x + v.cols; x++) {
      const wx = wrap(x, world.width), wy = wrap(y, world.height);
      const px = (x - camera.x) * d.width, py = (y - camera.y) * d.height;
      if (wx === 0 || wy === 0) {
        ctx.strokeStyle = '#b7c9b3'; ctx.setLineDash([3, 5]); ctx.beginPath();
        if (wx === 0) { ctx.moveTo(px, py); ctx.lineTo(px, py + d.height); }
        if (wy === 0) { ctx.moveTo(px, py); ctx.lineTo(px + d.width, py); }
        ctx.stroke(); ctx.setLineDash([]);
      }
      const cell = cells.get(cellKey(wx, wy));
      if (cell?.text) paintText(cell.text, px, py, d);
    }
  }
  for (const peer of peers) {
    if (peer.id === selfId) continue;
    for (let y = startY; y <= camera.y + v.rows; y++) {
      if (wrap(y, world.height) !== peer.y) continue;
      for (let x = startX; x <= camera.x + v.cols; x++) {
        if (wrap(x, world.width) === peer.x) paintCursor(peer, (x - camera.x) * d.width, (y - camera.y) * d.height, d);
      }
    }
  }
  const cx = (size.width - d.width) / 2, cy = (size.height - d.height) / 2;
  if (preedit) {
    // Native IME owns composition; only the local preview is painted here.
    ctx.fillStyle = '#f8f8f2';
    ctx.fillRect(cx + 1, cy + 1, d.width - 2, d.height - 2);
    paintText(graphemes(preedit)[0] || '', cx, cy, d, true);
  }
  paintCursor({ id: selfId }, cx, cy, d);
}
function resizeCanvas() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  size = { width: r.width, height: r.height };
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  center(); schedule();
}
function fitVisualViewport() {
  const v = window.visualViewport;
  app.style.setProperty('--app-width', `${v?.width || window.innerWidth}px`);
  app.style.setProperty('--app-height', `${v?.height || window.innerHeight}px`);
  app.style.setProperty('--app-top', `${v?.offsetTop || 0}px`);
  app.style.setProperty('--app-left', `${v?.offsetLeft || 0}px`);
  app.style.width = `${v?.width || window.innerWidth}px`;
  app.style.height = `${v?.height || window.innerHeight}px`;
  app.style.left = `${v?.offsetLeft || 0}px`;
  app.style.top = `${v?.offsetTop || 0}px`;
}
new ResizeObserver(resizeCanvas).observe($('viewport'));
window.addEventListener('resize', fitVisualViewport);
window.visualViewport?.addEventListener('resize', fitVisualViewport);
window.visualViewport?.addEventListener('scroll', fitVisualViewport);
fitVisualViewport();

function focusInput() {
  if (connected && !$('help').open) input.focus({ preventScroll: true });
}
function write(text) {
  if (!connected || !world) { notice('연결 후 다시 입력해 주세요.'); return; }
  text = text.replace(/\r\n?/g, '\n');
  if (!text) return;
  if (text.length > 4096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text) || graphemes(text).length > 512) {
    notice('한 번에 512자까지 입력할 수 있습니다. 제어 문자는 지원하지 않습니다.'); return;
  }
  cancelMove(); lastSentPosition = null;
  const opId = `${selfId}:${++id}`, end = writePlan(text, cursor.x, cursor.y, world).cursor;
  if (send({ type: 'write', id: opId, epoch: world.epoch, ...cursor, text })) {
    pending.set(opId, text); cursor = end; navigationRevision++;
    panRemainder = { x: 0, y: 0 }; center();
  }
}
function erase(backward) {
  if (!connected || !world) return;
  if (backward) move(cursor.x - 1, cursor.y);
  cancelMove(); lastSentPosition = null;
  const opId = `${selfId}:${++id}`;
  pending.set(opId, '');
  send({ type: 'erase', id: opId, epoch: world.epoch, ...cursor });
}
function resetComposition() {
  composing = false; compositionSession = null; compositionTail = null; preedit = ''; input.value = '';
}
input.addEventListener('compositionstart', () => {
  composing = true; compositionTail = null;
  compositionSession = { epoch: world?.epoch };
});
input.addEventListener('compositionupdate', event => {
  if (compositionSession) { preedit = event.data || ''; schedule(); }
});
input.addEventListener('compositionend', event => {
  composing = false;
  const text = input.value || event.data || '';
  if (compositionSession && compositionSession.epoch === world?.epoch) write(text);
  else notice('위치가 바뀌어 조합을 취소했습니다. 중심 칸에 다시 입력해 주세요.');
  compositionSession = null; preedit = ''; input.value = ''; compositionTail = text;
  schedule(); setTimeout(() => { compositionTail = null; }, 0);
});
input.addEventListener('beforeinput', event => {
  if (composing || event.isComposing || !event.cancelable) return;
  if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
    event.preventDefault(); erase(event.inputType === 'deleteContentBackward');
  }
});
input.addEventListener('input', event => {
  if (composing || event.isComposing) {
    if (compositionSession) preedit = input.value;
    schedule(); return;
  }
  if (compositionTail !== null && (event.inputType === 'insertCompositionText' || event.inputType === 'insertFromComposition' || event.data === compositionTail)) {
    input.value = ''; compositionTail = null; return;
  }
  if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
    erase(event.inputType === 'deleteContentBackward'); input.value = ''; return;
  }
  write(input.value); input.value = '';
});
input.addEventListener('keydown', event => {
  if (event.isComposing || composing || event.keyCode === 229) return;
  if (!world || event.metaKey || event.ctrlKey || event.altKey) return;
  const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (delta) { event.preventDefault(); move(cursor.x + delta[0], cursor.y + delta[1]); }
  else if (event.key === 'Enter') { event.preventDefault(); move(cursor.x, cursor.y + 1); }
  else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); erase(event.key === 'Backspace'); }
  else if (event.key === 'Escape') { event.preventDefault(); cancelComposition(); input.blur(); }
});
input.addEventListener('paste', event => {
  if (composing) return;
  event.preventDefault(); write(event.clipboardData.getData('text/plain'));
});
document.addEventListener('keydown', event => {
  if ((event.target === document.body || event.target === canvas) && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key.length === 1 || event.key === 'Process')) focusInput();
});

function distance() {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
canvas.addEventListener('pointerdown', event => {
  if (!world) return;
  // Keep touch's compatibility mousedown from blurring the native input after pointerup.
  event.preventDefault();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  canvas.setPointerCapture(event.pointerId);
  if (pointers.size === 1) drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
  else { pinch = { distance: distance(), zoom }; if (drag) drag.moved = true; }
});
canvas.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size > 1) {
    if (pinch?.distance) setZoom(pinch.zoom * distance() / pinch.distance);
    return;
  }
  if (!drag || drag.id !== event.pointerId) return;
  const totalX = event.clientX - drag.startX, totalY = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(totalX, totalY) > 6) {
    drag.moved = true; pan(-totalX, -totalY);
  } else if (drag.moved) pan(drag.x - event.clientX, drag.y - event.clientY);
  drag.x = event.clientX; drag.y = event.clientY;
});
function endPointer(event, cancelled = false) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (!cancelled && drag?.id === event.pointerId && !drag.moved && !pinch) focusInput();
  if (pointers.size === 1) {
    const [key, p] = [...pointers.entries()][0];
    drag = { id: key, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: true };
  } else if (!pointers.size) { drag = null; pinch = null; }
}
canvas.addEventListener('pointerup', event => endPointer(event));
canvas.addEventListener('pointercancel', event => endPointer(event, true));
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  if (!world) return;
  if (event.ctrlKey || event.metaKey) { setZoom(zoom * (event.deltaY > 0 ? .9 : 1.1)); return; }
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
  pan((event.shiftKey ? event.deltaY : event.deltaX) * factor, (event.shiftKey ? 0 : event.deltaY) * factor);
}, { passive: false });
function restorePointerTyping(event) {
  // Mouse-operated controls return to map typing; keyboard Tab users keep button focus.
  if (event.detail > 0 && isDesktop()) focusInput();
}
$('zoom-out').onclick = event => { setZoom(zoom - .2); restorePointerTyping(event); };
$('zoom-in').onclick = event => { setZoom(zoom + .2); restorePointerTyping(event); };
$('help-toggle').onclick = () => {
  cancelComposition(); input.blur();
  $('help').showModal(); $('help-toggle').setAttribute('aria-expanded', 'true');
};
$('help-close').onclick = () => $('help').close();
$('help').addEventListener('close', () => {
  $('help-toggle').setAttribute('aria-expanded', 'false');
  if (isDesktop()) focusInput();
});
async function locate(initial = false) {
  if (!world) return;
  const request = ++gpsRequest, revision = navigationRevision;
  if (!navigator.geolocation) { notice('GPS를 사용할 수 없어 함께 만나는 자리에서 시작합니다.'); return; }
  if (!initial) notice('현재 GPS 위치를 찾고 있습니다.');
  navigator.geolocation.getCurrentPosition(result => {
    if (request !== gpsRequest || (initial && revision !== navigationRevision)) return;
    const point = gpsToCell(result.coords.latitude, result.coords.longitude, world);
    move(point.x, point.y, { manual: false });
    notice('GPS에 해당하는 위치입니다. 중심 칸에 바로 입력하세요.');
  }, () => {
    if (request === gpsRequest && !initial) notice('GPS 위치를 얻지 못했습니다. 지도에서 이동해 주세요.');
  }, { enableHighAccuracy: false, timeout: 8000, maximumAge: initial ? 60000 : 0 });
}
$('gps').onclick = event => { locate(); restorePointerTyping(event); };
$('share').onclick = async event => {
  if (!world) return;
  const url = new URL(location.href); url.hash = new URLSearchParams(cursor).toString();
  try { await navigator.clipboard.writeText(url.href); notice('이 위치의 링크를 복사했습니다.'); }
  catch { history.replaceState(null, '', url); notice('주소창에 위치를 담았습니다. 주소를 복사해 주세요.'); }
  restorePointerTyping(event);
};
function connection(value) {
  connected = value; input.disabled = !value;
  $('connection').textContent = value ? '실시간 연결' : '재연결 중';
  $('connection-dot').classList.toggle('online', value);
}
function goToHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const x = Number(params.get('x')), y = Number(params.get('y'));
  if (world && params.has('x') && params.has('y') && Number.isSafeInteger(x) && Number.isSafeInteger(y)) {
    move(x, y); return true;
  }
  return false;
}
function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') {
      const wasConnected = connected, previousCursor = { ...cursor }, oldEpoch = world?.epoch;
      cancelMove(); lastSentPosition = null; world = message.world; selfId = message.selfId;
      cells = new Map(message.cells.filter(c => c.text).map(c => [cellKey(c.x, c.y), c]));
      peers = message.peers;
      const me = peers.find(p => p.id === selfId);
      cursor = me ? { x: me.x, y: me.y } : { x: 0, y: 0 };
      if (pending.size) { notice('세계를 갱신했습니다. 전송 중이던 글자를 확인해 주세요.'); pending.clear(); }
      resetComposition(); connection(true);
      if (firstSnapshot) {
        firstSnapshot = false;
        if (!goToHash()) locate(true);
        notice(isDesktop() ? '지도를 움직여 자리를 고르고, 바로 입력하세요.' : '지도를 움직여 자리를 고르고, 탭해서 입력하세요.');
        if (isDesktop()) focusInput();
      } else if (!wasConnected) {
        move(previousCursor.x, previousCursor.y, { manual: false });
        notice('다시 연결했습니다. 이전 위치에서 계속하세요.');
      } else if (oldEpoch !== world.epoch) notice('세계의 크기가 바뀌었습니다.');
      center();
      if (!wasConnected && isDesktop()) focusInput();
    } else if (message.type === 'cells') {
      if (message.epoch !== world?.epoch) return;
      for (const c of message.cells) {
        if (c.text) cells.set(cellKey(c.x, c.y), c); else cells.delete(cellKey(c.x, c.y));
      }
      schedule();
    } else if (message.type === 'presence') { peers = message.peers; schedule(); }
    else if (message.type === 'ack') pending.delete(message.id);
    else if (message.type === 'error') {
      pending.delete(message.id);
      if (message.code !== 'STALE_EPOCH') send({ type: 'sync' });
      notice(`입력 미반영: ${message.message}`);
    }
    $('population').textContent = `${peers.length}명 함께`;
  };
  socket.onclose = () => {
    cancelMove(); connection(false); resetComposition(); schedule();
    notice(pending.size ? '연결이 끊겼습니다. 전송 중이던 글자는 다시 연결한 뒤 확인해 주세요.' : '다시 연결하고 있습니다.');
    pending.clear(); clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1000);
  };
  socket.onerror = () => socket.close();
}
window.addEventListener('hashchange', goToHash);
setZoom(1);
connect();
// Read-only browser diagnostics for verifying spatial invariants.
window.textworld = { inspect: () => ({ world, cursor: { ...cursor }, camera: { ...camera }, viewport: visible(), peers: structuredClone(peers), cells: [...cells.values()], connected, pending: pending.size, zoom, composing, preedit }) };
