import {DatabaseSync} from 'node:sqlite';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {statSync,readFileSync} from 'node:fs';
import {empty,add,merge,summary,CLIENT_METRICS} from '../shared/measurement.js';
const routes=['map','static','health','agents','mcp','scavenger','metrics','other'];
const statuses=[200,201,202,204,400,401,403,404,405,413,415,429,500,503];
export const METRICS = new Set(['process.cpu_limit_cores','process.memory_limit_bytes','process.cpu_ms','process.rss_bytes','process.heap_bytes','process.elapsed_ms','process.event_loop_p99_ms','process.event_loop_max_ms','process.event_loop_utilization',
 'activity.peer_ms','activity.session_created','activity.session_closed','world.width','world.height','world.ws_peers','world.http_peers','world.cells','world.occupied','world.area','world.db_bytes','world.wal_bytes','world.db_free_bytes','world.peers','world.network_entries','world.waiters',
 'expiration.ms','expiration.deleted_cells','expiration.batch_full','turn.ms','turn.steps','turn.completed','turn.blocked','turn.cancelled','turn.running','turn.error','topology.ms','topology.adapt_ms','topology.search_deferred','topology.forced','topology.destroyed_cells','topology.surviving_cells','topology.changed','commit.ms','commit.cells','commit.count','observer.ms','observer.cols','observer.rows','observer.area','observer.cells','observer.marks','observer.changed','presence.ms','presence.recipients',
 'ws.rx_bytes','ws.tx_bytes','ws.buffered_bytes','ws.slow_disconnects','ws.error_429','ws.error_other','telemetry.rejected',
 'metrics.flush_ms','metrics.failures','metrics.db_bytes',...CLIENT_METRICS.map(m=>`client.reported.${m}`),
 ...routes.flatMap(r=>[`http.${r}.ms`,`http.${r}.tx_bytes`,`http.${r}.declared_rx_bytes`,...statuses.map(s=>`http.${r}.status_${s}`),`http.${r}.status_other`,`http.${r}.aborted`])]);
