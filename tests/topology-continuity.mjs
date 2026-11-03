import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';
import { mkdir } from 'node:fs/promises';

const app=createTextworld({storagePath:':memory:',now:()=>1000000});
app.world.resize(512,256,[],{seed:1});
const {port}=await app.listen(0,'127.0.0.1');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
try {
  const context=await browser.newContext({viewport:{width:800,height:600}});
  const a=await context.newPage(),b=await context.newPage(),errors=[];
  for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message));
  await Promise.all([a.goto(`http://127.0.0.1:${port}/#x=256&y=128`),b.goto(`http://127.0.0.1:${port}/#x=160&y=128`)]);
  await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.textworld?.inspect().connected)));
  await Promise.all([a,b].map(p=>p.waitForFunction(()=>document.getElementById('intro').hidden)));
  await a.locator('#input').focus();await a.keyboard.insertText('한글');
  await a.waitForFunction(()=>window.textworld.inspect().pending===0&&!window.textworld.inspect().cameraActive);
  const cdp=await context.newCDPSession(a);
  await cdp.send('Input.imeSetComposition',{text:'조',selectionStart:1,selectionEnd:1});
  await a.waitForFunction(()=>window.textworld.inspect().composing);
  const before=await a.evaluate(()=>({state:window.textworld.inspect(),text:document.querySelector('#input').textContent,canvas:document.querySelector('#field').toDataURL()}));
  const values=Array(256).fill(160);values[10]=161;
  const resized=app.world.resize(520,256,undefined,{seed:42,seams:{axis:'width',values,strategy:'coherent-band-v4'}});
  await Promise.all([a,b].map(p=>p.waitForFunction(e=>window.textworld.inspect().world.epoch===e,resized.epoch)));
  const after=await a.evaluate(()=>({state:window.textworld.inspect(),text:document.querySelector('#input').textContent,canvas:document.querySelector('#field').toDataURL()}));
  assert.equal(after.state.composing,true,'remote resize must not cancel native IME');assert.equal(after.text,before.text);
  assert.equal(after.state.lineStartX,before.state.lineStartX+8);
  assert.equal(after.state.cursor.x,before.state.cursor.x+8);
  assert.ok(Math.abs((after.state.cursor.x-after.state.camera.x)-(before.state.cursor.x-before.state.camera.x))<.01);
  assert.equal(after.canvas,before.canvas,'remote geometry must leave actual text and dot pixels unchanged');
  await cdp.send('Input.insertText',{text:'조'});await a.waitForFunction(()=>window.textworld.inspect().pending===0&&!window.textworld.inspect().composing);
  assert.equal(app.world.getCell(before.state.cursor.x+8,before.state.cursor.y).text,'조');
  // Native reconversion must still replace the translated prefix, not append.
  await cdp.send('Input.imeSetComposition',{text:'韓',selectionStart:1,selectionEnd:1,replacementStart:0,replacementEnd:1});
  await cdp.send('Input.insertText',{text:'韓'});await a.waitForFunction(()=>window.textworld.inspect().pending===0);
  assert.equal(app.world.getCell(264,128).text,'韓');assert.equal(app.world.getCell(266,128).text,'글');
  const near=await b.evaluate(()=>window.textworld.inspect());assert.equal(near.composing,false);
  await b.locator('#input').focus();await b.keyboard.insertText('새');await b.waitForFunction(()=>window.textworld.inspect().pending===0);
  assert.equal(app.world.getCell(near.cursor.x,near.cursor.y).text,'새');
  await mkdir('artifacts',{recursive:true});await a.screenshot({path:'artifacts/topology-local-continuity.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS two browsers: remote resize preserves text pixels, active Korean composition and reconversion; a crossed seam corrects the cursor');
} finally {await browser.close();await app.close();}
