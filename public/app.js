import { createBrowserMeasurements } from './measurements.js';
import { wrap, cellKey, graphemes, graphemeWidth, gpsToCell } from '/shared/world.js';
import { WritingSession } from '/shared/writing.js';
import { freshnessStyle } from '/shared/freshness.js';
import { VIEW_LIMITS } from '/shared/participant-rules.js';
import { NativeProjection } from '/shared/native-projection.js';
import { createPanMotion } from './inertia.js';
import { createNativeInput } from './native-input.js';
import { projectLocalCells } from './local-world.js';
import { createNativeSurface } from './native-surface.js';
import { createCameraMotion } from './camera-motion.js';

const $ = id => document.getElementById(id);
const app = $('app');
const canvas = $('field');
const ctx = canvas.getContext('2d');
const input = $('input');
const nativeSurface = createNativeSurface(input);
const baseCell = { width: 9, height: 26 };
try {
  if (!sessionStorage.getItem('textworld-intro-seen')) {
    sessionStorage.setItem('textworld-intro-seen', '1');
    const intro = $('intro'); intro.hidden = false;
    intro.addEventListener('animationend', () => { intro.hidden = true; }, { once: true });
  }
} catch { /* Storage can be unavailable in private contexts. */ }
const mapFont = '"Textworld Sarasa"';
const glyphWidths = new Map();
let fontReady = false;
let world = null, selfId = null, cells = new Map(), peers = [];
let localCells = new Map(), freshnessMarks = new Map(), freshnessBands = {}, colorBands = {};
let observedView = null, viewRevision = 0, sentView = '', viewTimer, recoveryTimer;
let cursor = { x: 0, y: 0 }, camera = { x: 0, y: 0 };
let cameraAnchor = null, cameraEpoch = null;
let viewportOrigin = { x: 0, y: 0 };
const writing = new WritingSession(cursor);
const nativeProjection = new NativeProjection(cursor);
let nativeTrailBase = [];
let zoom = 1, size = { width: 1, height: 1 }, connected = false, socket;
let firstSnapshot = true, frame, reconnectTimer, noticeTimer;
let id = 0, pending = new Map(), navigationRevision = 0, gpsRequest = 0;
let moveTimer, queuedMove, lastSentPosition;
let composing = false, preedit = '', nativeInput, applyingNativeEdit = false;
let preeditRange = null;
let panRemainder = { x: 0, y: 0 };
const pointers = new Map();
let drag = null, pinch = null;
let dragCameraOffset = null;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const cameraMotion = createCameraMotion({ reducedMotion, onUpdate(position) {
  camera = position;
  updateCursorSurface();
  // Camera, native surface and shared text must move in the same frame.
  if (frame) { cancelAnimationFrame(frame); frame = null; }
  draw();
} });
const motion = createPanMotion({ pan, reducedMotion, onRest: () => center() });

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
const browserMeasurements = createBrowserMeasurements(send);
setInterval(()=>{if(connected)browserMeasurements.flush();},60000);
function schedule() {
  if (frame || cameraMotion.active) return;
  frame = requestAnimationFrame(() => { frame = null; draw(); });
}
function refreshLocalCells() {
  localCells = world ? projectLocalCells(cells, pending.values(), world) : cells;
  schedule();
}
function requestedView() {
  const v = visible();
  // A small margin keeps a smoothly moving camera covered. The server applies
  // the same maximum rectangle to every participant, regardless of transport.
  let cols = Math.min(VIEW_LIMITS.maxCols, Math.ceil(v.cols) + 8);
  let rows = Math.min(VIEW_LIMITS.maxRows, Math.ceil(v.rows * 1.14) + 4);
  if (cols * rows > VIEW_LIMITS.maxArea) {
    const scale = Math.sqrt(VIEW_LIMITS.maxArea / (cols * rows));
    cols = Math.max(1, Math.floor(cols * scale));
    rows = Math.max(1, Math.floor(rows * scale));
  }
  return { cols, rows };
}
function reportView({ immediate = false, force = false } = {}) {
  clearTimeout(viewTimer);
  const report = () => {
    viewTimer = null;
    const view = requestedView(), encoded = JSON.stringify(view);
    if ((force || encoded !== sentView) && send({ type: 'view', ...view })) sentView = encoded;
  };
  if (immediate) report(); else viewTimer = setTimeout(report, 100);
}
function flushMove() {
  clearTimeout(moveTimer); moveTimer = null;
  const next = queuedMove; queuedMove = null;
  if (next && JSON.stringify(next) !== lastSentPosition && send(next)) lastSentPosition = JSON.stringify(next);
}
function submit(operation) {
  // Navigation and typing share one ordered stream. A delayed scroll frame
  // must reach the server before the edit whose origin it established.
  flushMove();
  const message = { ...operation, layout: 2, id: `${selfId}:${++id}`, epoch: world.epoch };
  if (!send(message)) return false;
  browserMeasurements.begin(message.id);
  pending.set(message.id, message);
  refreshLocalCells();
  return true;
}
const shortest = (distance, extent) => wrap(distance + extent / 2, extent) - extent / 2;
function center({ immediate = false, residual = false, direct = false, timeConstant = 80, viewportChange = false } = {}) {
  if (!world) return;
  const v = visible(), d = dimensions();
  const cursorElement = $('cursor');
  const previousRect = cameraAnchor && !cursorElement.hidden ? cursorElement.getBoundingClientRect() : null;
  const previousAnchor = cameraAnchor ? { ...cameraAnchor } : null;
  if (!cameraAnchor || cameraEpoch !== world.epoch) {
    cameraAnchor = { ...cursor }; cameraEpoch = world.epoch; immediate = true;
  } else {
    cameraAnchor.x += shortest(cursor.x - wrap(cameraAnchor.x, world.width), world.width);
    cameraAnchor.y += shortest(cursor.y - wrap(cameraAnchor.y, world.height), world.height);
  }
  const target = { x: cameraAnchor.x + .5 - v.cols / 2 + (residual ? panRemainder.x : 0),
    y: cameraAnchor.y + .5 - v.rows * .43 + (residual ? panRemainder.y : 0) };
  if (direct && dragCameraOffset) { target.x += dragCameraOffset.x; target.y += dragCameraOffset.y; }
  // Large teleports must not leave the actual writing position off-screen.
  const px = (cameraAnchor.x + .5 - camera.x) * d.width;
  const py = (cameraAnchor.y + .5 - camera.y) * d.height;
  if (viewportChange && !immediate) {
    // When a keyboard covers the old cursor, move only as far as necessary to
    // keep that cell visible. The remaining trip to the centre stays animated.
    const clamp = (value, span, margin) => Math.max(margin, Math.min(span - margin, value));
    const shiftX = px - clamp(px, size.width, d.width / 2);
    const shiftY = py - clamp(py, size.height, d.height / 2);
    if (shiftX || shiftY) cameraMotion.jump({ x: camera.x + shiftX / d.width, y: camera.y + shiftY / d.height });
  } else if (px < d.width || px > size.width - d.width || py < d.height || py > size.height - d.height) immediate = true;
  cameraMotion.setTarget(target, { immediate, scale: { x: d.width, y: d.height }, timeConstant });
  if (cameraMotion.active && frame) { cancelAnimationFrame(frame); frame = null; }
  updateCursorSurface();
  if ((!direct && immediate) || composing || reducedMotion()) {
    for (const animation of cursorElement.getAnimations()) animation.cancel();
  }
  // Animate the marker's displacement independently of the logical cell and
  // camera. The native input and authoritative position remain immediate.
  if (previousRect && previousAnchor && (direct || !immediate) && !composing && !reducedMotion()
      && (direct || previousAnchor.x !== cameraAnchor.x || previousAnchor.y !== cameraAnchor.y)) {
    for (const animation of cursorElement.getAnimations()) animation.cancel();
    const nextRect = cursorElement.getBoundingClientRect();
    const dx = previousRect.left - nextRect.left, dy = previousRect.top - nextRect.top;
    if (Math.hypot(dx, dy) > .1 && Math.hypot(dx, dy) < Math.max(size.width, size.height) / 2) {
      cursorElement.animate([
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))` },
        { transform: 'translate(-50%, -50%)' },
      ], { duration: direct ? 80 : 120, easing: 'ease-out' });
    }
  }
}
function updateCursorSurface() {
  if (!cameraAnchor) return;
  const d = dimensions();
  app.style.setProperty('--cursor-x', `${(cameraAnchor.x + .5 - camera.x) * d.width}px`);
  app.style.setProperty('--cursor-y', `${(cameraAnchor.y + .5 - camera.y) * d.height}px`);
  updateNativeSurface();
}
function updateNativeSurface() {
  if (!world || !preedit || !preeditRange) { nativeSurface.hide(); return; }
  const d = dimensions();
  let anchor;
  try { anchor = nativeProjection.rangePoint(preeditRange.start, preeditRange.end); }
  catch { nativeSurface.hide(); return; }
  nativeSurface.show({ start: preeditRange.start, end: preeditRange.start + preedit.length,
    x: (cameraAnchor.x + shortest(anchor.x - cursor.x, world.width) - camera.x) * d.width,
    y: (cameraAnchor.y + shortest(anchor.y - cursor.y, world.height) - camera.y) * d.height,
    cellHeight: d.height, fontSize: 18 * zoom });
}
function cancelMove() {
  clearTimeout(moveTimer);
  moveTimer = null;
  queuedMove = null;
}
function stopPan() {
  const displaced = motion.active || panRemainder.x || panRemainder.y;
  motion.cancel(); panRemainder = { x: 0, y: 0 };
  if (displaced) center();
}
function grabCamera() {
  cameraMotion.cancel();
  const v = visible();
  dragCameraOffset = cameraAnchor ? {
    x: camera.x - (cameraAnchor.x + .5 - v.cols / 2 + panRemainder.x),
    y: camera.y - (cameraAnchor.y + .5 - v.rows * .43 + panRemainder.y),
  } : { x: 0, y: 0 };
}
function queueMove(intent) {
  queuedMove = { type: 'move', ...cursor, epoch: world.epoch, ...(intent ? { intent } : {}) };
  if (moveTimer) return;
  moveTimer = setTimeout(flushMove, 40);
}
function cancelComposition() {
  if (applyingNativeEdit) return;
  nativeInput?.cancel();
  preedit = ''; preeditRange = null;
  schedule();
}
function move(x, y, { manual = true, resetPan = true, newOrigin = true, caret = false, preserveMotion = false, cameraImmediate = false, panView = false } = {}) {
  if (!world) return;
  if (!preserveMotion) motion.cancel();
  const next = { x: wrap(x, world.width), y: wrap(y, world.height) };
  // A new navigation context resets both the native DOM and its spatial ledger,
  // even when a hash/GPS target wraps back onto the current address.
  cancelComposition();
  cursor = next;
  if (newOrigin) writing.reset(cursor);
  else if (caret) writing.reposition(cursor);
  if (!applyingNativeEdit) resetNativeProjection();
  if (manual) navigationRevision++;
  if (resetPan) panRemainder = { x: 0, y: 0 };
  center({ immediate: cameraImmediate, residual: panView, direct: panView && cameraImmediate, timeConstant: panView ? 50 : 80 });
  queueMove();
}
function pan(dx, dy) {
  if (!world) return;
  if (composing || nativeInput?.text) cancelComposition();
  const d = dimensions();
  panRemainder.x += dx / d.width;
  panRemainder.y += dy / d.height;
  // Smoothed wheel deltas can sum to 0.9999999999999998 columns.
  // Preserve a complete supplied cell step without losing it to float noise.
  const step = value => Math.trunc(value + Math.sign(value) * 1e-9);
  const x = step(panRemainder.x), y = step(panRemainder.y);
  const direct = !!drag?.moved && pointers.size === 1;
  if (!x && !y) { center({ immediate: direct, residual: true, direct, timeConstant: 50 }); return; }
  panRemainder.x -= x;
  panRemainder.y -= y;
  move(cursor.x + x, cursor.y + y, { resetPan: false, preserveMotion: true, cameraImmediate: direct, panView: true });
}
function setZoom(value) {
  motion.cancel();
  zoom = Math.min(2, Math.max(.6, value));
  const d = dimensions();
  app.style.setProperty('--cell-width', `${d.width}px`);
  app.style.setProperty('--cell-height', `${d.height}px`);
  input.style.fontSize = `${18 * zoom}px`;
  input.style.lineHeight = `${d.height}px`;
  panRemainder = { x: 0, y: 0 };
  center({ immediate: true });
  reportView();
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
function paintText(text, x, y, d, columns, fonts) {
  // Sarasa Fixed has genuine 1:2 advances; do not squeeze proportional glyphs.
  // Old one-column records retain their footprint at a smaller point size.
  let width = columns;
  if (columns === 1) {
    width = glyphWidths.get(text);
    if (width === undefined) {
      width = graphemeWidth(text);
      if (glyphWidths.size >= 4096) glyphWidths.delete(glyphWidths.keys().next().value);
      glyphWidths.set(text, width);
    }
  }
  const font = width > columns ? fonts.compact : fonts.normal;
  if (fonts.current !== font) { ctx.font = font; fonts.current = font; }
  ctx.fillText(text, x + d.width * columns / 2, y + d.height / 2 + 1);
}
function draw() {
  const drawStarted=performance.now();let drawnGlyphs=0;
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.fillStyle = '#f8f8f2';
  ctx.fillRect(0, 0, size.width, size.height);
  if (!world) return;
  const d = dimensions(), v = visible();
  const startX = Math.floor(camera.x), startY = Math.floor(camera.y);
  // A square dot pattern in map pixels, anchored to the moving world rather
  // than the viewport. Text cells themselves remain 9 × 26 at 100% zoom.
  const dotSpacing = 26 * zoom, dotSize = Math.max(1, 1.3 * zoom);
  const originX = camera.x * d.width, originY = camera.y * d.height;
  ctx.fillStyle = '#c4cdc0';
  for (let y = Math.floor(originY / dotSpacing) * dotSpacing; y <= originY + size.height; y += dotSpacing) {
    for (let x = Math.floor(originX / dotSpacing) * dotSpacing; x <= originX + size.width; x += dotSpacing) {
      ctx.fillRect(x - originX - dotSize / 2, y - originY - dotSize / 2, dotSize, dotSize);
    }
  }
  ctx.fillStyle = '#314137';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fonts = { normal: `${18 * zoom}px ${mapFont}`, compact: `${9 * zoom}px ${mapFont}`, current: null };
  for (let y = startY; y <= camera.y + v.rows; y++) {
    // Include a lead just off-screen when its second column is visible.
    for (let x = startX - 1; x <= camera.x + v.cols; x++) {
      const wx = wrap(x, world.width), wy = wrap(y, world.height);
      const px = (x - camera.x) * d.width, py = (y - camera.y) * d.height;
      const cell = localCells.get(cellKey(wx, wy));
      if (observedView && !cell && (wrap(wx - observedView.x, world.width) >= observedView.cols
        || wrap(wy - observedView.y, world.height) >= observedView.rows)) {
        // Unobserved space is distinct from a confirmed empty cell, including
        // the edge revealed briefly while the camera or network catches up.
        ctx.fillStyle = '#dfe4dc';
        ctx.fillRect(px + 1, py + 1, d.width - 1, d.height - 1);
        ctx.fillStyle = '#314137';
      }
      if (cell?.text) {
        const local = typeof cell.version === 'string';
        const style = freshnessStyle(local ? 'now' : freshnessBands[cell.version]);
        ctx.globalAlpha = style.opacity;
        ctx.fillStyle = local ? (peers.find(peer => peer.id === selfId)?.color || '#314137') : (colorBands[cell.version] || '#314137');
        paintText(cell.text, px, py, d, cell.width || 1, fonts); drawnGlyphs++;
        ctx.globalAlpha = 1;
      }
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const peer of peers) {
    if (peer.id === selfId) continue;
    for (let y = startY; y <= camera.y + v.rows; y++) {
      if (wrap(y, world.height) !== peer.y) continue;
      for (let x = startX; x <= camera.x + v.cols; x++) {
        if (wrap(x, world.width) === peer.x) paintCursor(peer, (x - camera.x) * d.width, (y - camera.y) * d.height, d);
      }
    }
  }
  browserMeasurements.draw(drawStarted,Math.ceil(v.cols)*Math.ceil(v.rows),drawnGlyphs);
  // Native composition and the actual cursor share the camera's transform.
}
function resizeCanvas() {
  motion.cancel();
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  size = { width: r.width, height: r.height };
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  center({ timeConstant: 110, viewportChange: true }); draw();
  reportView();
}
function fitVisualViewport() {
  const v = window.visualViewport;
  const origin = { x: v?.offsetLeft || 0, y: v?.offsetTop || 0 };
  const offset = { x: origin.x - viewportOrigin.x, y: origin.y - viewportOrigin.y };
  viewportOrigin = origin;
  app.style.setProperty('--app-width', `${v?.width || window.innerWidth}px`);
  app.style.setProperty('--app-height', `${v?.height || window.innerHeight}px`);
  app.style.setProperty('--app-top', `${v?.offsetTop || 0}px`);
  app.style.setProperty('--app-left', `${v?.offsetLeft || 0}px`);
  app.style.width = `${v?.width || window.innerWidth}px`;
  app.style.height = `${v?.height || window.innerHeight}px`;
  app.style.left = `${v?.offsetLeft || 0}px`;
  app.style.top = `${v?.offsetTop || 0}px`;
  if (world && cameraAnchor && (offset.x || offset.y)) {
    const d = dimensions();
    // Keep the same world pixels on screen while the browser pans its visible
    // viewport around the keyboard, then gently return toward its new centre.
    cameraMotion.jump({ x: camera.x + offset.x / d.width, y: camera.y + offset.y / d.height });
    center({ timeConstant: 110, viewportChange: true });
  }
}
new ResizeObserver(resizeCanvas).observe($('viewport'));
window.addEventListener('resize', fitVisualViewport);
window.visualViewport?.addEventListener('resize', fitVisualViewport);
window.visualViewport?.addEventListener('scroll', fitVisualViewport);
fitVisualViewport();

function focusInput() {
  if (connected) input.focus({ preventScroll: true });
}
function resetNativeProjection() {
  nativeProjection.reset(cursor);
  nativeTrailBase = writing.trail.slice();
}
function write(text) {
  stopPan();
  if (!connected || !world || socket.readyState !== WebSocket.OPEN) { notice('연결 후 다시 입력해 주세요.'); return false; }
  text = text.replace(/\r\n?/g, '\n');
  if (!text) return true;
  if (text.length > 4096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text) || graphemes(text.replace(/\t/g, '    ')).length > 64) {
    notice('한 번에 64자까지 확정할 수 있습니다. 긴 글은 나누어 입력해 주세요.'); return false;
  }
  const plan = writing.plan(text, cursor, world);
  // Returns move presence; they do not create blank characters or database edits.
  if (!plan.cells.length) {
    writing.accept(plan);
    move(plan.cursor.x, plan.cursor.y, { newOrigin: false });
    return true;
  }
  if (submit({ type: 'write', ...cursor, text, lineStartX: writing.lineStartX })) {
    lastSentPosition = null;
    writing.accept(plan);
    cursor = plan.cursor; navigationRevision++;
    panRemainder = { x: 0, y: 0 }; center();
    return true;
  }
  return false;
}
function erase(backward) {
  stopPan();
  if (!connected || !world || socket.readyState !== WebSocket.OPEN) return;
  flushMove();
  if (backward) {
    const action = writing.backspace(cursor, world, localCells);
    move(action.cursor.x, action.cursor.y, { newOrigin: false });
    if (!action.erase) return;
  }
  cancelMove(); lastSentPosition = null;
  submit({ type: 'erase', ...cursor, ...(backward ? { intent: 'backspace' } : {}) });
}
function unsupportedInput(type) {
  const message = type === 'selection'
    ? '세계의 범위 선택·복사·잘라내기는 아직 지원하지 않습니다.'
    : type === 'lineEnd'
      ? '이 공간에는 정해진 줄 끝이 없습니다. 방향키로 위치를 고르세요.'
      : /^history/.test(type)
        ? '공유 글의 실행 취소·다시 실행은 아직 지원하지 않습니다. 칸을 골라 수정해 주세요.'
        : type === 'navigation'
          ? '지도 이동은 방향키·Home 또는 스크롤을 사용해 주세요.'
        : /^format/.test(type)
          ? '이 지도는 글자만 입력할 수 있습니다. 서식은 지원하지 않습니다.'
          : '입력 범위를 확인할 수 없습니다. 지도에서 자리를 다시 고른 뒤 입력해 주세요.';
  notice(message);
}
function resetComposition() {
  nativeInput?.reset();
  composing = false; preedit = ''; preeditRange = null;
}
nativeInput = createNativeInput(input, {
  onEdit(edit) {
    stopPan();
    if (!connected || !world || socket.readyState !== WebSocket.OPEN) return false;
    let plan;
    try { plan = nativeProjection.plan(edit, cursor, world, { lineStartX: writing.lineStartX }); }
    catch { return false; }
    // Native UTF-16 ranges are projected once, then committed atomically.
    // No key-code assembly, native-string normalization, or tail guessing.
    if (plan.text.length > 4096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(plan.text)
      || graphemes(plan.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')).length > 64 || plan.clear.length > 128) {
      notice('한 번에 64자까지 확정하거나 바꿀 수 있습니다. 긴 글은 나누어 입력해 주세요.');
      return false;
    }
    applyingNativeEdit = true;
    try {
      flushMove(); lastSentPosition = null;
      const mutatesCells = plan.changed && (plan.clear.length > 0 || plan.steps.some(step => step.kind === 'write'));
      if (mutatesCells) {
        if (!submit({ type: 'write',
          x: plan.x, y: plan.y, text: plan.text, clear: plan.clear, lineStartX: writing.lineStartX })) return false;
      }
      nativeProjection.accept(plan);
      writing.trail = [...(plan.connectsToBase ? nativeTrailBase : []), ...plan.historyToCursor].slice(-4096);
      writing.active = true;
      cursor = { ...plan.cursor }; navigationRevision++;
      panRemainder = { x: 0, y: 0 }; center();
      if (!mutatesCells || plan.writeCursor?.x !== cursor.x || plan.writeCursor?.y !== cursor.y) queueMove('native-caret');
      return true;
    } finally { applyingNativeEdit = false; }
  },
  onPreedit(text, range) { preedit = text; preeditRange = range; updateNativeSurface(); },
  onCompositionChange(value) { composing = value; if (value) stopPan(); },
  onCommand(type) {
    if (type === 'insertLineBreak' || type === 'insertParagraph') write('\n');
    else erase(type === 'deleteContentBackward');
    resetNativeProjection();
  },
  onReset: resetNativeProjection,
  onUnsupported: unsupportedInput,
  onInvalidated() { notice('위치가 바뀌어 조합을 취소했습니다. 중심 칸에 다시 입력해 주세요.'); },
});
input.addEventListener('keydown', event => {
  stopPan();
  if (nativeInput.composing || event.isComposing) return;
  if (!world) return;
  if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Delete'].includes(event.key)) {
    event.preventDefault(); unsupportedInput('selection'); return;
  }
  if ((event.metaKey || event.ctrlKey) && ['a', 'c', 'x', 'insert'].includes(event.key.toLowerCase())) {
    event.preventDefault(); unsupportedInput('selection'); return;
  }
  if (['PageUp', 'PageDown'].includes(event.key) || ((event.metaKey || event.ctrlKey || event.altKey) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))) {
    event.preventDefault(); unsupportedInput('navigation'); return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (delta) { event.preventDefault(); move(cursor.x + delta[0], cursor.y + delta[1], { newOrigin: false, caret: true }); }
  else if (event.key === 'Home') { event.preventDefault(); move(writing.lineStartX, cursor.y, { newOrigin: false, caret: true }); }
  else if (event.key === 'End') { event.preventDefault(); unsupportedInput('lineEnd'); }
  else if (event.key === 'Escape') { event.preventDefault(); cancelComposition(); input.blur(); }
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
  motion.begin();
  grabCamera();
  // Keep touch's compatibility mousedown from blurring the native input after pointerup.
  event.preventDefault();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  canvas.setPointerCapture(event.pointerId);
  if (pointers.size === 1) drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
  else { motion.cancel(); pinch = { distance: distance(), zoom }; if (drag) drag.moved = true; }
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
    drag.moved = true; motion.drag(-totalX, -totalY);
  } else if (drag.moved) motion.drag(drag.x - event.clientX, drag.y - event.clientY);
  drag.x = event.clientX; drag.y = event.clientY;
});
function endPointer(event, cancelled = false) {
  if (!pointers.has(event.pointerId)) return;
  if (cancelled || pinch) motion.cancel();
  else if (drag?.id === event.pointerId && drag.moved) motion.end();
  pointers.delete(event.pointerId);
  if (!cancelled && drag?.id === event.pointerId && !drag.moved && !pinch) focusInput();
  if (pointers.size === 1) {
    const [key, p] = [...pointers.entries()][0];
    drag = { id: key, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: true };
    motion.begin();
    grabCamera();
  } else if (!pointers.size) {
    drag = null; pinch = null; dragCameraOffset = null;
    if (!motion.active) center();
  }
}
canvas.addEventListener('pointerup', event => endPointer(event));
canvas.addEventListener('pointercancel', event => endPointer(event, true));
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  if (!world) return;
  if (event.ctrlKey || event.metaKey) { setZoom(zoom * (event.deltaY > 0 ? .9 : 1.1)); return; }
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
  motion.wheel((event.shiftKey ? event.deltaY : event.deltaX) * factor, (event.shiftKey ? 0 : event.deltaY) * factor);
}, { passive: false });
function restorePointerTyping(event) {
  // Mouse-operated controls return to map typing; keyboard Tab users keep button focus.
  if (event.detail > 0 && isDesktop()) focusInput();
}
async function locate(initial = false) {
  stopPan();
  if (!world) return;
  const request = ++gpsRequest, revision = navigationRevision;
  if (!navigator.geolocation) { notice('GPS를 사용할 수 없어 함께 만나는 자리에서 시작합니다.'); return; }
  if (!initial) notice('현재 GPS 위치를 찾고 있습니다.');
  navigator.geolocation.getCurrentPosition(result => {
    if (request !== gpsRequest || (initial && revision !== navigationRevision)) return;
    const point = gpsToCell(result.coords.latitude, result.coords.longitude, world);
    move(point.x, point.y, { manual: false, cameraImmediate: true });
    notice('GPS에 해당하는 위치입니다. 중심 칸에 바로 입력하세요.');
  }, () => {
    if (request === gpsRequest && !initial) notice('GPS 위치를 얻지 못했습니다. 지도에서 이동해 주세요.');
  }, { enableHighAccuracy: false, timeout: 8000, maximumAge: initial ? 60000 : 0 });
}
$('gps').onclick = event => { locate(); restorePointerTyping(event); };
$('share').onclick = async event => {
  stopPan();
  if (!world) return;
  const url = new URL(location.href); url.hash = new URLSearchParams(cursor).toString();
  try { await navigator.clipboard.writeText(url.href); notice('이 위치의 링크를 복사했습니다.'); }
  catch { history.replaceState(null, '', url); notice('주소창에 위치를 담았습니다. 주소를 복사해 주세요.'); }
  restorePointerTyping(event);
};
function connection(value) {
  if (!value) stopPan();
  connected = value;
  const editable = value ? 'true' : 'false';
  if (input.contentEditable !== editable) input.contentEditable = editable;
  input.setAttribute('aria-disabled', String(!value));
  $('connection').textContent = value ? '실시간 연결' : '재연결 중';
  $('connection-dot').classList.toggle('online', value);
}
function goToHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const x = Number(params.get('x')), y = Number(params.get('y'));
  if (world && params.has('x') && params.has('y') && Number.isSafeInteger(x) && Number.isSafeInteger(y)) {
    move(x, y, { cameraImmediate: true }); return true;
  }
  return false;
}
function connect() {
  sentView = '';
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') {
      const wasConnected = connected, previousCursor = { ...cursor }, oldEpoch = world?.epoch;
      if(oldEpoch && oldEpoch !== message.world.epoch){motion.cancel();cameraMotion.cancel();panRemainder={x:0,y:0};drag=null;pinch=null;pointers.clear();dragCameraOffset=null;}
      const nextMe = message.peers.find(peer => peer.id === message.selfId);
      const fits = point => point.x >= 0 && point.x < message.world.width && point.y >= 0 && point.y < message.world.height;
      const stableStep = step => fits(step.from) && fits(step.to) && (step.kind === 'return'
        ? wrap(step.from.y + 1, message.world.height) === step.to.y
        : wrap(step.from.x + wrap(step.to.x - step.from.x, world.width), message.world.width) === step.to.x);
      const keepNativeContext = wasConnected && message.reason === 'density-resize' && message.resize?.preservesAddresses === true
        && pending.size === 0 && selfId === message.selfId && nextMe?.x === previousCursor.x && nextMe?.y === previousCursor.y
        && writing.lineStartX < message.world.width && writing.trail.every(stableStep);
      const keepWriting = keepNativeContext || (!firstSnapshot && !wasConnected && oldEpoch === message.world.epoch && pending.size === 0);
      cancelMove(); lastSentPosition = null; world = message.world; selfId = message.selfId;
      freshnessBands = message.freshness || {};
      colorBands = message.colors || {};
      freshnessMarks = new Map((message.marks || []).map(m => [cellKey(m.x, m.y), m.version]));
      observedView = message.view || null; viewRevision = message.viewRevision || 0;
      $('cursor').hidden = false;
      cells = new Map(message.cells.filter(c => c.text || c.width === 0).map(c => [cellKey(c.x, c.y), c]));
      peers = message.peers;
      const me = peers.find(p => p.id === selfId);
      input.style.setProperty("--author-color", me?.color || "#314137");
      cursor = me ? { x: me.x, y: me.y } : { x: 0, y: 0 };
      if (pending.size) { notice('세계를 갱신했습니다. 전송 중이던 글자를 확인해 주세요.'); pending.clear(); }
      refreshLocalCells();
      // Empty-edge resize can keep the same place and known text context.
      // Recovery snapshots and uncertain writes still invalidate native ranges.
      if (!keepNativeContext) resetComposition();
      connection(true);
      reportView({ immediate: true });
      if (!keepWriting) writing.reset(cursor);
      if (!keepNativeContext) resetNativeProjection();
      if (firstSnapshot) {
        firstSnapshot = false;
        if (!goToHash()) locate(true);
        notice(isDesktop() ? '지도를 움직여 자리를 고르고, 바로 입력하세요.' : '지도를 움직여 자리를 고르고, 탭해서 입력하세요.');
        if (isDesktop()) focusInput();
      } else if (!wasConnected) {
        move(previousCursor.x, previousCursor.y, { manual: false, newOrigin: !keepWriting });
        notice('다시 연결했습니다. 이전 위치에서 계속하세요.');
      } else if (oldEpoch !== world.epoch) notice('세계 크기가 바뀌어 글과 자리가 재배치됐습니다. 새 자리에서 입력하세요.');
      center();
      if (!wasConnected && isDesktop()) focusInput();
    } else if (message.type === 'view') {
      if (message.world?.epoch !== world?.epoch) return;
      const observation = message.observation;
      freshnessBands = observation.freshness || {};
      colorBands = observation.colors || {};
      freshnessMarks = new Map((observation.marks || []).map(m => [cellKey(m.x, m.y), m.version]));
      world = message.world;
      observedView = observation.view; viewRevision = observation.revision;
      if (observation.reset) cells = new Map();
      for (const point of observation.forget || []) cells.delete(cellKey(point.x, point.y));
      for (const c of observation.cells) {
        if (c.text || c.width === 0) cells.set(cellKey(c.x, c.y), c); else cells.delete(cellKey(c.x, c.y));
      }
      peers = observation.peers;
      // A scoped view is a cache update, not navigation or a native edit.
      // In particular an echo must not rewind newer local typing or reset IME.
      refreshLocalCells();
    } else if (message.type === 'ack') {
      browserMeasurements.ack(message.id);
      if (pending.delete(message.id)) refreshLocalCells();
    }
    else if (message.type === 'error') {
      pending.delete(message.id);
      refreshLocalCells();
      const observationOnly = message.requestType === 'view';
      if (!observationOnly && message.code !== 'STALE_EPOCH') {
        stopPan(); cancelMove(); resetComposition();
        if (message.cursor) cursor = { ...message.cursor };
        writing.reset(cursor); resetNativeProjection(); center();
      }
      clearTimeout(recoveryTimer);
      if (message.code !== 'STALE_EPOCH') {
        // A throttled request must not create an immediate sync/error loop.
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          if (observationOnly) reportView({ immediate: true, force: true });
          else send({ type: 'sync' });
        }, message.status === 429 ? Math.max(100, message.retryAfterMs || 1000) : 0);
      }
      notice(message.status === 429
        ? `${message.message} 약 ${Math.max(1, Math.ceil((message.retryAfterMs || 1000) / 1000))}초 뒤 다시 시도하세요.`
        : `${observationOnly ? '지도 갱신' : '입력'} 미반영: ${message.message}`);
    }
    $('population').textContent = `주변 ${peers.length}명`;
  };
  socket.onclose = () => {
    browserMeasurements.reset();
    clearTimeout(viewTimer); clearTimeout(recoveryTimer);
    cancelMove(); connection(false); resetComposition(); schedule();
    notice(pending.size ? '연결이 끊겼습니다. 전송 중이던 글자는 다시 연결한 뒤 확인해 주세요.' : '다시 연결하고 있습니다.');
    if (pending.size) writing.reset(cursor);
    pending.clear(); refreshLocalCells(); clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1000);
  };
  socket.onerror = () => socket.close();
}
window.addEventListener('hashchange', goToHash);
document.addEventListener('visibilitychange', () => { if (document.hidden) { motion.cancel(); center({ immediate: true }); } });
setZoom(1);
notice('글꼴을 불러오고 있습니다.');
document.fonts.load(`18px ${mapFont}`, '한글日本語中文iWM').then(faces => {
  if (!faces.length) throw new Error('Map font is unavailable');
  fontReady = true;
  connect();
}).catch(() => {
  $('connection').textContent = '글꼴 로드 실패';
  notice('지도 글꼴을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
});
// Read-only browser diagnostics for verifying spatial invariants.
window.textworld = { inspect: () => ({ world, cursor: { ...cursor }, camera: { ...camera }, viewport: visible(), observedView, viewRevision, freshnessMarks: [...freshnessMarks], freshness: freshnessBands, peers: structuredClone(peers), cells: [...cells.values()], localCells: [...localCells.values()], connected, pending: pending.size, zoom, composing, preedit, lineStartX: writing.lineStartX, motionActive: motion.active, cameraActive: cameraMotion.active, fontReady }) };
