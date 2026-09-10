import type { SQL } from 'bun';
import { initialTags } from '../content/taxonomy.ts';

export async function seed(db: SQL): Promise<void> {
  await db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(71822002)`;
    const done = await tx`SELECT value FROM instance_state WHERE key='seed-v1'`;
    if (done.length) return;
    for (const tag of initialTags) await tx`INSERT INTO taxonomy VALUES (${tag},${`Reusable semantic facet: ${tag}`}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO instance_state VALUES ('seed-v1','true'::jsonb)`;
  });
}
