import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {createTextworld} from '../server/index.js';
let now=10000000;const app=createTextworld({storagePath:':memory:',now:()=>now});
let i=0;for(const [age,text] of [[4000000,'오래된 글'],[400000,'이전 글'],[120000,'몇 분 전'],[30000,'최근 글'],[0,'방금 쓴 글']]){now=10000000-age;app.world.applyWrite({author:'seed',id:String(i),epoch:1,x:50,y:27+i++,text});}now=10000000;
const {port}=await app.listen(0,'127.0.0.1');const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}});await page.goto(`http://127.0.0.1:${port}/#x=64&y=32`);await page.waitForFunction(()=>window.textworld?.inspect().connected&&window.textworld.inspect().freshness&& !window.textworld.inspect().cameraActive);
 await page.waitForTimeout(150);
 const colors=await page.evaluate(()=>{const s=window.textworld.inspect(),ctx=document.querySelector('canvas').getContext('2d');return [27,28,29,30,31].map(y=>[...ctx.getImageData(Math.round((50-s.camera.x)*9+3),Math.round((y-s.camera.y)*26+4),1,1).data]);});
 assert.deepEqual(colors[4].slice(0,3),[243,207,119]);assert.deepEqual(colors[3].slice(0,3),[242,225,170]);assert.deepEqual(colors[2].slice(0,3),[240,238,217]);assert.deepEqual(colors[0].slice(0,3),[248,248,242]);
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/freshness-desktop.png'});
 await page.keyboard.insertText('한');await page.waitForFunction(()=>window.textworld.inspect().pending===0);const before=await page.locator('#input').innerText();now+=16000;
 await page.waitForFunction(()=>{const s=window.textworld.inspect();const c=s.cells.find(c=>c.x===64&&c.y===32);return c&&s.freshness[c.version]==='recent';},null,{timeout:8000});assert.equal(await page.locator('#input').innerText(),before);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/freshness-mobile.png'});assert.ok(await page.locator('.freshness-key').isVisible());
 console.log('3/3 freshness browser checks passed: age colors; automatic aging preserves native input; mobile legend');
}finally{await browser.close();await app.close();}
