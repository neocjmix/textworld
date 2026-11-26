import test from 'node:test';
import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { WebSocket } from 'ws';
import { createTextworld } from '../server/index.js';

const key = p => p.x + ',' + p.y;
const cells = array => new Map(array.map(p => [key(p),p]));
const peers = array => new Map(array.map(p => [p.id,p]));
const glyphs = map => [...map.values()].sort((a,b) => a.y-b.y || a.x-b.x);

function replay(snapshot, barrier) {
  const {basis,patch} = barrier;
  assert.equal(basis.epoch,snapshot.world.epoch);
  assert.equal(basis.revision,snapshot.viewRevision);
  const shift = p => ({...p, x:p.x+basis.dx, y:p.y+basis.dy,
    ...(Number.isInteger(p.leadX) ? {leadX:p.leadX+basis.dx} : {})});
  const ink = cells(snapshot.cells.map(shift)), marks = cells(snapshot.marks.map(shift));
  const people = peers(snapshot.peers.map(shift));
  const ages = {...snapshot.freshness}, colors = {...snapshot.colors};
  for (const p of patch.forget) ink.delete(key(p));
  for (const p of patch.cells) ink.set(key(p),p);
  for (const p of patch.unmark) marks.delete(key(p));
  for (const p of patch.marks) marks.set(key(p),p);
  for (const id of patch.departed) people.delete(id);
  for (const p of patch.peers) people.set(p.id,p);
  for (const version of patch.forgetVersions) { delete ages[version]; delete colors[version]; }
  return {ink:glyphs(ink), marks:glyphs(marks), people, ages:Object.assign(ages,patch.freshness),
    colors:Object.assign(colors,patch.colors)};
}

test('opted-in resize patches reconstruct the full scoped snapshot across translated and cut CJK views', async t => {
  let now = 100_000;
  const app = createTextworld({storagePath:':memory:', now:() => now});
  t.after(() => app.close());
  const world = app.world;
  world.applyWrite({author:'fixture',id:'glyphs',epoch:1,x:58,y:32,text:'한B語a字나'});
  world.applyWrite({author:'fixture',id:'distant',epoch:1,x:3,y:2,text:'隱'});
  world.erase({author:'fixture',id:'mark',epoch:1,x:60,y:32});
  const {port} = await app.listen(0,'127.0.0.1');
  const socket = new WebSocket('ws://127.0.0.1:'+port+'/ws');
  const stream = on(socket,'message');
  const snapshot = async () => {
    for (;;) {
      const {value:[bytes]} = await stream.next();
      const message = JSON.parse(bytes);
      if (message.type === 'snapshot') return message;
    }
  };
  await once(socket,'open'); await snapshot();
  socket.send(JSON.stringify({type:'hello',batchVersion:1,topologyDelta:1,view:{cols:12,rows:5}}));
  const sync = () => { socket.send(JSON.stringify({type:'sync'})); return snapshot(); };
  let full = await sync();
  for (const cut of [10,full.input.state.cursor.x,90]) {
    now += 18000;
    world.resize(world.width+2,world.height,[],{seed:7,seams:{axis:'width',values:Array(world.height).fill(cut)}});
    const barrier = await snapshot();
    assert.ok(barrier.patch);
    assert.equal(barrier.patch.revision,full.viewRevision+1);
    assert.doesNotMatch(JSON.stringify(barrier),/隱/);
    const image = replay(full,barrier);
    full = await sync();
    assert.equal(full.basis,undefined);
    assert.deepEqual(image.ink,glyphs(cells(full.cells)));
    assert.deepEqual(image.marks,glyphs(cells(full.marks)));
    assert.deepEqual(image.people,peers(full.peers));
    assert.deepEqual(image.ages,full.freshness);
    assert.deepEqual(image.colors,full.colors);
    assert.deepEqual(barrier.input,full.input);
  }
  await stream.return();
});

test('rigid reuse removes tombstones and carries the same current bands and CJK closure as a fresh read', async t => {
  const {Observer, createSnapshotFrame} = await import('../server/visibility.js');
  let now = 100_000;
  const app = createTextworld({storagePath:':memory:', now:() => now});
  t.after(() => app.close());
  const world = app.world, peer = {id:'p',name:'p',color:'#123456',x:32,y:8};
  const view = {cols:9,rows:3};
  const obs = new Observer({world,peer,view});
  world.applyWrite({author:'seed',id:'glyphs',epoch:1,x:27,y:8,text:'한a語b字'});
  world.erase({author:'seed',id:'del',epoch:1,x:29,y:8});
  let before = obs.read([peer]);
  for (const elapsed of [1000, 1000, 46000]) {
    const base = {epoch:world.epoch,revision:obs.revision, dx:2, dy:0};
    now += elapsed;
    world.resize(world.width+2,world.height,[peer],{seed:12,seams:{axis:'width',values:Array(world.height).fill(2)}});
    obs.relocate({dx:2,dy:0,bounds:{x:10,y:0,cols:70,rows:20}});
    const frame = createSnapshotFrame(world,[peer]);
    const patch = obs.read([], {frame,topologyDelta:true,translated:true});
    const reference = new Observer({world,peer,view}).read([peer]);
    const reconstructed = replay({...before,world:{epoch:base.epoch},viewRevision:base.revision},{basis:base,patch});
    assert.deepEqual(patch.cells,[]);
    assert.deepEqual(reconstructed.ink,glyphs(cells(reference.cells)));
    assert.deepEqual(reconstructed.marks,glyphs(cells(reference.marks)));
    assert.deepEqual(reconstructed.ages,reference.freshness);
    assert.deepEqual(reconstructed.colors,reference.colors);
    before = reference;
  }
});
