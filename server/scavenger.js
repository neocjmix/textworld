/** Independent age policy: the engine only exposes evidence and conditional deletion. */
import { randomUUID } from 'node:crypto';

const base = process.env.TEXTWORLD_URL || 'http://127.0.0.1:3000';
const token = process.env.SCAVENGER_TOKEN;
if (!token) throw new Error('SCAVENGER_TOKEN must match the running server.');
const maxAge = Number(process.env.SCAVENGER_MAX_AGE_MS || 24 * 60 * 60 * 1000);
if (!Number.isFinite(maxAge) || maxAge < 0) throw new Error('SCAVENGER_MAX_AGE_MS must be nonnegative.');
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const evidence = await fetch(`${base}/api/scavenger/evidence?before=${Date.now() - maxAge}`, { headers });
if (!evidence.ok) throw new Error(`Evidence request failed (${evidence.status}).`);
const { epoch, cells } = await evidence.json();
if (!cells.length) console.log('No expired cells.');
else {
  const result = await fetch(`${base}/api/scavenger/delete`, { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), epoch, candidates: cells.map(({ x, y, version }) => ({ x, y, version })) }) });
  if (!result.ok) throw new Error(`Cleanup request failed (${result.status}); rerun against fresh evidence.`);
  console.log(JSON.stringify(await result.json()));
}
