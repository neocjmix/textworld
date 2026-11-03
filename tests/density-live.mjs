// Real time, native browser edits and the production one-second resize timer.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const app=createTextworld({storagePath:':memory:'});app.world.resize(32,16,[],{seed:1});
const {port}=await app.listen(0,'127.0.0.1');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
try {
  const context=await browser.newContext({viewport:{width:800,height:600}});
  const pages=await Promise.all([context.newPage(),context.newPage()]),errors=[],protocol=[],inputBytes=[],contextBytes=[];
  for(const page of pages){page.on('pageerror',e=>errors.push(e.message));page.on('websocket',ws=>{
    ws.on('framereceived',e=>{
      const m=JSON.parse(String(e.payload));if(m.type==='error')protocol.push(m.code);
      if(m.type==='snapshot')contextBytes.push(Buffer.byteLength(JSON.stringify(m.input)));
    });
    ws.on('framesent',e=>{const m=JSON.parse(String(e.payload));if(m.type==='input')inputBytes.push(Buffer.byteLength(String(e.payload)));});
  });}
  await Promise.all(pages.map((p,i)=>p.goto(`http://127.0.0.1:${port}/#x=2&y=${4+i*6}`)));
  await Promise.all(pages.map(p=>p.waitForFunction(()=>window.textworld?.inspect().connected)));
  const initialEpoch=app.world.epoch;let peakDensity=0;
  for(let step=0;step<30;step++){
    for(const [i,page]of pages.entries()){
      await page.locator('#input').focus();await page.keyboard.insertText(i?'世界':'한글');
      if(step%6===5)await page.keyboard.press('Enter');
    }
    await Promise.all(pages.map(p=>p.waitForFunction(()=>window.textworld.inspect().pending===0)));
    peakDensity=Math.max(peakDensity,app.world.ink/(app.world.width*app.world.height));
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(app.world.epoch>initialEpoch+2);
  assert.ok(app.world.ink/(app.world.width*app.world.height)<.15);
  assert.deepEqual(errors,[]);assert.deepEqual(protocol,[],'automatic resize must not reject a cursor intention');
  const count=app.world.db.prepare("SELECT count(*) n FROM operations WHERE author!='expiry'").get().n;
  assert.equal(count,60,'all 60 native edits must commit during real automatic resizing');
  const bytes=values=>({count:values.length,sum:values.reduce((a,b)=>a+b,0),max:Math.max(...values),mean:values.reduce((a,b)=>a+b,0)/values.length});
  const result={nativeEdits:60,committed:count,peakDensity,finalDensity:app.world.ink/(app.world.width*app.world.height),
    world:app.world.metadata(),resizes:app.world.epoch-initialEpoch,protocolErrors:protocol,pageErrors:errors,
    inputBytes:bytes(inputBytes),contextSnapshotBytes:bytes(contextBytes)};
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/density-browser.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {await browser.close();await app.close();}
