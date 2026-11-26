// Local-only open-loop capacity probe. Separate server/load-generator processes;
// real WebSockets, on-disk SQLite FULL/WAL, production participant limits.
// Distinct loopback source addresses model independent networks. No remote URL.
// Use a fixed world clock for comparisons, or liveClock:true for a real-time soak.
import { fork, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHistogram, performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

import { empty, merge, summary } from '../shared/measurement.js';
import { EXPIRY_AGE_MS } from '../shared/freshness.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const filename = fileURLToPath(import.meta.url);
const quantile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1] : null;

function storageSample(world, elapsedMs) {
  const pages = pragma => Object.values(world.db.prepare('PRAGMA ' + pragma).get())[0];
  const rows = table => world.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
  let overdueGlyphs = 0, oldestGlyphAgeMs = 0;
  const now = world.now();
  for (const cell of world.cells.values()) if (cell.text) {
    const age = now - cell.updatedAt;
    oldestGlyphAgeMs = Math.max(oldestGlyphAgeMs, age);
    if (age >= EXPIRY_AGE_MS + 5000) overdueGlyphs++;
  }
  return { elapsedMs, rssBytes:process.memoryUsage().rss, heapBytes:process.memoryUsage().heapUsed,
    pageBytes:pages('page_count') * pages('page_size'), freeBytes:pages('freelist_count') * pages('page_size'),
    walBytes:statSync(world.storagePath + '-wal', {throwIfNoEntry:false})?.size || 0,
    historyRows:rows('history'), operationRows:rows('operations'), timeMarks:rows('change_times'),
    cells:world.cells.size, ink:world.ink, epoch:world.epoch, overdueGlyphs, oldestGlyphAgeMs };
}

// Keep client receive timestamps per observed committed version. For fixed-clock
// short cases all participants start together and can see every input. During
// a live soak they can drift apart, so only declare losses in the fixed fixture.
function deliveryResults(sockets, commits, knownVisibility, uncorrelatedWriteAcks) {
  const remote = createHistogram();
  let missing = 0, ownMissing = 0, remoteObserved = 0, outsideView = 0;
  for (const [version, {at, writer}] of commits) for (const [index, socket] of sockets.entries()) {
    const observed = socket.seen.get(version);
    if (observed === undefined) {
      if (knownVisibility && socket.region === sockets[writer].region) missing++;
      if (index === writer) ownMissing++;
    } else if (index !== writer) {
      if (knownVisibility && socket.region !== sockets[writer].region) outsideView++;
      remote.record(Math.max(1, Math.round((observed - at) * 1000)));
      remoteObserved++;
    }
  }
  return { confirmedWrites:commits.size + uncorrelatedWriteAcks, uncorrelatedWriteAcks, remoteObserved,
    missingVisibleWriteDeliveries:knownVisibility && !uncorrelatedWriteAcks ? missing : null,
    outsideViewWriteDeliveries:knownVisibility && !uncorrelatedWriteAcks ? outsideView : null,
    ownMissing:uncorrelatedWriteAcks ? null : ownMissing, remoteReceivedP95Ms:remote.count ? remote.percentile(95) / 1000 : null };
}

