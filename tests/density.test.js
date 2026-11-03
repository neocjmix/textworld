import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { DENSITY, DensityController, inkArea } from '../server/density.js';

test('a completely full world reaches the density band progressively and then stops resizing', t => {
  let now = 0;
  const world = new World({ width: 32, height: 16, now: () => now }); t.after(() => world.close());
  for (let y=0;y<16;y++) world.applyWrite({ author:'load',id:'row'+y,epoch:1,x:0,y,text:'한'.repeat(16) });
  let reached = null, changes = 0;
  for (let tick=1;tick<=90;tick++) {
    now=tick*1000; const before=world.width*world.height;
    const result=world.adapt([], { seed:tick }); const area=world.width*world.height;
    assert.ok(area>=before && area<=before*1.125, 'one transaction never doubles the world');
    assert.ok(world.width/world.height>=1 && world.width/world.height<=4, 'stay two dimensional');
    if(result.changed) changes++;
    if(world.ink/area<=DENSITY.upper) reached ??= tick;
    if(tick>45) assert.equal(result.changed,false,'stable workload must settle');
  }
  assert.ok(reached<=25, 'an already full world must catch up within bounded time');
  assert.ok(changes>1 && changes<35);
  assert.ok(world.ink>=480, 'growth should retain nearly all wide text even in this worst case');
  assert.ok(world.ink/(world.width*world.height)>=DENSITY.lower);
});

test('density counts visible CJK width and ignores whitespace, with transaction rollback', t => {
  const world=new World({now:()=>0});t.after(()=>world.close());
  world.applyWrite({author:'a',id:'first',epoch:1,x:4,y:4,text:'한 A　'});
  assert.equal(world.ink,3);
  world.applyWrite({author:'b',id:'overwrite-tail',epoch:1,x:5,y:4,text:'B'});
  assert.equal(world.ink,2);
  world.erase({author:'a',id:'erase',epoch:1,x:7,y:4});
  assert.equal(world.ink,1);
  world.db.exec("CREATE TRIGGER deny_write BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'rollback'); END");
  assert.throws(()=>world.applyWrite({author:'a',id:'failure',epoch:1,x:10,y:10,text:'한글'}));
  assert.equal(world.ink,1);
  world.resize(144,64,[],{seed:7});
  assert.equal(world.ink,[...world.cells.values()].reduce((sum,c)=>sum+inkArea(c),0));
});

test('net growth forecast reacts early; overwrites and idle participants do not create demand', t => {
  let now=0;const w=new World({width:64,height:32,now:()=>now});t.after(()=>w.close());
  for(let y=0;y<3;y++)w.applyWrite({author:'a',id:'seed'+y,epoch:1,x:0,y,text:'A'.repeat(64)});
  now=1000;const result=w.adapt([],{seed:1});
  assert.ok(result.density<DENSITY.upper && result.projectedDensity>DENSITY.upper);
  assert.equal(result.changed,true);
  const fixed=new DensityController(0,500);
  for(let second=1;second<=300;second++){
    const r=fixed.decide({now:second*1000,occupied:500,width:128,height:64,lastResize:0});
    assert.equal(r.reason,'stable');assert.equal(r.netCellsPerSecond,0);
  }
});

test('short low-density dips do not shrink; sustained emptiness does, and new growth interrupts it',()=>{
  const control=new DensityController(0,0);
  const decide=(now,occupied)=>control.decide({now,occupied,width:128,height:64,lastResize:0});
  assert.equal(decide(1000,0).reason,'settling');
  assert.equal(decide(30000,0).reason,'settling');
  assert.equal(decide(31000,0).mode,'shrink');
  assert.equal(decide(32000,1200).mode,'grow');
});

test('finishing a growth cycle leaves headroom instead of chasing every new character',()=>{
  const c=new DensityController(0,1100);
  const due=c.decide({now:1000,occupied:1100,width:128,height:64,lastResize:0});
  assert.equal(due.reason,'due');
  c.resized(1100,due.targetArea);
  const next=c.decide({now:2000,occupied:1110,width:Math.ceil(due.targetArea/64),height:64,lastResize:1000});
  assert.equal(next.reason,'stable');assert.equal(next.mode,null);
});

test('physical limits are explicit and never cause repeated no-op topology events', t => {
  const w=new World({width:32,height:16,now:()=>60000});t.after(()=>w.close());
  w.densityController.lowSince=0;
  assert.equal(w.adapt([],{cooldown:0}).reason,'limit');
  assert.equal(w.epoch,1);
  const c=new DensityController(0,400000);
  const r=c.decide({now:1000,occupied:400000,width:1024,height:512,lastResize:0});
  assert.equal(r.reason,'limit');assert.ok(r.density>DENSITY.upper);
});
