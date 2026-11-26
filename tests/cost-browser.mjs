import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import { releaseCost, monthlyCost } from '../public/operating-cost-model.js';
import { createTextworld } from '../server/index.js';
let app, url = process.argv[2];
if (!url) {
  app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
  const address = await app.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${address.port}/cost.html`;
}
const cfg={headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']};
if(url.startsWith('https:')&&process.env.HTTPS_PROXY){const p=new URL(process.env.HTTPS_PROXY);cfg.proxy={server:p.protocol+'//'+p.host};if(p.username)cfg.proxy.username=decodeURIComponent(p.username);if(p.password)cfg.proxy.password=decodeURIComponent(p.password);}
const browser=await chromium.launch(cfg);
const usd=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
try{
 for(const width of [390,1200]){
  const page=await browser.newPage({viewport:{width,height:850},ignoreHTTPSErrors:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url,{waitUntil:'networkidle',timeout:30000});
  const value=async id=>page.locator('#'+id).innerText();
  assert.equal(await value('release-total'),usd(releaseCost().total));
  assert.equal(await page.locator('#release-hours').isVisible(),false);
  await page.locator('#release-font-scope').selectOption('all');
  assert.equal(await value('release-total'),usd(releaseCost({fontScope:'all'}).total));
  await page.locator('#release-font-scope').selectOption('mixed');
  assert.equal(await value('release-total'),usd(releaseCost().total));
  await page.locator('#release-layout').selectOption('mix');
  await page.locator('#release-hours').fill('0');
  assert.equal(await value('release-total'),usd(releaseCost({scenario:'mix',plazaHours:0}).total));
  await page.locator('#release-hours').fill('24');
  assert.equal(await value('release-total'),usd(releaseCost({scenario:'mix',plazaHours:24}).total));
  await page.locator('#release-hours').fill('');
  assert.equal(await value('release-total'),'—');
  await page.locator('#release-layout').selectOption('steady');
  assert.equal(await value('release-total'),usd(releaseCost().total));
  await page.locator('#release-cold').fill('101');
  assert.equal(await value('release-total'),'—');
  await page.locator('#release-cold').fill('20');
  await page.locator('main > details > summary').click();
  assert.equal(await value('total'),usd(monthlyCost({concurrent:1000}).total));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors,[]);
  console.log('PASS',width,'px, measured baseline, two endpoints, invalid inputs and historical model');
  await page.close();
 }
}finally{await browser.close();await app?.close();}
