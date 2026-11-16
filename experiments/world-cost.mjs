// Local engine-only costs: synchronous automatic growth and retained history.
// Uses disposable on-disk SQLite; no network or production state is touched.
import { World } from '../server/world.js';
import { expire } from '../server/expiration.js';
import { DensityController } from '../server/density.js';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const growth=[];
for(const [width,height] of [[128,64],[512,256],[896,448]]) for(let trial=0;trial<3;trial++) {
  const dir=await mkdtemp(join(tmpdir(),'textworld-growth-'));
  const now=1_000_000,world=new World({width,height,storagePath:join(dir,'world.sqlite'),now:()=>now});
  try {
    for(let y=0;y<height;y++) {
      const cells=[];
      for(let x=0;x<width;x++)if((x+5*y)%7===0)cells.push({x,y,text:'A'});
      world.commit(cells,{author:'fixture',id:`row-${y}`,reason:'write',cursor:null});
    }
    world.densityController=new DensityController(now,world.ink);
    const occupied=world.ink,cpu=process.cpuUsage(),start=performance.now();
    const result=world.adapt([],{cooldown:0,seed:100+trial});
    const elapsedMs=performance.now()-start,used=process.cpuUsage(cpu);
    growth.push({trial,from:[width,height],occupied,to:[world.width,world.height],elapsedMs,cpuMs:(used.user+used.system)/1000,
      changed:result.changed,preservation:result.preservation,lostTextCells:result.lostTextCells,rssBytes:process.memoryUsage().rss});
    console.log(JSON.stringify(growth.at(-1)));
  } finally {world.close();await rm(dir,{recursive:true,force:true});}
}

const dir=await mkdtemp(join(tmpdir(),'textworld-history-'));
let now=1_000_000;
const world=new World({width:128,height:64,storagePath:join(dir,'world.sqlite'),now:()=>now});
let retention;
try {
  const pages=()=>Number(world.db.prepare('PRAGMA page_count').get().page_count)*Number(world.db.prepare('PRAGMA page_size').get().page_size);
  const beforeBytes=pages(),author=randomUUID(),count=5000,start=performance.now();
  for(let n=0;n<count;n++) {
    now+=10;
    world.applyWrite({author,id:`${author}:input:${n}`,epoch:world.epoch,x:64,y:32,text:n%2?'한':'글'});
  }
  const writeMs=performance.now()-start,afterWriteBytes=pages();
  now+=190_000;
  const deletedCells=expire(world);
  retention={writes:count,liveGlyphsBeforeExpiry:1,liveGlyphsAfterExpiry:world.ink/2,deletedCells,
    retainedHistoryRows:Number(world.db.prepare('SELECT count(*) n FROM history').get().n),
    retainedOperationRows:Number(world.db.prepare('SELECT count(*) n FROM operations').get().n),
    beforeBytes,afterWriteBytes,afterExpiryBytes:pages(),bytesPerWrite:(afterWriteBytes-beforeBytes)/count,writeMs};
  console.log(JSON.stringify(retention));
} finally {world.close();await rm(dir,{recursive:true,force:true});}
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/world-cost.json',JSON.stringify({at:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  node:process.version,cpu:cpus()[0]?.model,cpuQuota:(await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),
  scope:'Local engine, on-disk SQLite; growth excludes participant correction, observation fanout, sockets and browsers. Row-seeded ASCII at 1/7 density. History uses 5000 single Korean glyph overwrites of one address.',growth,retention},null,2));
