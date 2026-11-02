// Pixel motion only. The map retains responsibility for cell addressing,
// torus wrapping and presence; no camera or writing state lives here.
export function createPanMotion({
  pan,
  reducedMotion = () => false,
  now = () => performance.now(),
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id),
} = {}) {
  if (typeof pan !== 'function') throw new TypeError('pan callback is required');
  const dragWindow = 80, decayTime = 220, wheelTime = 45;
  const startSpeed = .09, stopSpeed = .02, maxSpeed = 3;
  let frame = null, mode = null, lastFrame = 0, started = 0;
  let vx = 0, vy = 0, pendingX = 0, pendingY = 0;
  let dragging = false, samples = [], position = { x: 0, y: 0 };

  function cancel() {
    if (frame !== null) cancelFrame(frame);
    frame = null; mode = null; dragging = false; samples = [];
    vx = vy = pendingX = pendingY = 0;
  }
  function schedule() {
    if (frame === null) frame = requestFrame(tick);
  }
  function tick() {
    frame = null;
    // RAF timestamps describe the frame's start and can precede a pointerup
    // handled in that same frame. Use one monotonic clock for release and tick.
    const time = now();
    const dt = time - lastFrame;
    // A suspended tab or stalled frame must not resume with a large jump.
    if (!Number.isFinite(dt) || dt < 0 || dt > 120) { cancel(); return; }
    lastFrame = time;
    if (mode === 'wheel') {
      // Consume exactly the supplied wheel distance. Trackpads already send
      // their own momentum; adding a velocity tail would multiply that motion.
      const fraction = reducedMotion() ? 1 : -Math.expm1(-dt / wheelTime);
      let dx = pendingX * fraction, dy = pendingY * fraction;
      pendingX -= dx; pendingY -= dy;
      if (Math.hypot(pendingX, pendingY) < .05) {
        dx += pendingX; dy += pendingY;
        pendingX = pendingY = 0; mode = null;
      }
      if (dx || dy) pan(dx, dy);
    } else if (mode === 'fling') {
      if (reducedMotion() || time - started > 1400) { cancel(); return; }
      const decay = Math.exp(-dt / decayTime);
      // Analytic displacement makes 60 Hz and 120 Hz travel the same distance.
      const duration = decayTime * (1 - decay);
      const dx = vx * duration, dy = vy * duration;
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) < stopSpeed) mode = null;
      if (dx || dy) pan(dx, dy);
    }
    if (mode) schedule();
  }
  function begin() {
    cancel(); dragging = true; position = { x: 0, y: 0 };
    samples = [{ time: now(), ...position }];
  }
  function drag(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (!dragging) begin();
    const time = now();
    position.x += dx; position.y += dy;
    // Holding the pointer still and then moving again starts a fresh estimate.
    if (samples.length && time - samples.at(-1).time > dragWindow) samples = [];
    samples.push({ time, ...position });
    while (samples.length > 2 && samples[1].time < time - dragWindow) samples.shift();
    if (dx || dy) pan(dx, dy);
  }
  function end() {
    if (!dragging) return;
    dragging = false;
    const time = now(), first = samples[0], last = samples.at(-1);
    if (reducedMotion() || !first || !last || time - last.time > dragWindow) { samples = []; return; }
    const elapsed = last.time - first.time;
    if (elapsed < 8) { samples = []; return; }
    vx = (last.x - first.x) / elapsed;
    vy = (last.y - first.y) / elapsed;
    samples = [];
    const speed = Math.hypot(vx, vy);
    if (speed < startSpeed) return;
    if (speed > maxSpeed) { vx *= maxSpeed / speed; vy *= maxSpeed / speed; }
    mode = 'fling'; started = lastFrame = time; schedule();
  }
  function wheel(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return;
    if (mode !== 'wheel') cancel();
    if (reducedMotion()) {
      // Preserve supplied distance even if the preference changes mid-stream.
      const x = pendingX + dx, y = pendingY + dy;
      cancel(); pan(x, y); return;
    }
    pendingX += dx; pendingY += dy;
    if (mode !== 'wheel') { mode = 'wheel'; lastFrame = now(); }
    schedule();
  }
  return { begin, drag, end, wheel, cancel, get active() { return mode !== null; } };
}
