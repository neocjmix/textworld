import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { adaptOnline, stopResize } from '../server/resize-online.js';
import { remesh } from '../server/topology.js';

const plainCells = cells => Array.from(cells.values(), cell => ({...cell})).sort((a,b) => a.y-b.y || a.x-b.x);

for (const scenario of ['wide world','tall world','shrink']) {
  test(`online remesh reflects writes, expiry and latest cursor during ${scenario}`, async t => {
    const directory = mkdtempSync(join(tmpdir(),'tw-online-'));
    const storagePath = join(directory,'world.sqlite');
    let now = 10_000;
    let world = new World({ width:scenario === 'tall world' ? 128 : 256, height:96, now:() => now, storagePath });
    t.after(() => { world.close(); rmSync(directory,{recursive:true,force:true}); });
    const from = {width:world.width,height:world.height};
    const peer = {x:9,y:15};
    for (let y = 0; y < from.height; y += scenario === 'shrink' ? 16 : 1) {
      world.applyWrite({x:from.width-13,y,text:'한字a b🦊'.repeat(6),author:'fixture',id:'row'+y,epoch:1});
    }
    if (scenario === 'shrink') {
      await adaptOnline(world,() => [peer],{cooldown:0});
      now += 30_000;
    }
    const expiry = world.expiredCandidates(now,40);
    let amended = false, expected, expectedCursor;
    const resize = world.resize.bind(world);
    world.resize = (width,height,peers,options) => {
      expected = remesh(world.cells,from,{width,height},options.seed,options);
      expectedCursor = expected.cursor(peer);
      const barrier = resize(width,height,peers,options);
      for (let y = 0; y < from.height - 3; y += 5) for (let x = 0; x < from.width - 9; x += 7) {
        const bounds = {x, y, cols:9, rows:3};
        const first = barrier.mapping(x,y);
        if (!first) { assert.equal(barrier.translates(bounds,0,0), false); continue; }
        const dx = first.x - x, dy = first.y - y;
        let rigid = true;
        for (let row=y; row<y+3; row++) for (let col=x; col<x+9; col++) {
          const p = barrier.mapping(col,row);
          if (p?.x !== col+dx || p?.y !== row+dy) rigid = false;
        }
        assert.equal(barrier.translates(bounds,dx,dy), rigid);
      }
      return barrier;
    };
    const result = await adaptOnline(world,() => [peer],{seed:42,cooldown:0,record:() => {
      if (amended) return;
      amended = true;
      world.conditionalDelete({id:'expiry',epoch:1,candidates:expiry});
      world.applyWrite({x:from.width-1,y:0,text:'新글A',author:'visitor',id:'during-copy',epoch:1});
      Object.assign(peer,{x:from.width-1,y:0});
    }});
    assert.equal(amended,true);
    assert.equal(result.changed,true);
    for (const key of ['survivingCells','destroyedCells','lostTextCells','brokenAdjacencies','horizontalSeams','verticalSeams']) {
      assert.equal(result[key],expected.summary[key],key);
    }
    assert.deepEqual(peer,expectedCursor);
    assert.deepEqual(plainCells(world.cells),plainCells(expected.cells));
    const beforeRestart = plainCells(world.cells);
    world.close();
    world = new World({storagePath});
    assert.deepEqual(plainCells(world.cells),beforeRestart);
    assert.equal(world.epoch,2);
    assert.equal(world.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name LIKE 'resize_%'").get().n,0);
  });
}

test('failed shadow publication rolls back every address and leaves the next attempt usable', async t => {
  const world = new World({width:32,height:16,now:() => 5000});
  t.after(() => world.close());
  for(let y=0;y<16;y++) world.applyWrite({x:0,y,text:'0123456789',id:'r'+y,author:'a',epoch:1});
  const peer = {x:31,y:15}, before = plainCells(world.cells);
  world.db.exec("CREATE TRIGGER reject_meta BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT,'reject'); END");
  await assert.rejects(adaptOnline(world,()=>[peer],{cooldown:0}),/reject/);
  assert.equal(world.epoch,1);
  assert.deepEqual(plainCells(world.cells),before);
  assert.deepEqual(peer,{x:31,y:15});
  assert.equal(world.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'resize_%'").get().n,0);
  world.db.exec('DROP TRIGGER reject_meta');
  const first = adaptOnline(world,()=>[peer],{cooldown:0});
  await stopResize(world);
  assert.equal((await first).changed,false);
  for (let i=0;i<2;i++) assert.equal((await adaptOnline(world,()=>[peer],{cooldown:0})).changed,true);
});

test('obsolete shrink cancels after new text arrives and post-commit cleanup retries', async t => {
  let now = 0;
  const world = new World({width:128,height:64,now:() => now});
  t.after(() => world.close());
  await adaptOnline(world,()=>[],{cooldown:0});
  now = 30_000;
  let amended = false;
  const result = await adaptOnline(world,()=>[],{cooldown:0,seed:15,record:() => {
    if (amended) return;
    amended = true;
    for (let y=0; y<14; y++) world.applyWrite({x:0,y,text:'A'.repeat(128),author:'a',id:'r'+y,epoch:1});
  }});
  assert.equal(result.reason,'superseded');
  assert.equal(world.epoch,1);
  const resize = world.resize.bind(world);
  world.resize = (...args) => { resize(...args); throw new Error('after commit'); };
  await assert.rejects(adaptOnline(world,()=>[],{cooldown:0}),/after commit/);
  assert.equal(world.epoch,2);
  world.resize = resize;
  assert.equal((await adaptOnline(world,()=>[],{cooldown:0})).changed,true);
  assert.equal(world.epoch,3);
});
