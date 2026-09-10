import type { SQL } from 'bun';
import { requireRole, type Identity } from '../auth/identity.ts';
import { requireCondition } from '../runtime/errors.ts';

export async function campaignSummary(db: SQL, identity: Identity, id: string) {
  requireRole(identity, 'personal', 'factchecker');
  requireCondition((await db`SELECT id FROM campaigns WHERE id=${id}`).length, 'not_found', 'Campaign unavailable', 404);
  const states = await db<{ state:string; count:number }[]>`SELECT state,count(*)::int AS count FROM jobs WHERE campaign_id=${id} GROUP BY state ORDER BY state`;
  const verdicts = await db<{ verdict:string; count:number }[]>`
    SELECT claim->>'verdict' AS verdict,count(*)::int AS count FROM jobs j,
    jsonb_array_elements(j.result->'records') AS record,
    jsonb_array_elements(record->'claims') AS claim
    WHERE j.campaign_id=${id} AND j.state='complete' GROUP BY claim->>'verdict' ORDER BY verdict`;
  const suggestions = await db<{ count:number }[]>`SELECT COALESCE(sum(jsonb_array_length(result->'suggestions')),0)::int AS count
    FROM jobs WHERE campaign_id=${id} AND state='complete'`;
  return { campaign_id:id, total:states.reduce((sum,row)=>sum+row.count,0),
    finished:!states.some(row=>row.state==='pending'||row.state==='running'), states, verdicts, suggestions:suggestions[0]!.count };
}
