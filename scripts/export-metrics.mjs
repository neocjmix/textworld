import { writeFile, mkdir } from 'node:fs/promises';
import { readMetrics } from './read-metrics.mjs';

const [base, period = '3600', path = 'artifacts/metrics-export.json'] = process.argv.slice(2);
const data = await readMetrics({ base, period: Number(period) });
await mkdir('artifacts', { recursive: true });
await writeFile(path, JSON.stringify(data, null, 2));
console.log(JSON.stringify({ ...data, rows: data.rows.length, path }));
