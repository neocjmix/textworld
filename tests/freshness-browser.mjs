import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {createTextworld} from '../server/index.js';
let now=10000000;const app=createTextworld({storagePath:':memory:',now:()=>now});
// Isolate aging from the separate density-resize timer and its epoch remapping.
app.world.adapt=()=>({changed:false,reason:'test'});
app.world.registerAuthor('seed','#304060');
let i=0;for(const [age,text] of [[120000,'이전 글'],[70000,'조금 전'],[30000,'최근 글'],[0,'방금 쓴 글']]){now=10000000-age;app.world.applyWrite({author:'seed',id:String(i),epoch:1,x:50,y:27+i++,text});}now=10000000;
const {port}=await app.listen(0,'127.0.0.1');const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}});await page.goto(`http://127.0.0.1:${port}/#x=64&y=32`);await page.waitForFunction(()=>window.textworld?.inspect().connected&&!window.textworld.inspect().cameraActive);
 assert.equal(await page.locator('#intro').isVisible(),true);
 assert.equal(await page.locator('#help-toggle, #zoom-in, #zoom-out, #coordinates, .freshness-key, .brand').count(),0);
 const geometry=await page.locator('#cursor').boundingBox();assert.ok(Math.abs(geometry.y+geometry.height/2-800*.43)<1);
 await page.waitForTimeout(3700); assert.equal(await page.locator('#intro').isVisible(),false);
 const pixelData=await page.evaluate(()=>{const s=window.textworld.inspect(),ctx=document.querySelector('canvas').getContext('2d');return [27,28,29,30].map(y=>{let x=Math.round((50-s.camera.x)*9),top=Math.round((y-s.camera.y)*26);let image=ctx.getImageData(x,top,18,26).data, darkest=255;for(let i=0;i<image.length;i+=4)darkest=Math.min(darkest,image[i]);return darkest;});});
 assert.ok(pixelData[0]>pixelData[1] && pixelData[1]>pixelData[2] && pixelData[2]>pixelData[3],`opacity ordering ${pixelData}`);
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/freshness-desktop.png'});
 const second=await browser.newPage({viewport:{width:1000,height:800}});await second.goto(`http://127.0.0.1:${port}/#x=64&y=32`);await second.waitForFunction(()=>window.textworld?.inspect().connected);
 const peers=await second.evaluate(()=>window.textworld.inspect().peers);assert.equal(new Set(peers.map(p=>p.color)).size,peers.length);
 await page.keyboard.insertText('한');await page.waitForFunction(()=>window.textworld.inspect().pending===0);const before=await page.locator('#input').innerText();now+=16000;
 await page.waitForFunction(()=>{const s=window.textworld.inspect();const c=s.cells.find(c=>c.x===64&&c.y===32);return c&&s.freshness[c.version]==='recent';},null,{timeout:8000});assert.equal(await page.locator('#input').innerText(),before);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/freshness-mobile.png'});
 await page.reload();await page.waitForFunction(()=>window.textworld?.inspect().connected);assert.equal(await page.locator('#intro').isVisible(),false);
 console.log('Freshness UI: logo timing, removed controls, raised cursor, opacity, unique colors, native input, mobile and reload passed');
}finally{await browser.close();await app.close();}