if (process.argv[2] === '--server') {
  const config = JSON.parse(process.argv[3]);
  const base = process.env.CAPACITY_WORKDIR || tmpdir();
  await mkdir(base, {recursive:true});
  const directory = await mkdtemp(join(base, 'textworld-capacity-'));
  const sourceRoot = process.env.CAPACITY_TARGET_ROOT || resolve(dirname(filename), '..');
  const { createTextworld } = await import(pathToFileURL(join(sourceRoot, 'server/index.js')));
  const seededAt = Date.now() - EXPIRY_AGE_MS;
  let seedClock = config.aged ? seededAt : null;
  const app = createTextworld({ storagePath: join(directory, 'world.sqlite'), trustProxy: false,
    now: () => seedClock ?? (config.liveClock ? Date.now() : 1_000_000),
    maxParticipants: config.maxParticipants ?? Math.max(300, config.peers || 0) });
  app.world.resize(512, 256, [], { seed: 1 });
  if (config.aged) {
    app.world.reserveAuthor('earlier-local-writers', '#586678');
    for (let n = 0; n < 6000; n++) {
      seedClock = seededAt + n * 30;
      const point = (n * 34211 + 93) % 65536;
      app.world.applyWrite({ author: 'earlier-local-writers', id: 'seed-' + n, epoch: app.world.epoch,
        x: 2 * (point % 256), y: Math.floor(point / 256), text: n % 4 === 0 ? 'A' : '가' });
    }
    seedClock = null;
  } else {
    for (let y=0; y<256; y++) {
      const cells=[];
      for (let x=0; x<512; x++) if (config.layout === 'hotspot' ? y>=120 && y<136 : (x+5*y)%13===0) cells.push({x,y,text:'A'});
      if (cells.length) app.world.commit(cells, { author:'fixture',id:`seed-${y}`,cursor:null,reason:'write' });
    }
  }
  const {port}=await app.listen(0,'127.0.0.1');
  let start, cpu, samplingTimer;
  const storage = [], flushed = new Map();
  const readyTimes = createHistogram(), expiryAges = createHistogram();
  if (config.liveClock) {
    const remove = app.world.conditionalDelete.bind(app.world);
    app.world.conditionalDelete = request => {
      const now = app.world.now();
      const ages = new Map();
      for (const {x,y,version} of request.candidates) {
        const cell = app.world.getCell(x,y);
        if (cell?.text && cell.version === version) ages.set(x + ',' + y, now - cell.updatedAt);
      }
      const result = remove(request);
      for (const {x,y} of result.cells) {
        const age = ages.get(x + ',' + y);
        if (age !== undefined) expiryAges.record(Math.max(1, age));
      }
      return result;
    };
  }
  const record = app.measurements.record.bind(app.measurements);
  app.measurements.record = (name, value) => {
    if (start && name === 'delivery.ready_ms') readyTimes.record(Math.max(1, Math.round(value * 1000)));
    return record(name, value);
  };
  const flush = app.measurements.flush.bind(app.measurements);
  app.measurements.flush = () => {
    if (start) for (const [name, h] of app.measurements.pending)
      flushed.set(name, merge(flushed.get(name) || empty(), h));
    flush();
  };
  const sample = () => {
    const item = storageSample(app.world, Math.round(performance.now() - start));
    storage.push(item);
    process.send({kind:'sample',item});
  };
  process.on('message', async message => {
    if(message.kind==='start') {
      app.measurements.pending.clear(); app.measurements.loop.reset();
      cpu=process.cpuUsage(); start=performance.now();
      if (config.liveClock) { sample(); samplingTimer = setInterval(sample, 60000); }
      process.send({kind:'started',seq:app.world.seq});
    } else if(message.kind==='finish') {
      const elapsedMs=performance.now()-start, used=process.cpuUsage(cpu);
      clearInterval(samplingTimer);
      if (config.liveClock) sample();
      for (const [name, h] of app.measurements.pending) flushed.set(name, merge(flushed.get(name) || empty(), h));
      const metrics=Object.fromEntries([...flushed].map(([name,h])=>[name,summary(h)]));
      process.send({kind:'finished', expiredGlyphs:expiryAges.count,
        expirationAgeP95Ms:expiryAges.count ? expiryAges.percentile(95) : null,
        expirationAgeMaxMs:expiryAges.count ? expiryAges.max : null, elapsedMs, cpuMs:(used.user+used.system)/1000,
        rssBytes:process.memoryUsage().rss, eventLoopP99Ms:app.measurements.loop.percentile(99)/1e6,
        readyP95Ms:readyTimes.count ? readyTimes.percentile(95) / 1000 : null, readyCount:readyTimes.count, storage, metrics, world:app.world.metadata(), ink:app.world.ink});
    } else if(message.kind==='quiet') {
      process.send({kind:'quiet',sample:storageSample(app.world, Math.round(performance.now()-start))});
    } else if(message.kind==='stop') {
      await app.close(); await rm(directory,{recursive:true,force:true}); process.exit(0);
    }
  });
  const digest = createHash('sha256');
  for (const directory of ['server','shared']) for (const name of readdirSync(join(sourceRoot,directory)).sort()) {
    if (name.endsWith('.js')) digest.update(name).update(readFileSync(join(sourceRoot,directory,name)));
  }
  process.send({kind:'ready',port,ink:app.world.ink,sourceDigest:digest.digest('hex')});
} else {
  const durationMs=Number(process.env.CAPACITY_DURATION_MS||12000);
  const scenarios=[
    {peers:8,active:8,rate:1,layout:'uniform',action:'type'},
    {peers:16,active:16,rate:1,layout:'uniform',action:'type'},
    {peers:32,active:32,rate:1,layout:'uniform',action:'type'},
    {peers:64,active:6,rate:1,layout:'uniform',action:'type'},
    {peers:128,active:6,rate:1,layout:'uniform',action:'type'},
    {peers:8,active:8,rate:1,layout:'hotspot',action:'type'},
    {peers:16,active:16,rate:1,layout:'hotspot',action:'type'},
    {peers:8,active:2,rate:10,layout:'uniform',action:'move'},
  ];
  const selected=process.env.CAPACITY_CASES ? JSON.parse(process.env.CAPACITY_CASES) : scenarios;
  const results=[];
  const outputPath=process.env.CAPACITY_OUTPUT || 'artifacts/capacity-probe.json';
  for(const config of selected) {
    const server=fork(filename,['--server',JSON.stringify(config)],{stdio:['ignore','ignore','inherit','ipc']});
    const receive=kind=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(Error(`server timeout: ${kind}`));},60000);
      const onMessage=message=>{if(message.kind===kind){cleanup();resolve(message);}};
      const onExit=code=>{cleanup();reject(Error(`server exited ${code} before ${kind}`));};
      const cleanup=()=>{clearTimeout(timer);server.off('message',onMessage);server.off('exit',onExit);};
      server.on('message',onMessage);server.on('exit',onExit);
    });
    const sockets=[], pending=new Map(), latencies=[], scheduledLatencies=[], sendDelays=[], errors={};
    server.on('message', message => {
      if (message.kind==='sample') console.log(JSON.stringify({storageSample:message.item}));
    });
    const commits=new Map(), queueSamples=[], acceptedByRegion=[0,0];
    let uncorrelatedWriteAcks=0, baselineSeq=Infinity, batchFrames=0, innerMessages=0, viewRecords=0, revisionGaps=0, revisionRegressions=0, resets=0;
    let measuring=false, receivedBytes=0, receivedMessages=0, sent=0, acks=0, disconnects=0;
    try {
      const ready=await receive('ready');
      for(let i=0;i<config.peers;i++) {
        const socket=new WebSocket(`ws://127.0.0.1:${ready.port}/ws`,{localAddress:`127.0.${Math.floor(i/250)}.${i%250+2}`});
        socket.sequence=0;socket.seen=new Map();socket.region=config.splitRegions ? i%2 : 0;sockets.push(socket);
        socket.on('error',error=>{errors[error.code||'socket']=(errors[error.code||'socket']||0)+1;});
        socket.on('close',()=>{if(measuring)disconnects++;});
        socket.on('message',raw=>{
          const message=JSON.parse(raw.toString());
          if(measuring){receivedBytes+=raw.length;receivedMessages++;}
          for (const item of message.type==='batch' ? message.messages : [message]) {
            if (measuring && message.type==='batch') innerMessages++;
            const observation=item.observation;
            if (item.type==='snapshot') {
              socket.revision=item.viewRevision; socket.epoch=item.world.epoch;
              if (measuring) resets++;
            }
            if (item.type!=='view' || !observation) continue;
            if (measuring) viewRecords++;
            if (measuring && observation.reset) resets++;
            if (measuring && !observation.reset && socket.epoch===item.world.epoch) {
              if (observation.revision>socket.revision+1) revisionGaps+=observation.revision-socket.revision-1;
              if (observation.revision<socket.revision) revisionRegressions++;
            }
            socket.revision=observation.revision; socket.epoch=item.world.epoch;
            if (measuring) for (const cell of observation.cells || []) {
              if (cell.version>baselineSeq && cell.text && !socket.seen.has(cell.version))
                socket.seen.set(cell.version,performance.now());
            }
          }
          if (measuring && message.type==='batch') batchFrames++;
          if(message.type==='error'&&measuring){errors[message.code]=(errors[message.code]||0)+1;pending.delete(message.id);}
          if(message.type==='ack'&&pending.has(message.id)) {
            const {at,due,kind}=pending.get(message.id);pending.delete(message.id);acks++; acceptedByRegion[socket.region]++;
            if (kind==='type') {
              if (Number.isSafeInteger(message.seq)) commits.set(message.seq,{at,writer:i});
              else uncorrelatedWriteAcks++;
            }
            latencies.push(performance.now()-at);scheduledLatencies.push(performance.now()-due);
          }
        });
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('initial snapshot timeout')),20000);
          const handler=raw=>{if(JSON.parse(raw.toString()).type==='snapshot'){clearTimeout(timer);socket.off('message',handler);resolve();}};
          socket.on('message',handler);socket.once('error',reject);
        });
        socket.send(JSON.stringify({type:'hello',...(config.batch ? {batchVersion:1} : {}),view:{cols:160,rows:48}}));
        if (socket.region) {
          // Move by the public input path to a row beyond the other group's viewport.
          const setupAck = new Promise((resolve, reject) => {
            const timer=setTimeout(() => {socket.off('message',handler); reject(Error('region setup timeout'));},20000);
            const handler=raw => {
              const response=JSON.parse(raw);
              if (response.id!=='setup') return;
              clearTimeout(timer); socket.off('message',handler);
              if (response.type==='ack') resolve(); else reject(Error('region setup failed: '+response.code));
            };
            socket.on('message',handler);
          });
          socket.send(JSON.stringify({type:'input',id:'setup',sequence:++socket.sequence,epoch:socket.epoch,
            action:{kind:'goto',x:256,y:228}}));
          await setupAck;
        }
      }
      await pause(500);
      const started=receive('started');server.send({kind:'start'});baselineSeq=(await started).seq;
      measuring=true;
      const start=performance.now(), interval=1000/(config.active*config.rate), total=Math.floor(durationMs/interval);
      const sampleEveryMs=config.liveClock ? 60000 : 1000;
      let nextSample=sampleEveryMs;
      while(sent<total) {
        const elapsed=performance.now()-start;
        if(elapsed>=nextSample) { queueSamples.push({elapsedMs:Math.round(elapsed),pending:pending.size}); nextSample+=sampleEveryMs; }
        while(sent<total && sent*interval<=elapsed) {
          const i=sent%config.active,socket=sockets[i],sequence=++socket.sequence,id=`${i}:${sequence}`;
          const due=start+sent*interval,at=performance.now();
          const move=config.action==='move' || (config.action==='mixed' && sequence%3===0);
          const action=move ? {kind:'move',dx:sequence%2?1:-1,dy:0,newOrigin:true} : {kind:'type',text:'한'};
          pending.set(id,{at,due,kind:action.kind});sendDelays.push(at-due);
          socket.send(JSON.stringify({type:'input',id,sequence,epoch:socket.epoch,action}));sent++;
        }
        if(sent<total)await pause(2);
      }
      await pause(Math.max(0,durationMs-(performance.now()-start)));
      const pendingAtOfferEnd=pending.size,drainStarted=performance.now();
      while(pending.size&&performance.now()-drainStarted<8000)await pause(10);
      const ackDrainMs=performance.now()-drainStarted;
      // An ACK can precede its observation. Keep the reader open for final batches.
      if (config.batch) await pause(250);
      const finished=receive('finished');server.send({kind:'finish'});const measured=await finished;
      measuring=false;
      const knownVisibility=!config.liveClock && durationMs*config.rate/1000*2 < 79;
      const result={...config,sourceDigest:ready.sourceDigest,view:[160,48],durationMs,offeredPerSecond:config.active*config.rate,sent,acks,pendingAtOfferEnd,pendingAfterDrain:pending.size,
        drainMs:ackDrainMs,readerDrainMs:performance.now()-drainStarted,ackP50Ms:quantile(latencies,.5),ackP95Ms:quantile(latencies,.95),ackMaxMs:quantile(latencies,1),
        ackP99Ms:quantile(latencies,.99), batchFrames, innerMessages, viewRecords,
        expectedViewRecords:knownVisibility ? sockets.reduce((n,socket)=>n+acceptedByRegion[socket.region],0) : null, revisionGaps, revisionRegressions, resets, queueSamples,
        ...deliveryResults(sockets,commits,knownVisibility,uncorrelatedWriteAcks),
        scheduledP95Ms:quantile(scheduledLatencies,.95),generatorSendP95Ms:quantile(sendDelays,.95),errors,disconnects,receivedBytes,receivedMessages,...measured};
      delete result.kind;results.push(result);
      if (config.liveClock) {
        const lastHalf=result.storage.filter(row=>row.elapsedMs>=durationMs/2);
        const ranges={};
        for (const key of ['pageBytes','freeBytes','walBytes','rssBytes','heapBytes','historyRows','operationRows','overdueGlyphs']) {
          ranges[key]=[Math.min(...lastHalf.map(row=>row[key])),Math.max(...lastHalf.map(row=>row[key]))];
        }
        console.log(JSON.stringify({storageSamples:result.storage.length,secondHalfRanges:ranges,
          queueSamples:queueSamples.length,peakSampledPending:Math.max(0,...queueSamples.map(row=>row.pending))}));
      }
      console.log(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([k])=>!['metrics','storage','queueSamples'].includes(k)))));
    } finally {
      if(server.connected){server.send({kind:'stop'});await new Promise(resolve=>{const timer=setTimeout(()=>{server.kill('SIGKILL');resolve();},10000);server.once('exit',()=>{clearTimeout(timer);resolve();});});}
      for(const socket of sockets)socket.terminate();
    }
  }
  await mkdir(dirname(outputPath),{recursive:true});
  let revision=process.env.CAPACITY_REVISION || process.env.RAILWAY_GIT_COMMIT_SHA || null, dirty=null;
  try {
    revision ||= execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    dirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  } catch { /* Images built from an uploaded checkout may omit Git and its metadata. */ }
  await writeFile(outputPath,JSON.stringify({at:new Date().toISOString(),revision,
    dirty, node:process.version,cpu:cpus()[0]?.model,cpuQuota:(await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),durationMs,
    scope:'Local loopback, separate processes, on-disk SQLite. Fixed world clock unless liveClock enabled. Bytes include final drain. Remote time ends at decoded client observation. No TLS, browser draw or hosting overhead.',results},null,2));
  console.log(JSON.stringify({capacityComplete:true,revision,scenarios:results.length,durationMs}));
}
