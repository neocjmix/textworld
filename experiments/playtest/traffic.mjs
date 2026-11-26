import { Population } from './population.mjs';

/** The local fixture and the public world run the same finite traffic schedule. */
export function startTraffic({ port, plan, credential, onPhase }) {
  const finished = Promise.withResolvers();
  const population = new Population(port, plan, stop, credential);
  let phase, index = 0, phaseStart = performance.now(), stopping = false;
  const duration = plan.phases.reduce((ms, p) => ms + p.seconds * 1000, 0);
  const deadline = setTimeout(() => stop('deadline'), duration);
  const clock = setInterval(tick, 100);
  function stop(reason) {
    if (!stopping) {
      stopping = true;
      clearInterval(clock); clearTimeout(deadline);
      population.close().then(() => finished.resolve(reason), finished.reject);
    }
    return finished.promise;
  }
  function tick() {
    if (stopping) return;
    const now = performance.now();
    while (!phase || now >= phaseStart + phase.seconds * 1000) {
      if (phase) phaseStart += phase.seconds * 1000;
      phase = plan.phases[index++];
      if (!phase) return stop('deadline');
      onPhase(phase);
    }
    population.tick(now, phase);
  }
  tick();
  return {
    population, done: finished.promise, stop,
    get phase() { return phase; },
    setTarget(counts, writing) {
      if (!stopping) phase = { ...phase, ...counts, writing: writing ?? phase.writing };
      return phase;
    },
    position() {
      const actor = [...population.actors].find(a => a.role === 'writers' && a.ready && !a.leaving && a.position);
      return actor ? { x: actor.position.x, y: actor.position.y } : null;
    },
  };
}
