import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { Population } from './population.mjs';
import { roles, scenario, target, writingPattern } from './scenario.mjs';

const usage = 'npm run playtest -- [--scenario wave.json] [--lan] [--port 3001]';
const controls = 'set 글쓴이수 산책자수 독자수 [new-cells|overwrite] · status · mark 현장 메모 · stop';
const { values } = parseArgs({ options: { scenario: { type: 'string' }, lan: { type: 'boolean' },
  port: { type: 'string', default: '0' }, help: { type: 'boolean', short: 'h' } } });

function revision() {
  try {
    const git = args => execFileSync('git', args, { cwd: new URL('../../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { commit: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']) };
  } catch { return { commit: null, dirty: null }; }
}

function serverTotals(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT metric, sum(json_extract(value, '$.sum')) AS total FROM measurements
      WHERE period = 60 AND metric IN ('topology.growth','topology.shrink','expiration.deleted_cells','ws.tx_bytes','process.cpu_ms')
      GROUP BY metric`).all();
    return Object.fromEntries(rows.map(row => [row.metric, row.total]));
  } finally { db.close(); }
}

async function run() {
  const plan = scenario.parse(JSON.parse(readFileSync(values.scenario || new URL('./wave.json', import.meta.url), 'utf8')));
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535) throw Error('포트는 0~65535의 정수입니다.');
  const duration = plan.phases.reduce((ms, p) => ms + p.seconds * 1000, 0);
  const base = resolve('artifacts/playtest');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, new Date().toISOString().replaceAll(':', '-') + '-'));
  const metrics = join(dir, 'metrics.sqlite');
  const scratch = mkdtempSync(join(tmpdir(), 'textworld-playtest-'));
  const done = Promise.withResolvers();
  const origin = performance.now();
  let phaseStart = origin, phaseIndex = -1, phase, stopping, failure;
  let world, mapPort, population, input, clock, deadline, startup, worker;
  const log = (type, data) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({
    type, elapsedMs: Math.round(performance.now() - origin), at: new Date().toISOString(), ...data,
  }) + '\n');
  const stop = (reason, error) => {
    if (error) failure ??= error;
    if (stopping) return;
    stopping = reason;
    done.resolve();
  };
  const interrupt = () => stop('signal');
  const joinLink = host => {
    const writer = [...population.actors].find(a => a.ready && !a.leaving && a.role === 'writers' && a.position);
    const point = writer?.position || { x: Math.floor(world.width/2), y: Math.floor(world.height/2) };
    return 'http://' + host + ':' + mapPort + '/#x=' + point.x + '&y=' + point.y;
  };
  function printLinks() {
    console.log('지도 ' + joinLink('127.0.0.1'));
    if (values.lan) for (const address of Object.values(networkInterfaces()).flat()) {
      if (address?.family === 'IPv4' && !address.internal) console.log('같은 네트워크 ' + joinLink(address.address));
    }
  }
  const status = () => {
    const s = population.report();
    console.log(phase.name + ' | 글쓴이 ' + s.active.writers + ', 산책자 ' + s.active.walkers + ', 독자 ' + s.active.readers
      + ' | 세계 ' + world.width + '×' + world.height + ' · 글자 ' + world.occupiedCells + '칸');
    printLinks();
  };
  function command(line) {
    if (stopping) return;
    const [verb, ...args] = line.trim().split(/\s+/);
    if (verb === 'stop') return stop('operator');
    if (verb === 'status') return status();
    if (verb === 'mark' && args.length) {
      log('mark', { phase: phase.name, note: args.join(' ').slice(0, 200), world, population: population.report() });
      console.log('체감 메모를 저장했습니다.');
      return;
    }
    if (verb === 'set' && [3, 4].includes(args.length) && args.slice(0, 3).every(s => /^\d+$/.test(s))) {
      const counts = target.safeParse(Object.fromEntries(roles.map((r, i) => [r, Number(args[i])])));
      const pattern = writingPattern.safeParse(args[3] ?? phase.writing);
      if (counts.success && pattern.success) {
        phase = { ...phase, ...counts.data, writing: pattern.data };
        log('override', { phase });
        console.log('이번 구간 목표', counts.data, pattern.data);
        return;
      }
    }
    console.log(controls);
  }
  function tick() {
    if (stopping) return;
    const now = performance.now();
    while (!phase || now >= phaseStart + phase.seconds * 1000) {
      if (phase) phaseStart += phase.seconds * 1000;
      phase = plan.phases[++phaseIndex];
      if (!phase) return stop('deadline');
      log('phase', { phase });
      console.log('구간 ' + phase.name + ' · ' + phase.seconds + '초 · 목표 ' + roles.map(r => phase[r]).join('/') + '명');
    }
    population.tick(now, phase);
  }

  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    log('plan', { ...revision(), node: process.version, plan });
    console.log('기록 ' + dir);
    worker = new Worker(new URL('./world.mjs', import.meta.url), { workerData: {
      database: join(scratch, 'world.sqlite'), metrics, lan: !!values.lan, port,
    } });
    const exited = new Promise(resolveExit => worker.once('exit', code => {
      if (!stopping || code) stop('world-exit', Error('시험 월드 종료 코드 ' + code));
      resolveExit();
    }));
    worker.on('error', error => stop('world-error', error));
    startup = setTimeout(() => stop('startup-timeout', Error('시험 월드 시작 시간 초과')), 15000);
    let nextSample = 0;
    worker.on('message', m => {
      const resized = world && world.epoch !== m.world.epoch;
      world = m.world;
      if (stopping) return;
      if (m.type === 'ready') {
        clearTimeout(startup);
        phaseStart = performance.now();
        mapPort = m.mapPort;
        population = new Population(m.botPort, plan, stop);
        log('ready', { link: joinLink('127.0.0.1'), world, durationMs: duration });
        printLinks();
        console.log(controls);
        deadline = setTimeout(() => stop('deadline'), duration);
        input = createInterface({ input: process.stdin, terminal: false });
        input.on('line', command);
        tick();
        clock = setInterval(tick, 100);
      } else if (resized || performance.now() >= nextSample) {
        log(resized ? 'resize' : 'sample', { phase: phase.name, world, population: population.report() });
        nextSample = performance.now() + 5000;
      }
    });
    await done.promise;
    clearInterval(clock);
    input?.close();
    await population?.close();
    worker.postMessage('stop');
    const force = setTimeout(() => {
      stop('shutdown-timeout', Error('시험 월드 종료 시간 초과'));
      void worker.terminate();
    }, 3000);
    await exited;
    clearTimeout(force);
    let server = null;
    if (!failure && population) {
      try { server = serverTotals(metrics); }
      catch (error) { failure = error; }
    }
    const record = { reason: stopping, world, population: population?.report(), server, error: failure?.message };
    log('end', record);
    console.log('시험 종료 ' + JSON.stringify(record));
    if (failure) throw failure;
  } finally {
    clearTimeout(startup); clearTimeout(deadline); clearInterval(clock);
    input?.close();
    if (worker) await worker.terminate();
    rmSync(scratch, { recursive: true, force: true });
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
}

if (values.help) console.log(usage + '\n' + controls);
else await run().catch(error => { console.error(error.message); process.exitCode = 1; });
