import type { SQL } from 'bun';

export async function seed(db: SQL): Promise<void> {
  await db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(71822002)`;
    const done = await tx`SELECT value FROM instance_state WHERE key='seed-v3'`;
    if (done.length) return;
    // Schema migrations own fixed kinds. Instance organization and onboarding are optional.
    await tx`INSERT INTO instance_state VALUES ('seed-v3','true'::jsonb)`;
  });
}
