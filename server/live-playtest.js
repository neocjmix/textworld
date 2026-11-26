import { timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { readBody } from './agent-http.js';
import { scenario, target, writingPattern } from '../experiments/playtest/scenario.mjs';
import { createPlaytestIngress } from '../experiments/playtest/ingress.mjs';
import wave from '../experiments/playtest/wave.json' with { type: 'json' };

const id = z.uuid();
const commands = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('start'), id, plan: scenario.optional() }),
  z.strictObject({ command: z.literal('set'), id, counts: target, writing: writingPattern.optional() }),
  z.strictObject({ command: z.literal('mark'), id, note: z.string().trim().min(1).max(200) }),
  z.strictObject({ command: z.literal('stop'), id }),
]);

/** The game's single SQLite authority owns one bounded job. Boot never creates a job. */
export function createLivePlaytest({ token, directory, sampleWorld, upgrade }) {
  const expected = Buffer.from('Bearer ' + token);
  const households = new WeakMap();
  let current, last, closing = false;
  function snapshot(run) {
    return { id: run.id, state: run.state, startedAt: run.startedAt, deadline: run.deadline,
      phase: run.phase, population: run.population, world: sampleWorld(), position: run.position };
  }
  function stop(run, reason) {
    if (!run.stopReason) {
      run.stopReason = reason;
      run.state = 'stopping';
      run.worker?.postMessage({ type: 'stop', reason });
      run.force = setTimeout(() => { void run.worker?.terminate(); }, 2000);
    }
    return run.done;
  }
  function record(run, type, fields = {}) {
    try {
      appendFileSync(join(run.dir, 'events.jsonl'), JSON.stringify({ type, at: new Date().toISOString(), ...fields }) + '\n');
    } catch (error) {
      run.error ??= error.code || 'RECORD_ERROR';
      if (run.state !== 'finished') stop(run, 'record-error');
    }
  }
  async function drive(run, plan) {
    let result;
    const ingress = createPlaytestIngress(upgrade, households);
    try {
      const port = await ingress.listen();
      if (!run.stopReason) {
        const worker = new Worker(new URL('../experiments/playtest/live-driver.mjs', import.meta.url),
          { workerData: { port, plan, credential: ingress.credential } });
        run.worker = worker;
        let lastSample = 0, epoch;
        worker.on('message', m => {
          if (m.type === 'end') { result = m; run.population = m.population; return; }
          if (!run.stopReason) run.state = 'running';
          if (m.phase) run.phase = m.phase;
          if (m.population) run.population = m.population;
          if ('position' in m) run.position = m.position;
          const world = sampleWorld();
          if (m.type !== 'sample' || Date.now() - lastSample >= 5000 || world.epoch !== epoch) {
            record(run, m.type, { phase: run.phase, population: run.population, world });
            lastSample = Date.now();
            epoch = world.epoch;
          }
        });
        await once(worker, 'exit');
        if (!result && !run.stopReason) run.error = 'DRIVER_EXIT';
      }
    } catch (error) {
      run.error = error.code || 'DRIVER_ERROR';
    } finally {
      clearTimeout(run.watchdog); clearTimeout(run.force);
      if (run.worker) await run.worker.terminate();
      await ingress.close();
      run.state = 'finished';
      const summary = { ...snapshot(run), finishedAt: new Date().toISOString(),
        reason: result?.reason ?? run.stopReason ?? 'driver-error', error: run.error ?? null };
      record(run, 'end', summary);
      summary.error ??= run.error ?? null;
      try {
        const path = join(run.dir, 'result.json');
        writeFileSync(path + '.tmp', JSON.stringify(summary));
        renameSync(path + '.tmp', path);
      } catch (error) { summary.error ??= error.code || 'RECORD_ERROR'; }
      last = summary;
      current = null;
    }
    return last;
  }
  function previous(key) {
    const dir = join(directory, key);
    try { return JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The directory itself claims the ID, including a crash between claim and first write.
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? { id: key, state: 'interrupted' } : null;
  }
  function start(key, plan, res, json) {
    if (current?.id === key) return json(res, 200, snapshot(current));
    const prior = previous(key);
    if (prior) return json(res, 200, prior);
    if (current || closing) return json(res, 409, { error: 'BUSY', id: current?.id });
    mkdirSync(directory, { recursive: true });
    const dir = join(directory, key);
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (e) { if (e.code === 'EEXIST') return json(res, 409, { error: 'ID_CLAIMED' }); throw e; }
    const duration = plan.phases.reduce((ms, p) => ms + p.seconds * 1000, 0);
    const now = Date.now();
    const run = { id: key, dir, state: 'starting', startedAt: new Date(now).toISOString(),
      deadline: new Date(now + duration).toISOString(), position: null };
    current = run;
    run.watchdog = setTimeout(() => stop(run, 'deadline'), duration);
    record(run, 'plan', { plan, revision: process.env.RAILWAY_GIT_COMMIT_SHA || null, world: sampleWorld() });
    run.done = drive(run, plan);
    return json(res, 202, snapshot(run));
  }
  return {
    network: req => households.get(req),
    get state() { return current?.state ?? 'idle'; },
    position: () => current?.position,
    async close() { closing = true; if (current) await stop(current, 'deployment'); },
    async handle(req, res, url, json) {
      const auth = Buffer.from(req.headers.authorization || '');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json(res, 404, { error: 'Not found' });
      if (req.method === 'GET') {
        const key = url.searchParams.get('id');
        if (key !== null && !id.safeParse(key).success) return json(res, 400, { error: 'BAD_ID' });
        if (current && (!key || key === current.id)) return json(res, 200, snapshot(current));
        if (!key) return json(res, 200, { state: 'idle', last: last ?? null });
        const result = previous(key);
        return json(res, result ? 200 : 404, result ?? { error: 'UNKNOWN_RUN' });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST required' });
      const body = commands.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: 'BAD_COMMAND' });
      const cmd = body.data;
      if (cmd.command === 'start') return start(cmd.id, cmd.plan ?? scenario.parse(wave), res, json);
      const run = current;
      if (!run || cmd.id !== run.id) return json(res, 409, { error: 'RUN_NOT_ACTIVE' });
      if (cmd.command === 'stop') {
        stop(run, 'operator');
      } else if (run.state !== 'running') return json(res, 409, { error: 'RUN_NOT_READY' });
      else if (cmd.command === 'set') run.worker.postMessage({ type: 'set', counts: cmd.counts, writing: cmd.writing });
      else if (cmd.command === 'mark') record(run, 'mark', { note: cmd.note, ...snapshot(run) });
      return json(res, 202, snapshot(run));
    },
  };
}
