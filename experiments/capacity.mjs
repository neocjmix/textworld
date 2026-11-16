// Local-only open-loop capacity probe. Separate server/load-generator processes;
// real WebSockets, on-disk SQLite FULL/WAL, production participant limits.
// Distinct loopback source addresses model independent networks. No remote URL.
// Fixed world clock isolates steady-state fanout; resize/expiry measured separately.
import { fork, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { createTextworld } from '../server/index.js';
import { summary } from '../shared/measurement.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const filename = fileURLToPath(import.meta.url);
const quantile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1] : null;

if (process.argv[2] === '--server') {
  const config = JSON.parse(process.argv[3]);
  const directory = await mkdtemp(join(tmpdir(), 'textworld-capacity-'));
  const app = createTextworld({ storagePath: join(directory, 'world.sqlite'), now: () => 1_000_000, trustProxy: false });
  app.world.resize(512, 256, [], { seed: 1 });
  for (let y=0; y<256; y++) {
    const cells=[];
    for (let x=0; x<512; x++) if (config.layout === 'hotspot' ? y>=120 && y<136 : (x+5*y)%13===0) cells.push({x,y,text:'A'});
    if (cells.length) app.world.commit(cells, { author:'fixture',id:`seed-${y}`,cursor:null,reason:'write' });
  }
  const {port}=await app.listen(0,'127.0.0.1');
  let start, cpu;
  process.on('message', async message => {
    if(message.kind==='start') {
      app.measurements.pending.clear(); app.measurements.loop.reset();
      cpu=process.cpuUsage(); start=performance.now();
      process.send({kind:'started'});
    } else if(message.kind==='finish') {
      const elapsedMs=performance.now()-start, used=process.cpuUsage(cpu);
      const metrics=Object.fromEntries([...app.measurements.pending].map(([name,h])=>[name,summary(h)]));
      process.send({kind:'finished', elapsedMs, cpuMs:(used.user+used.system)/1000,
        rssBytes:process.memoryUsage().rss, eventLoopP99Ms:app.measurements.loop.percentile(99)/1e6,
        metrics, world:app.world.metadata(), ink:app.world.ink});
    } else if(message.kind==='stop') {
      await app.close(); await rm(directory,{recursive:true,force:true}); process.exit(0);
    }
  });
  process.send({kind:'ready',port,ink:app.world.ink});
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
    let measuring=false, receivedBytes=0, receivedMessages=0, sent=0, acks=0, disconnects=0;
    try {
      const ready=await receive('ready');
      for(let i=0;i<config.peers;i++) {
        const socket=new WebSocket(`ws://127.0.0.1:${ready.port}/ws`,{localAddress:`127.0.${Math.floor(i/250)}.${i%250+2}`});
        socket.sequence=0;sockets.push(socket);
        socket.on('error',error=>{errors[error.code||'socket']=(errors[error.code||'socket']||0)+1;});
        socket.on('close',()=>{if(measuring)disconnects++;});
        socket.on('message',raw=>{
          const message=JSON.parse(raw.toString());
          if(measuring){receivedBytes+=raw.length;receivedMessages++;}
          if(message.type==='error'&&measuring){errors[message.code]=(errors[message.code]||0)+1;pending.delete(message.id);}
          if(message.type==='ack'&&pending.has(message.id)) {
            const {at,due}=pending.get(message.id);pending.delete(message.id);acks++;
            latencies.push(performance.now()-at);scheduledLatencies.push(performance.now()-due);
          }
        });
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('initial snapshot timeout')),20000);
          const handler=raw=>{if(JSON.parse(raw.toString()).type==='snapshot'){clearTimeout(timer);socket.off('message',handler);resolve();}};
          socket.on('message',handler);socket.once('error',reject);
        });
        socket.send(JSON.stringify({type:'hello',view:{cols:160,rows:48}}));
      }
      await pause(500);
      const started=receive('started');server.send({kind:'start'});await started;
      measuring=true;
      const start=performance.now(), interval=1000/(config.active*config.rate), total=Math.floor(durationMs/interval);
      while(sent<total) {
        const elapsed=performance.now()-start;
        while(sent<total && sent*interval<=elapsed) {
          const i=sent%config.active,socket=sockets[i],sequence=++socket.sequence,id=`${i}:${sequence}`;
          const due=start+sent*interval,at=performance.now();
          pending.set(id,{at,due});sendDelays.push(at-due);
          const action=config.action==='type'?{kind:'type',text:'한'}:{kind:'move',dx:sequence%2?1:-1,dy:0,newOrigin:true};
          socket.send(JSON.stringify({type:'input',id,sequence,epoch:2,action}));sent++;
        }
        if(sent<total)await pause(2);
      }
      await pause(Math.max(0,durationMs-(performance.now()-start)));
      const pendingAtOfferEnd=pending.size,drainStarted=performance.now();
      while(pending.size&&performance.now()-drainStarted<8000)await pause(10);
      const finished=receive('finished');server.send({kind:'finish'});const measured=await finished;
      measuring=false;
      const result={...config,view:[160,48],durationMs,offeredPerSecond:config.active*config.rate,sent,acks,pendingAtOfferEnd,pendingAfterDrain:pending.size,
        drainMs:performance.now()-drainStarted,ackP50Ms:quantile(latencies,.5),ackP95Ms:quantile(latencies,.95),ackMaxMs:quantile(latencies,1),
        scheduledP95Ms:quantile(scheduledLatencies,.95),generatorSendP95Ms:quantile(sendDelays,.95),errors,disconnects,receivedBytes,receivedMessages,...measured};
      delete result.kind;results.push(result);
      console.log(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([k])=>k!=='metrics'))));
    } finally {
      if(server.connected){server.send({kind:'stop'});await new Promise(resolve=>{const timer=setTimeout(()=>{server.kill('SIGKILL');resolve();},10000);server.once('exit',()=>{clearTimeout(timer);resolve();});});}
      for(const socket of sockets)socket.terminate();
    }
  }
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/capacity-probe.json',JSON.stringify({at:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    node:process.version,cpu:cpus()[0]?.model,cpuQuota:(await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),durationMs,
    scope:'Local loopback, separate processes, on-disk SQLite, steady world clock; no Railway/TLS/browser/resize/expiry load; one short sample per case, not a capacity guarantee.',results},null,2));
}
