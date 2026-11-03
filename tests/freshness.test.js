import test from 'node:test';
import assert from 'node:assert/strict';
import {World} from '../server/world.js';
import {Observer} from '../server/visibility.js';
import {freshness} from '../shared/freshness.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('relative freshness boundaries and unknown ages are conservative',()=>{
 assert.equal(freshness(undefined,0),'old');
 for(const [age,band] of [[0,'now'],[14999,'now'],[15000,'recent'],[45000,'minutes'],[90000,'earlier'],[180000,'old']]) assert.equal(freshness(1000,1000+age),band);
});
test('shared change ages expire without resending text, preserve CJK and scoped erase marks',t=>{
 let now=100000;const w=new World({now:()=>now});t.after(()=>w.close());
 const self={id:'p',x:64,y:32},o=new Observer({world:w,peer:self,view:{cols:8,rows:4}});
 const result=w.applyWrite({id:'one',author:'p',epoch:w.epoch,x:64,y:32,text:'한AB'});
 let read=o.read();assert.equal(Object.keys(read.freshness).length,1);assert.equal(read.freshness[result.seq],'now');assert.equal(read.cells.length,4);assert.ok(read.cells.every(c=>!('updatedAt' in c)&&!('freshness' in c)));
 now+=16000;const aged=o.read([],{since:read.revision});assert.equal(aged.cells.length,0);assert.equal(aged.freshness[result.seq],'recent');assert.ok(aged.revision>read.revision);
 aged.freshness[result.seq]='old';assert.equal(o.read([],{since:aged.revision}).freshness[result.seq],'recent');
 w.erase({id:'erase',author:'p',epoch:w.epoch,x:64,y:32});read=o.read();assert.equal(read.marks.length,2);assert.ok(read.marks.every(m=>m.x===64||m.x===65));
 now+=300000;read=o.read([],{since:read.revision});assert.deepEqual(read.marks,[]);
 w.applyWrite({id:'remote',author:'p',epoch:w.epoch,x:1,y:1,text:'X'});read=o.read([],{since:read.revision});assert.ok(!read.freshness[w.seq]);
});
test('one persisted timestamp per change, compact retries and restart retain evidence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'textworld-time-'));const path=join(dir,'w.sqlite');let w;
 try{
 w=new World({storagePath:path,now:()=>1234567890000});const r=w.applyWrite({id:'batch',author:'p',epoch:w.epoch,x:10,y:10,text:'한'.repeat(50)});
 assert.equal(w.db.prepare('SELECT count(*) n FROM change_times').get().n,1);
 assert.equal(w.db.prepare('SELECT count(*) n FROM cells WHERE updatedAt!=0').get().n,0);
 assert.equal(w.db.prepare('SELECT count(*) n FROM history WHERE updatedAt!=0').get().n,0);
 assert.ok(!w.db.prepare('SELECT result FROM operations').get().result.includes('updatedAt'));
 assert.equal(w.evidence()[0].updatedAt,1234567890000);w.close();w=new World({storagePath:path});
 assert.equal(w.getCell(10,10).updatedAt,1234567890000);assert.deepEqual(w.prior('p','batch').cells,r.cells);
 }finally{w?.close();rmSync(dir,{recursive:true,force:true});}
});

test('many single-character commits share a sparse time marker, then roll into a new interval',t=>{
 let now=100000;const w=new World({now:()=>now});t.after(()=>w.close());
 for(let n=0;n<50;n++){now=100000+n*50;w.applyWrite({id:String(n),author:'p',epoch:1,x:n,y:1,text:'A'});}
 assert.equal(w.db.prepare('SELECT count(*) n FROM change_times').get().n,1);
 assert.equal(w.getCell(49,1).updatedAt,100000);
 assert.equal(w.prior('p','49').cells[0].updatedAt,100000);
 now=105000;w.applyWrite({id:'next',author:'p',epoch:1,x:50,y:1,text:'B'});
 assert.equal(w.db.prepare('SELECT count(*) n FROM change_times').get().n,2);
 assert.equal(w.getCell(50,1).updatedAt,105000);
 assert.equal(w.evidence({before:102000}).length,50);
});

test('existing width-v2 databases back up before moving cell clocks into shared markers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'textworld-time-migration-'));const path=join(dir,'w.sqlite');let w;
 try{
 w=new World({storagePath:path,now:()=>1234567890000});const r=w.applyWrite({id:'legacy',author:'p',epoch:1,x:10,y:10,text:'한A'});
 w.db.exec('DROP TABLE change_times; UPDATE cells SET updatedAt=1234567890000; UPDATE history SET updatedAt=1234567890000;');w.close();
 w=new World({storagePath:path});assert.match(w.migrationBackupPath,/pre-change-times-v3/);
 assert.equal(w.getCell(10,10).updatedAt,1234567890000);assert.equal(w.getCell(10,10).version,r.seq);assert.equal(w.getCell(11,10).width,0);
 assert.equal(w.db.prepare('SELECT updatedAt FROM cells LIMIT 1').get().updatedAt,0);
 assert.equal(w.evidence()[0].updatedAt,1234567890000);
 }finally{w?.close();rmSync(dir,{recursive:true,force:true});}
});