export function route(path) {return path==='/mcp'?'mcp':path.startsWith('/api/agents/')||path==='/.well-known/textworld-agent.json'?'agents':path.startsWith('/api/scavenger/')?'scavenger':path==='/api/metrics'?'metrics':path==='/health'?'health':path==='/'?'map':/\.(js|css|html|woff2|svg|ico)$/.test(path)?'static':'other';}
const size=p=>{try{return statSync(p).size;}catch{return 0;}};
export class Measurements {
 constructor({path=':memory:',now=Date.now,revision=process.env.RAILWAY_GIT_COMMIT_SHA||process.env.RAILWAY_DEPLOYMENT_ID||'local',maxRows=50000,enabled=true}={}) {
  this.enabled=enabled;this.now=now;this.path=path;this.maxRows=maxRows;this.revision=revision;this.pending=new Map();this.failures=0;
  if(!enabled)return;
  try { this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA max_page_count=16384; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=8388608; PRAGMA busy_timeout=50;
   CREATE TABLE IF NOT EXISTS measurements (bucket INTEGER, period INTEGER, revision TEXT, metric TEXT, value TEXT, PRIMARY KEY(bucket,period,revision,metric));
   CREATE INDEX IF NOT EXISTS measurements_time ON measurements(bucket);`);
  } catch { try{this.db?.close();}catch{}this.enabled=false;this.failures=1;console.error('Measurement storage unavailable; world remains active.');return;}
  const read=p=>{try{return readFileSync(p,'utf8').trim();}catch{return null;}};
  const cpuLimit=read('/sys/fs/cgroup/cpu.max')?.split(' '),memory=Number(read('/sys/fs/cgroup/memory.max'));
  this.cpuLimit=cpuLimit&&cpuLimit[0]!=='max'?Number(cpuLimit[0])/Number(cpuLimit[1]):null;this.memoryLimit=Number.isFinite(memory)&&memory>0?memory:null;
  this.runtime={node:process.version,arch:process.arch,cpuLimit:this.cpuLimit,memoryLimit:this.memoryLimit};
  try {this.db.exec('CREATE TABLE IF NOT EXISTS builds (revision TEXT PRIMARY KEY, metadata TEXT)');
  this.db.prepare('INSERT OR REPLACE INTO builds VALUES (?,?)').run(this.revision,JSON.stringify(this.runtime));}catch{try{this.db.close();}catch{}this.enabled=false;this.failures=1;console.error('Measurement metadata unavailable; world remains active.');return;}
  this.loop=monitorEventLoopDelay({resolution:20});this.loop.enable();this.cpu=process.cpuUsage();this.lastSample=performance.now();this.elu=performance.eventLoopUtilization();
 }
 record(name,value=1){if(!this.enabled||!METRICS.has(name))return;let h=this.pending.get(name);if(!h){h=empty();this.pending.set(name,h);}add(h,value);}
 mergeClient(message,actor) {
  if(!message||!message.metrics||typeof message.metrics!=='object'||Array.isArray(message.metrics)||Object.keys(message.metrics).length>6)throw Error('BAD_TELEMETRY');
  const entries=Object.entries(message.metrics);
  for(const [name,h]of entries){if(!CLIENT_METRICS.includes(name)||!h||!Number.isSafeInteger(h.count)||h.count<1||h.count>2000||!Array.isArray(h.bins)||h.bins.length!==42||h.bins.some(v=>!Number.isSafeInteger(v)||v<0)||h.bins.reduce((a,b)=>a+b,0)!==h.count||![h.sum,h.min,h.max].every(Number.isFinite)||h.min<0||h.max>1e8||h.min>h.max||h.sum<h.min*h.count-1e-6||h.sum>h.max*h.count+1e-6)throw Error('BAD_TELEMETRY');}
  if(actor.lastTelemetry!==undefined&&performance.now()-actor.lastTelemetry<30000)throw Error('TELEMETRY_TOO_FAST');
  actor.lastTelemetry=performance.now();
  for(const [name,h]of entries){const key=`client.reported.${name}`;if(!this.pending.has(key))this.pending.set(key,empty());merge(this.pending.get(key),h);}
 }
 sample(world,stats={}) {
  if(!this.enabled)return;
  const time=performance.now(),cpu=process.cpuUsage(),mem=process.memoryUsage(),elu=performance.eventLoopUtilization(this.elu);
  this.record('process.cpu_ms',(cpu.user+cpu.system-this.cpu.user-this.cpu.system)/1000);this.record('process.elapsed_ms',time-this.lastSample);this.cpu=cpu;this.lastSample=time;this.elu=performance.eventLoopUtilization();
  if(this.cpuLimit)this.record('process.cpu_limit_cores',this.cpuLimit);if(this.memoryLimit)this.record('process.memory_limit_bytes',this.memoryLimit);
  this.record('process.rss_bytes',mem.rss);this.record('process.heap_bytes',mem.heapUsed);this.record('process.event_loop_utilization',elu.utilization);
  if(this.loop.count){this.record('process.event_loop_p99_ms',this.loop.percentile(99)/1e6);this.record('process.event_loop_max_ms',this.loop.max/1e6);}this.loop.reset();
  this.record('world.width',world.width);this.record('world.height',world.height);
  this.record('world.cells',world.cells.size);let occupied=0;for(const cell of world.cells.values())if(cell.text||cell.width===0)occupied++;this.record('world.occupied',occupied);this.record('world.area',world.width*world.height);
  for(const [key,value]of Object.entries(stats))this.record(`world.${key}`,value);
  if(world.storagePath&&world.storagePath!==':memory:'){this.record('world.db_bytes',size(world.storagePath));this.record('world.wal_bytes',size(world.storagePath+'-wal'));}
  const page=world.db.prepare('PRAGMA page_size').get().page_size,free=world.db.prepare('PRAGMA freelist_count').get().freelist_count;this.record('world.db_free_bytes',page*free);
  this.record('metrics.db_bytes',this.path===':memory:'?0:size(this.path)+size(this.path+'-wal'));
 }
 flush() {
  if(!this.enabled||!this.pending.size)return;
  const start=performance.now(),time=this.now(),batch=this.pending;this.pending=new Map();
  try{this.db.exec('BEGIN IMMEDIATE');const get=this.db.prepare('SELECT value FROM measurements WHERE bucket=? AND period=? AND revision=? AND metric=?');const put=this.db.prepare('INSERT OR REPLACE INTO measurements VALUES (?,?,?,?,?)');
   for(const period of [60,3600]){const bucket=Math.floor(time/(period*1000))*period*1000;for(const[name,h]of batch){const old=get.get(bucket,period,this.revision,name);const combined=old?merge(JSON.parse(old.value),h):h;put.run(bucket,period,this.revision,name,JSON.stringify(combined));}}
   this.db.prepare('DELETE FROM measurements WHERE (period=60 AND bucket<?) OR (period=3600 AND bucket<?)').run(time-6*3600000,time-30*86400000);
   const excess=this.db.prepare('SELECT max(0,count(*)-?) n FROM measurements').get(this.maxRows).n;
   if(excess)this.db.prepare('DELETE FROM measurements WHERE rowid IN (SELECT rowid FROM measurements ORDER BY CASE period WHEN 60 THEN 0 ELSE 1 END,bucket LIMIT ?)').run(excess);
   this.db.prepare('DELETE FROM builds WHERE revision!=? AND NOT EXISTS (SELECT 1 FROM measurements WHERE measurements.revision=builds.revision)').run(this.revision);
   this.db.exec('COMMIT');this.record('metrics.flush_ms',performance.now()-start);
  }catch{try{this.db.exec('ROLLBACK');}catch{}this.failures++;if(this.failures===1)console.error('Measurement flush failed; interval dropped.');this.record('metrics.failures');}
 }
 read({period=3600,since=0,before=Number.MAX_SAFE_INTEGER,limit=2000}={}){return this.enabled?this.db.prepare('SELECT * FROM measurements WHERE period=? AND bucket>=? AND bucket<=? ORDER BY bucket DESC LIMIT ?').all(period,since,before,Math.min(5000,Math.max(1,limit))).map(r=>({...r,value:summary(JSON.parse(r.value))})):[];}
 builds(){return this.enabled?this.db.prepare('SELECT revision,metadata FROM builds ORDER BY rowid DESC LIMIT 200').all().map(r=>({revision:r.revision,...JSON.parse(r.metadata)})):[];}
 close(){if(!this.enabled)return;this.loop.disable();this.flush();this.db.close();}
}
