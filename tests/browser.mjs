import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

const app=createTextworld({storagePath:':memory:'});
const address=await app.listen(0,'127.0.0.1');
const url=`http://127.0.0.1:${address.port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const errors=[],checks=[];
const state=p=>p.evaluate(()=>window.textworld.inspect());
const waitCell=(p,x,y,text)=>p.waitForFunction(({x,y,text})=>window.textworld.inspect().cells.find(c=>c.x===x&&c.y===y)?.text===text,{x,y,text});
const ready=p=>p.waitForFunction(()=>window.textworld?.inspect().connected);
const settle=p=>p.waitForFunction(()=>window.textworld.inspect().pending===0);
const check=(label)=>{checks.push(label);console.log(`PASS ${label}`);};
const observe=p=>p.on('pageerror',e=>errors.push(e.message));
function visible(s){const {cols,rows}=s.viewport;for(const [key,length,count] of [['x',s.world.width,cols],['y',s.world.height,rows]]){const v=s.cursor[key]+Math.round((s.camera[key]+count/2-s.cursor[key])/length)*length;assert.ok(v>=s.camera[key]-.001&&v+1<=s.camera[key]+count+.001,`${key} cursor outside viewport`);}}
try {
  await mkdir('artifacts',{recursive:true});
  const ca=await browser.newContext({viewport:{width:1440,height:1000}}), cb=await browser.newContext({viewport:{width:1200,height:900}});
  const a=await ca.newPage(),b=await cb.newPage();observe(a);observe(b);
  await Promise.all([a.goto(url+'/#x=64&y=32'),b.goto(url+'/#x=64&y=32')]);await Promise.all([ready(a),ready(b)]);
  await a.waitForFunction(()=>window.textworld.inspect().peers.length===2);check('two independent browser contexts share live presence');
  await a.locator('#input').focus();await a.keyboard.insertText('안녕👨‍👩‍👧‍👦');await settle(a);
  await waitCell(b,64,32,'안');await waitCell(b,66,32,'👨‍👩‍👧‍👦');assert.equal((await state(a)).cursor.x,67);check('Korean and family emoji occupy one cell per grapheme');
  await b.locator('#input').focus();await b.keyboard.insertText('별');await settle(b);await waitCell(a,64,32,'별');await waitCell(a,65,32,'녕');check('overwrite changes addressed cell without shifting neighbors');
  await b.keyboard.press('Backspace');await settle(b);await a.waitForFunction(()=>!window.textworld.inspect().cells.some(c=>c.x===64&&c.y===32));await waitCell(a,65,32,'녕');check('backspace clears only preceding cell');
  await a.locator('#input').focus();await a.keyboard.insertText('A\tB');await settle(a);assert.equal((await state(a)).cursor.x,73);await b.waitForFunction(()=>window.textworld.inspect().peers.some(p=>p.x===73&&p.y===32));check('tab paste and server presence have identical cursor projection');
  // Chromium's native IME composition path: no synthetic application callback.
  const cdp=await ca.newCDPSession(a);const before=(await state(a)).cells.length;
  await cdp.send('Input.imeSetComposition',{text:'ㅎ',selectionStart:1,selectionEnd:1});
  await cdp.send('Input.imeSetComposition',{text:'하',selectionStart:1,selectionEnd:1});
  await cdp.send('Input.imeSetComposition',{text:'한',selectionStart:1,selectionEnd:1});
  assert.equal((await state(a)).cells.length,before);
  await cdp.send('Input.insertText',{text:'한'});await settle(a);await waitCell(b,73,32,'한');assert.equal((await state(a)).cursor.x,74);check('native Chromium Korean IME sends only final syllable exactly once');
  await a.mouse.move(600,400);await a.mouse.wheel(900,700);await a.waitForTimeout(150);visible(await state(a));check('scroll couples visible cursor and presence');
  for(let i=0;i<10;i++){if(await a.locator('#zoom-out').isEnabled())await a.locator('#zoom-out').click();}
  assert.equal((await state(a)).zoom,.6);visible(await state(a));
  for(let i=0;i<12;i++){if(await a.locator('#zoom-in').isEnabled())await a.locator('#zoom-in').click();}
  assert.equal((await state(a)).zoom,2);visible(await state(a));check('zoom is bounded and cursor stays inside viewport');
  await a.goto(url+'/#x=127&y=63');await ready(a);await a.locator('#input').focus();await a.keyboard.insertText('끝처');await settle(a);await waitCell(b,127,63,'끝');await waitCell(b,0,63,'처');assert.equal((await state(a)).cursor.x,1);await a.keyboard.press('ArrowDown');assert.equal((await state(a)).cursor.y,0);check('writing and movement cross both toroidal seams');
  // Server transport break, reconnect snapshots; no replay of old input.
  for(const ws of app.wss.clients)ws.terminate();
  await a.waitForFunction(()=>!window.textworld.inspect().connected);assert.ok(await a.locator('#input').isDisabled());await ready(a);await ready(b);await waitCell(a,127,63,'끝');assert.equal((await state(a)).pending,0);check('disconnect disables writing, reconnect restores current world');
  await a.goto(url+'/#x=62&y=30');await ready(a);await a.locator('#input').focus();await a.keyboard.insertText('여기, 함께.');await settle(a);
  await a.screenshot({path:'artifacts/desktop.png'});
  const cm=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,geolocation:{latitude:37.5665,longitude:126.978},permissions:['geolocation']});
  const m=await cm.newPage();observe(m);await m.goto(url);await ready(m);await m.waitForFunction(()=>window.textworld.inspect().cursor.x===109);assert.equal((await state(m)).cursor.y,12);check('granted GPS places mobile cursor using client-side projection');
  await cm.setGeolocation({latitude:0,longitude:0});await m.locator('#gps').click();await m.waitForFunction(()=>window.textworld.inspect().cursor.x===64&&window.textworld.inspect().cursor.y===32);check('GPS return obtains updated position');
  const box=await m.locator('#field').boundingBox();await m.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);await m.keyboard.insertText('모바일');await settle(m);visible(await state(m));
  const touch=await cm.newCDPSession(m);
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:190,y:350}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:60,y:230}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});visible(await state(m));
  assert.equal(await m.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await m.screenshot({path:'artifacts/mobile.png'});check('mobile touch selection, typing, drag and layout');
  await m.setViewportSize({width:390,height:520});visible(await state(m));await m.screenshot({path:'artifacts/mobile-keyboard-height.png'});check('short mobile viewport retains visible input and cursor');
  const denied=await browser.newContext();await denied.addInitScript(()=>{Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition:(_ok,fail)=>fail({code:1})}});});
  const d=await denied.newPage();observe(d);await d.goto(url);await ready(d);await d.waitForFunction(()=>document.getElementById('notice').textContent.includes('얻지 못했습니다'));assert.equal(await d.locator('#input').isEnabled(),true);check('denied GPS retains usable shared fallback');
  assert.deepEqual(errors,[]);check('no browser runtime errors');
  console.log(`${checks.length} browser checks passed. Screenshots: artifacts/desktop.png, mobile.png, mobile-keyboard-height.png`);
}finally{await browser.close();await app.close();}
