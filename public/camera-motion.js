const point = value => {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new TypeError('Camera coordinates must be finite.');
  return { x: value.x, y: value.y };
};
const nearest = (value, current, extent) => value + Math.round((current - value) / extent) * extent;

/**
 * Visual camera motion only: input addresses and presence remain authoritative
 * in the caller. Positions stay unwrapped so crossing a torus seam does not
 * animate a whole circumference. Resize targets can omit extent to preserve
 * their deliberate screen-space displacement instead of taking a torus shortcut.
 */
export function createCameraMotion({
  onUpdate,
  initial = { x: 0, y: 0 },
  reducedMotion = () => false,
  now = () => performance.now(),
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id),
} = {}) {
  if (typeof onUpdate !== 'function') throw new TypeError('Camera onUpdate callback is required.');
  let position = point(initial), target = { ...position };
  let scale = { x: 1, y: 1 }, timeConstant = 80;
  let frame = null, lastTime = 0;
  const tolerance = .1, suspendAfter = 250;

  const distance = () => Math.hypot((target.x - position.x) * scale.x, (target.y - position.y) * scale.y);
  const emit = () => onUpdate({ ...position });
  function unschedule() {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  }
  function finish() {
    unschedule(); position = { ...target }; emit();
  }
  function schedule() {
    if (frame === null) frame = requestFrame(tick);
  }
  function tick() {
    frame = null;
    // Use the same monotonic clock as setTarget. A RAF timestamp can predate an
    // input event in its frame and must not reverse camera motion.
    const time = now(), elapsed = time - lastTime;
    lastTime = time;
    if (reducedMotion() || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > suspendAfter) { finish(); return; }
    const fraction = -Math.expm1(-elapsed / timeConstant);
    position.x += (target.x - position.x) * fraction;
    position.y += (target.y - position.y) * fraction;
    if (distance() <= tolerance) { finish(); return; }
    emit(); schedule();
  }
  function setTarget(value, options = {}) {
    let next = point(value);
    let nextScale = scale, nextTimeConstant = timeConstant;
    if (options.extent) {
      const { width, height } = options.extent;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new RangeError('Camera extent must be positive.');
      // Follow the previous destination, not the lagging displayed camera. A
      // rapid stream can cross half a circumference before a frame is drawn;
      // choosing relative to position would then suddenly reverse direction.
      next = { x: nearest(next.x, target.x, width), y: nearest(next.y, target.y, height) };
    }
    if (options.scale) {
      nextScale = point(options.scale);
      if (nextScale.x <= 0 || nextScale.y <= 0) throw new RangeError('Camera pixel scale must be positive.');
    }
    if (options.timeConstant !== undefined) {
      if (!Number.isFinite(options.timeConstant) || options.timeConstant <= 0) throw new RangeError('Camera time constant must be positive.');
      nextTimeConstant = options.timeConstant;
    }
    target = next; scale = nextScale; timeConstant = nextTimeConstant;
    if (options.immediate || reducedMotion() || distance() <= tolerance) { finish(); return; }
    // Retargeting a running camera changes its destination, not its frame clock.
    // Continuous wheel/viewport streams therefore cannot postpone motion.
    if (frame === null) lastTime = now();
    schedule();
  }
  function jump(value) { target = point(value); finish(); }
  // Freeze where the camera is visible now. Call finish() instead when a
  // settled destination is required (for example before leaving the page).
  function cancel() { unschedule(); target = { ...position }; }

  return {
    setTarget, jump, finish, cancel,
    get position() { return { ...position }; },
    get target() { return { ...target }; },
    get active() { return frame !== null; },
  };
}
