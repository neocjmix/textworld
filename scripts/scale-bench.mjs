// Local-only deterministic microbenchmark. No production requests or quota bypass.
import{World}from'../server/world.js';import{Observer}from'../server/visibility.js';import{Measurements}from'../server/measurements.js';import{performance}from'node:perf_hooks';import{mkdir,writeFile}from'node:fs/promises';import{execFileSync}from'node:child_process';import{cpus}from'node:os';import{readFileSync}from'node:fs';
const cpuQuota=()=>{try{return readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim();}catch{return null;}};
const report={schema:1,at:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,cpu:cpus()[0]?.model,logicalCPUs:cpus().length,workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),cpuQuota:cpuQuota(),kind:'engine+observer microbenchmark, not end-to-end capacity',results:[]};
for(let trial=0;trial<3;trial++)for(const occupancy of [0,8192])for(const area of [[80,24],[160,48]])for(const participants of [1,8,32])for(const instrumented of (trial%2?[true,false]:[false,true])){
 const world=new World({width:512,height:256,now:()=>1000000});let id=0;
 for(let n=0;n<occupancy;n+=256)world.applyWrite({author:'seed',id:String(id++),epoch:1,x:n%512,y:Math.floor(n/512),text:'A'.repeat(Math.min(256,occupancy-n))});
 const peers=Array.from({length:participants},(_,i)=>({id:String(i),name:'bench',x:128,y:8,color:'#123'}));
 const observers=peers.map(peer=>new Observer({world,peer,view:{cols:area[0],rows:area[1]}}));const metrics=new Measurements({enabled:instrumented});
 for(const o of observers)o.read(peers);
 const durations=[];let wire=0,cells=0;const cpu=process.cpuUsage(),start=performance.now();
 for(let n=0;n<20;n++){
  const t=performance.now();const c=performance.now();world.applyWrite({author:'writer',id:String(id++),epoch:1,x:128+n%8,y:8,text:'한'});metrics.record('commit.ms',performance.now()-c);
  for(const o of observers){const t=performance.now();const result=o.read(peers,{since:o.revision});metrics.record('observer.ms',performance.now()-t);wire+=Buffer.byteLength(JSON.stringify(result));cells+=result.cells.length;}
  durations.push(performance.now()-t);
 }
 const elapsed=performance.now()-start,used=process.cpuUsage(cpu);durations.sort((a,b)=>a-b);
 report.results.push({trial,occupancy,viewport:area,participants,instrumented,samples:20,elapsedMs:elapsed,p50Ms:durations[9],p95Ms:durations[18],maxMs:durations[19],cpuMs:(used.user+used.system)/1000,applicationBytes:wire,returnedCells:cells,rssBytes:process.memoryUsage().rss,heapBytes:process.memoryUsage().heapUsed});
 metrics.close();world.close();
}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/scale-benchmark.json',JSON.stringify(report,null,2));
console.table(report.results.filter(r=>r.instrumented).map(r=>({occupied:r.occupancy,view:r.viewport.join('x'),peers:r.participants,p95_ms:r.p95Ms.toFixed(2),cpu_ms:r.cpuMs.toFixed(1),bytes:r.applicationBytes})));
