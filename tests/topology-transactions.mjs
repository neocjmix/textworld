import assert from'node:assert/strict';import{chromium}from'playwright';import{createTextworld}from'../server/index.js';import{TextworldAgent}from'../sdk/textworld-agent.mjs';
const app=createTextworld({storagePath:':memory:',now:()=>1000000});const{port}=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});let agent;
try{
 const context=await browser.newContext();let hold=true;const queued=[],errors=[];
 await context.routeWebSocket('**/ws',ws=>{const server=ws.connectToServer();ws.onMessage(data=>{const m=JSON.parse(String(data));if(hold&&m.type==='write')queued.push(()=>server.send(data));else server.send(data);});server.onMessage(data=>{const m=JSON.parse(String(data));if(m.type==='error')errors.push(m);ws.send(data);});});
 const p=await context.newPage();await p.goto(base+'/#x=7&y=8');await p.waitForFunction(()=>window.textworld?.inspect().connected);await p.locator('#input').focus();await p.keyboard.insertText('한');await p.waitForFunction(()=>window.textworld.inspect().pending===1);assert.equal(app.world.seq,0);
 const resize=app.world.resize(64,32,undefined,{seed:42});await p.waitForFunction(e=>window.textworld.inspect().world.epoch===e,app.world.epoch);const after=await p.evaluate(()=>window.textworld.inspect());assert.equal(after.pending,0);
 hold=false;for(const send of queued)send();await p.waitForTimeout(150);assert.ok(errors.some(e=>e.code==='STALE_EPOCH'));assert.equal(app.world.seq,resize.seq);assert.equal(app.world.snapshot().cells.length,0);
 await p.locator('#input').focus();await p.keyboard.insertText('나');await p.waitForFunction(()=>window.textworld.inspect().pending===0);assert.equal(app.world.getCell(after.cursor.x,after.cursor.y).text,'나');console.log('PASS delayed pre-resize native write is rejected atomically; fresh input uses remapped position');await context.close();
 agent=await TextworldAgent.connect(base,{name:'transaction test'});const pending=agent.turn([{type:'type',text:'ABCD'}],{id:'old-turn'}).catch(e=>e);
 while(![...app.world.cells.values()].some(c=>c.text==='A'))await new Promise(r=>setTimeout(r,5));
 app.world.resize(128,64,undefined,{seed:43});const blocked=await pending;assert.equal(blocked.status,409);assert.equal(blocked.turn.completedSteps,1);assert.ok(!app.world.snapshot().cells.some(c=>c.text==='B'||c.text==='C'||c.text==='D'));
 const accepted=await agent.turn([{type:'type',text:'Z'}],{id:'new-turn'});assert.equal(accepted.turn.status,'completed');console.log('PASS running agent turn stops at epoch boundary; new transaction succeeds with reset writing origin');
}finally{await agent?.close();await browser.close();await app.close();}
