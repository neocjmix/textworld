import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dashboard } from '../observability/grafana/dashboard.mjs';

const live = 'https://grafana-production-7d77bc6c.up.railway.app';
const url = new URL(process.env.GRAFANA_TEST_URL || live);
const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
if (!local && url.origin !== live) throw Error('Use the Textworld Grafana origin or a loopback fixture.');
const password = process.env.GF_SECURITY_ADMIN_PASSWORD;
if (!password) throw Error('Provide the operator password via GF_SECURITY_ADMIN_PASSWORD.');
const options = { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] };
if (!local && process.env.HTTPS_PROXY) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  options.proxy = { server: proxy.protocol + '//' + proxy.host };
  if (proxy.username) options.proxy.username = decodeURIComponent(proxy.username);
  if (proxy.password) options.proxy.password = decodeURIComponent(proxy.password);
}
const browser = await chromium.launch(options);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], path = url.origin + '/d/' + dashboard.uid;
  let queries = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/ds/query') &&
      request.postDataJSON()?.queries?.some(q => q.datasource?.uid === 'textworld-metrics')) queries++;
  });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=password]').waitFor();
  const loginUrl = new URL(page.url());
  assert.equal(loginUrl.origin, url.origin);
  assert.equal(loginUrl.pathname, '/login');
  const anonymousStatus = await page.evaluate(async () => (await fetch('/api/dashboards/uid/textworld-usage')).status);
  assert.equal(anonymousStatus, 401);
  const loginStatus = await page.evaluate(async secret => {
    const response = await fetch('/login', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: secret }) });
    return response.status;
  }, password);
  assert.equal(loginStatus, 200);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  for (const panel of dashboard.panels) {
    const title = page.getByText(panel.title, { exact: true }).first();
    await title.scrollIntoViewIfNeeded();
    await title.waitFor();
    for (const field of panel.fieldConfig.overrides) {
      const legend = page.getByText(field.matcher.options, { exact: true }).first();
      await legend.waitFor();
    }
  }
  assert.equal(queries, 1);
  assert.deepEqual(errors, []);
  await page.getByText(dashboard.panels[0].title, { exact: true }).first().scrollIntoViewIfNeeded();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/grafana-dashboard.png' });
  const health = await page.evaluate(async () => {
    const response = await fetch('/api/datasources/uid/textworld-metrics/health');
    return { code: response.status, status: (await response.json()).status };
  });
  assert.deepEqual(health, { code: 200, status: 'OK' });
  console.log(JSON.stringify({ origin: url.origin, panels: dashboard.panels.length, queries, anonymousStatus, dataSource: health.status }));
} finally {
  await browser.close();
}
