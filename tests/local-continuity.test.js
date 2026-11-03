import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextworld } from '../server/index.js';
import { connect } from './ws-client.js';
import { TextworldAgent } from '../sdk/textworld-agent.mjs';

test('remote remesh preserves local native ownership but rejects delayed old-epoch writes',async t=>{
  const app=createTextworld({storagePath:':memory:',now:()=>1000000});t.after(()=>app.close());
  app.world.resize(512,256,[],{seed:1});
  const {port}=await app.listen(0,'127.0.0.1');
  const a=connect(`ws://127.0.0.1:${port}/ws`), b=connect(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([a,b].map(c=>c.next(m=>m.type==='snapshot')));
  await b.locate(160,128);
  const epoch=app.world.epoch;
  a.send({type:'write',id:'context',epoch,x:256,y:128,text:'한글',lineStartX:256});
  await a.next(m=>m.type==='ack'&&m.id==='context');
  const values=Array(256).fill(160);values[10]=161;
  app.world.resize(520,256,undefined,{seed:42,seams:{axis:'width',values,strategy:'coherent-band-v4'}});
  const [far,near]=await Promise.all([a,b].map(c=>c.next(m=>m.type==='snapshot'&&m.world.epoch===epoch+1)));
  assert.deepEqual([far.resize.relocation.dx,far.resize.relocation.dy],[8,0]);
  assert.equal(near.resize.relocation,undefined);
  assert.equal(JSON.stringify(far).includes('seams'),false,'no remote seam geometry may leak through participant transport');
  const seq=app.world.seq;
  a.send({type:'write',id:'late',epoch,x:260,y:128,text:'X'});
  await a.next(m=>m.type==='error'&&m.code==='STALE_EPOCH');assert.equal(app.world.seq,seq);
  a.send({type:'write',id:'reconversion',epoch:epoch+1,x:264,y:128,text:'韓',clear:[{x:264,y:128},{x:265,y:128}],lineStartX:264});
  await a.next(m=>m.type==='ack'&&m.id==='reconversion');
  assert.equal(app.world.getCell(264,128).text,'韓');assert.equal(app.world.getCell(266,128).text,'글');
  // Translation only retains addresses the participant already wrote.
  a.send({type:'write',id:'outside',epoch:epoch+1,x:264,y:128,text:'X',clear:[{x:300,y:128}],lineStartX:264});
  await a.next(m=>m.type==='error'&&m.id==='outside');assert.equal(app.world.getCell(264,128).text,'韓');
});

test('failed remesh leaves participants and native permissions in the original epoch',async t=>{
  const app=createTextworld({storagePath:':memory:',now:()=>1000000});t.after(()=>app.close());
  app.world.resize(512,256,[],{seed:1});const{port}=await app.listen(0,'127.0.0.1');
  const a=connect(`ws://127.0.0.1:${port}/ws`);await a.next(m=>m.type==='snapshot');
  const epoch=app.world.epoch;
  a.send({type:'write',id:'before',epoch,x:256,y:128,text:'한'});await a.next(m=>m.type==='ack'&&m.id==='before');
  const before=app.world.snapshot();
  app.world.db.exec("CREATE TRIGGER deny_topology BEFORE INSERT ON topology_events BEGIN SELECT RAISE(ABORT, 'rollback'); END");
  const values=Array(256).fill(160);values[10]=161;
  assert.throws(()=>app.world.resize(520,256,undefined,{seed:42,seams:{axis:'width',values}}));
  assert.deepEqual(app.world.snapshot(),before);
  a.send({type:'write',id:'after',epoch,x:256,y:128,text:'韓',clear:[{x:256,y:128},{x:257,y:128}]});
  await a.next(m=>m.type==='ack'&&m.id==='after');assert.equal(app.world.getCell(256,128).text,'韓');
});

test('HTTP observers receive a reset after a locally rigid translation, with no stale cache addresses',async t=>{
  const app=createTextworld({storagePath:':memory:',now:()=>1000000});t.after(()=>app.close());
  app.world.resize(512,256,[],{seed:1});const{port}=await app.listen(0,'127.0.0.1');
  const a=await TextworldAgent.connect(`http://127.0.0.1:${port}`,{name:'translation'});
  await a.turn([{type:'type',text:'한'}]);
  const values=Array(256).fill(160);values[10]=161;
  app.world.resize(520,256,undefined,{seed:42,seams:{axis:'width',values}});
  const response=await a.turn([]);
  assert.equal(response.observation.reset,true);
  assert.equal(response.observation.cells.find(c=>c.text==='한').x,264);
  assert.ok(!response.observation.cells.some(c=>c.x===256));
  await a.close();
});
