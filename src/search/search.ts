import { Reader } from '../content/reads.ts';
import { requireCondition } from '../runtime/errors.ts';
export interface SearchOptions { query: string; mode: 'auto' | 'strict' | 'broad'; limit: number; type?: string; tag?: string }

export async function search(reader: Reader, options: SearchOptions) {
  reader.ensureAccess();
  const words = options.query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 40) ?? [];
  if (!words.length) return [];
  async function execute(broad: boolean) {
    const query = words.join(broad ? ' OR ' : ' ');
    return reader.db<{ id: string; revision: string; title: string; slug: string; score: number; excerpt: string }[]>`
      WITH allowed AS MATERIALIZED (
        SELECT r.type,v.* FROM records r
        JOIN revisions v ON v.id=CASE WHEN ${reader.privateAccess} THEN r.current_revision ELSE r.published_revision END
        WHERE NOT r.archived AND (${options.type ?? null}::text IS NULL OR r.type=${options.type ?? null})
        AND (${options.tag ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM revision_tags t WHERE t.revision_id=v.id AND t.tag=${options.tag ?? null}))
      ), query AS (SELECT websearch_to_tsquery('english',${query}) en,websearch_to_tsquery('russian',${query}) ru)
      SELECT a.record_id AS id,a.id AS revision,a.title,a.slug,
        greatest(ts_rank_cd(a.search_en,q.en),ts_rank_cd(a.search_ru,q.ru)) AS score,
        left(a.body,1000) AS excerpt FROM allowed a CROSS JOIN query q
      WHERE a.search_en @@ q.en OR a.search_ru @@ q.ru ORDER BY score DESC,a.record_id LIMIT ${options.limit}`;
  }
  const results = await execute(options.mode === 'broad');
  return results.length || options.mode !== 'auto' ? results : execute(true);
}

export async function regexSearch(reader: Reader, pattern: string, limit: number) {
  reader.ensureAccess();
  requireCondition(pattern.length > 0 && pattern.length <= 1000 && !pattern.includes('\0'), 'invalid_pattern', 'Invalid regex');
  const records = await reader.list({ limit: 501, offset: 0 });
  const lines: { id: string; revision: string; line: number; text: string }[] = [];
  let size = 0, truncated = records.length > 500;
  for (const record of records.slice(0, 500)) {
    const page = await reader.page(record.id, record.revision);
    if (size + Buffer.byteLength(page.body) > 5_000_000) { truncated = true; break; }
    size += Buffer.byteLength(page.body);
    page.body.split('\n').forEach((text, index) => lines.push({ id: page.id, revision: page.revision, line: index + 1, text }));
  }
  const child = Bun.spawn(['rg','--json','--color','never','--max-count',String(limit),'-e',pattern], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.stdin.write(lines.map(line => line.text).join('\n'));
  child.stdin.end();
  try {
    const output = await new Response(child.stdout).text();
    const code = await child.exited;
    requireCondition(code === 0 || code === 1, 'invalid_pattern', 'Regex failed or exceeded its execution limit');
    const matches = output.split('\n').filter(Boolean).flatMap(line => {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== 'object' || !('type' in event) || event.type !== 'match' || !('data' in event)) return [];
      const data = event.data;
      if (!data || typeof data !== 'object' || !('line_number' in data) || typeof data.line_number !== 'number') return [];
      const match = lines[data.line_number - 1];
      return match ? [{ ...match, text: match.text.slice(0, 2000) }] : [];
    });
    return { matches: matches.slice(0,limit), truncated: truncated || matches.length >= limit };
  } finally { clearTimeout(timer); child.kill(); }
}
