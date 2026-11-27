import http from 'node:http';
import { readFile } from 'node:fs/promises';

export const production = 'https://textworld-production-987c.up.railway.app';

export async function readMetrics({ base = production, period = 3600, since = 0, before = Date.now(),
  limit = 1000, token, fetchPage = fetch } = {}) {
  http.setGlobalProxyFromEnv?.();
  token ??= process.env.TEXTWORLD_METRICS_TOKEN || (await readFile('artifacts/metrics-token', 'utf8')).trim();
  const rows = new Map();
  let after, meta;
  const seenCursors = new Set();
  for (;;) {
    const url = new URL('/api/metrics', base);
    url.search = new URLSearchParams({ period, since, before, limit });
    if (after) url.searchParams.set('after', JSON.stringify(after));
    const response = await fetchPage(url, { headers: { authorization: 'Bearer ' + token },
      redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('운영 계측 조회 실패 (HTTP ' + response.status + ')');
    const page = await response.json();
    const { schema, builds, runtime, enabled, revision, failures } = page;
    meta = { schema, builds, runtime, enabled, revision, failures };
    for (const row of page.rows) rows.set(JSON.stringify([row.bucket, row.revision, row.metric]), row);
    if (Object.hasOwn(page, 'next')) {
      if (!page.next) break;
      after = page.next;
    } else {
      // Exports also work against releases with the original inclusive time cursor.
      if (page.rows.length < limit) break;
      before = page.rows.at(-1).bucket;
    }
    const cursor = JSON.stringify(after ?? before);
    if (seenCursors.has(cursor)) throw Error('계측 페이지가 진행되지 않았습니다.');
    seenCursors.add(cursor);
  }
  return { ...meta, exportedAt: new Date().toISOString(), rows: [...rows.values()] };
}
