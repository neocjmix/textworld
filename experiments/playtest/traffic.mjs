import { Population } from './population.mjs';

/** The local fixture and the public world run the same finite traffic schedule. */
export function startTraffic({ port, plan, credential, onPhase }) {
  const finished = Promise.withResolvers();
  const population = new Population(port, plan, stop, credential, () => schedule(performance.now()));
  let phase, index = 0, phaseStart = performance.now(), stopping = false;
  const duration = plan.phases.reduce((ms, p) => ms + p.seconds * 1000, 0);
  const deadline = setTimeout(() => stop('deadline'), duration);
  let clock, scheduled = Infinity;
  function schedule(at) {
    if (stopping || at >= scheduled) return;
    clearTimeout(clock);
    scheduled = at;
    clock = setTimeout(tick, Math.max(0, Math.ceil(at - performance.now())));
  }
  function stop(reason) {
    if (!stopping) {
      stopping = true;
      clearTimeout(clock); clearTimeout(deadline);
      population.close().then(() => finished.resolve(reason), finished.reject);
    }
    return finished.promise;
  }
  function tick() {
    if (stopping) return;
    scheduled = Infinity;
    const now = performance.now();
    while (!phase || now >= phaseStart + phase.seconds * 1000) {
      if (phase) phaseStart += phase.seconds * 1000;
      phase = plan.phases[index++];
      if (!phase) return stop('deadline');
      onPhase(phase);
    }
    const next = population.tick(now, phase);
    if (!stopping) schedule(Math.min(next, phaseStart + phase.seconds * 1000));
  }
  tick();
  return {
    population, done: finished.promise, stop,
    get phase() { return phase; },
    setTarget(counts, writing) {
      if (!stopping) {
        phase = { ...phase, ...counts, writing: writing ?? phase.writing };
        schedule(performance.now());
      }
      return phase;
    },
    position() {
      const actor = [...population.actors].find(a => a.role === 'writers' && a.ready && !a.leaving && a.position);
      return actor ? { x: actor.position.x, y: actor.position.y } : null;
    },
  };
}
