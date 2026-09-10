import type { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { requireRole, type Identity } from '../auth/identity.ts';
import { Reader, type Snapshot } from '../content/reads.ts';
import { requireCondition } from '../runtime/errors.ts';
import { workflow, type Kind, type WorkSettings } from './protocol.ts';
import { resultJsonSchema } from './result-json-schema.ts';
import { type Transaction } from '../storage/database.ts';

export async function emitEvent(tx: Transaction, job: string | null, kind: string, detail: Record<string, unknown>) {
  const id = randomUUID();
  const payload = { version: 1, event_id: id, job_id: job, kind, detail };
  await tx`INSERT INTO events(id,job_id,kind,detail) VALUES(${id},${job},${kind},${detail}::jsonb)`;
  await tx`INSERT INTO outbox(id,channel,payload) VALUES(${id},'notification',${payload}::jsonb)`;
}
export interface Job {
  id: string; kind: Kind; state: string; snapshot: Snapshot; executor: string | null;
  claim_token: string | null; lease_until: Date | null; attempts: number; fingerprint: string;
  revision_id: string; target_id: string; progress: unknown; result: unknown; result_hash: string | null;
}
export async function dispatch(tx: Transaction, id: string, kind: Kind, snapshot: Snapshot) {
  await tx`INSERT INTO outbox(id,channel,payload,available_at)
    SELECT ${randomUUID()},${kind},${{ version:1,job_id:id,kind,workflow,snapshots:[snapshot],result_schema:resultJsonSchema }}::jsonb,available_at
    FROM jobs WHERE id=${id}`;
}
export class Queue {
  constructor(readonly db: SQL, readonly settings: WorkSettings) {}
  private enabled(kind: Kind) { requireCondition(this.settings[kind], 'disabled', `${kind} is disabled`); }

  async detect(identity: Identity) {
    this.enabled('factcheck'); requireRole(identity, 'personal', 'factchecker');
    return this.db.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(71822003)`;
      const candidates = await tx<{ id: string; revision: string; fingerprint: string }[]>`
        SELECT r.id,v.id AS revision,v.content_hash AS fingerprint FROM records r JOIN revisions v ON v.id=r.current_revision
        WHERE NOT r.archived AND r.type NOT IN ('raw-source','meta','adr') AND NOT v.generated
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.kind='factcheck' AND j.target_id=r.id AND j.fingerprint=v.content_hash)
        ORDER BY r.id LIMIT 100`;
      const capacity = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM jobs WHERE kind='factcheck' AND state IN ('pending','running')`;
      const reader = new Reader(tx, identity, { publicEnabled: false });
      const created: string[] = [];
      for (const candidate of candidates.slice(0, Math.max(0, 100 - capacity[0]!.count))) {
        created.push(await this.enqueue(tx, 'factcheck', null, await reader.page(candidate.id, candidate.revision)));
      }
      return { queued: created.length };
    });
  }
  private async enqueue(tx: Transaction, kind: Kind, campaign: string | null, snapshot: Snapshot) {
    const id = randomUUID();
    await tx`INSERT INTO jobs(id,kind,campaign_id,target_id,revision_id,fingerprint,snapshot)
      VALUES(${id},${kind},${campaign},${snapshot.id},${snapshot.revision},${snapshot.content_hash},${snapshot}::jsonb)`;
    await dispatch(tx,id,kind,snapshot);
    return id;
  }
  async reviewStart(identity: Identity, ids: string[], key: string) {
    this.enabled('review'); requireRole(identity, 'personal');
    return this.db.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(71822002)`;
      await tx`SELECT pg_advisory_xact_lock(71822003)`;
      const previous = await tx`SELECT request_hash,response FROM idempotency WHERE actor=${identity.actor} AND key=${`review:${key}`}`;
      const requestHash = [...new Set(ids)].sort().join(',');
      if (previous.length) {
        requireCondition(previous[0].request_hash === requestHash, 'idempotency_conflict', 'Review key reused', 409);
        return previous[0].response;
      }
      const campaign = randomUUID();
      await tx`INSERT INTO campaigns(id,actor) VALUES(${campaign},${identity.actor})`;
      const reader = new Reader(tx, identity, { publicEnabled: false });
      const jobs: string[] = [];
      for (const id of new Set(ids)) jobs.push(await this.enqueue(tx, 'review', campaign, await reader.page(id)));
      const response = { campaign_id: campaign, jobs };
      await tx`INSERT INTO idempotency VALUES(${identity.actor},${`review:${key}`},${requestHash},${response}::jsonb)`;
      return response;
    });
  }
  async scheduledReview(identity: Identity, intervalSeconds: number) {
    if (!this.settings.review || intervalSeconds <= 0) return { started:false };
    requireRole(identity,'personal');
    return this.db.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(71822002)`;
      await tx`SELECT pg_advisory_xact_lock(71822003)`;
      const previous = await tx<{ value: { at:string } }[]>`SELECT value FROM instance_state WHERE key='periodic-review'`;
      if (previous.length && Date.now()-Date.parse(previous[0]!.value.at) < intervalSeconds*1000) return { started:false };
      const active = await tx`SELECT id FROM jobs WHERE kind='review' AND state IN ('pending','running') LIMIT 1`;
      if (active.length) return { started:false };
      const targets = await tx<{ id:string; revision:string }[]>`SELECT r.id,r.current_revision AS revision FROM records r JOIN revisions v ON v.id=r.current_revision
        WHERE NOT r.archived AND r.type NOT IN ('raw-source','meta','adr') AND NOT v.generated ORDER BY r.id`;
      const campaign=randomUUID(), reader=new Reader(tx,identity,{publicEnabled:false});
      await tx`INSERT INTO campaigns(id,actor) VALUES(${campaign},${identity.actor})`;
      for(const target of targets) await this.enqueue(tx,'review',campaign,await reader.page(target.id,target.revision));
      await tx`INSERT INTO instance_state VALUES('periodic-review',${{at:new Date().toISOString()}}::jsonb)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
      return { started:true,campaign_id:campaign };
    });
  }
  async next(identity: Identity, kind: Kind) {
    this.enabled(kind); requireRole(identity, 'personal', 'factchecker');
    if (kind === 'factcheck') await this.detect(identity);
    const jobs = await this.db<{ id: string }[]>`SELECT id FROM jobs WHERE kind=${kind} AND state='pending' AND available_at<=now() ORDER BY created_at,id LIMIT 1`;
    return jobs.length ? this.snapshot(identity, jobs[0]!.id) : null;
  }
  async snapshot(identity: Identity, id: string) {
    requireRole(identity, 'personal', 'factchecker');
    const jobs = await this.db<Job[]>`SELECT * FROM jobs WHERE id=${id}`;
    requireCondition(jobs.length, 'not_found', 'Assignment unavailable', 404);
    const job = jobs[0]!;
    return { version: 1, job_id: id, kind: job.kind, state: job.state, workflow, snapshots: [job.snapshot],
      progress: job.executor === identity.actor || identity.role === 'personal' ? job.progress : null, result_schema: resultJsonSchema };
  }
  async claim(identity: Identity, id: string) {
    requireRole(identity, 'personal', 'factchecker');
    return this.db.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(71822003)`;
      const rows = await tx<Job[]>`SELECT * FROM jobs WHERE id=${id} FOR UPDATE`;
      requireCondition(rows.length, 'not_found', 'Assignment unavailable', 404);
      const job = rows[0]!; this.enabled(job.kind);
      requireCondition(job.state === 'pending', 'claim_conflict', 'Assignment is not available', 409);
      const count = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM jobs WHERE kind=${job.kind} AND state='running' AND lease_until>now()`;
      requireCondition(count[0]!.count < this.settings.concurrency[job.kind], 'capacity', 'Execution capacity is full', 409);
      const token = randomUUID();
      const changed = await tx`UPDATE jobs SET state='running',executor=${identity.actor},claim_token=${token},attempts=attempts+1,
        lease_until=now()+${this.settings.leaseSeconds}*interval '1 second',updated_at=now()
        WHERE id=${id} AND available_at<=now() RETURNING lease_until`;
      requireCondition(changed.length, 'claim_conflict', 'Assignment is not available', 409);
      return { job_id: id, claim_token: token, lease_until: changed[0].lease_until };
    });
  }
  async progress(identity: Identity, id: string, token: string, progress: unknown) {
    requireRole(identity, 'personal', 'factchecker');
    requireCondition(JSON.stringify(progress).length <= 100_000, 'invalid_input', 'Progress is too large');
    const rows = await this.db`UPDATE jobs SET progress=${progress}::jsonb,lease_until=now()+${this.settings.leaseSeconds}*interval '1 second',updated_at=now()
      WHERE id=${id} AND executor=${identity.actor} AND claim_token=${token} AND state='running' AND lease_until>now() RETURNING id`;
    requireCondition(rows.length, 'stale_claim', 'Assignment lease is no longer owned', 409);
    return { saved: true };
  }
  async recover() {
    await this.db.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(71822003)`;
      const expired = await tx<Job[]>`SELECT * FROM jobs WHERE state='running' AND lease_until<now() FOR UPDATE`;
      for (const job of expired) {
        await tx`UPDATE jobs SET state=${job.attempts >= this.settings.maxAttempts ? 'failed' : 'pending'},claim_token=NULL,executor=NULL,
          available_at=now()+interval '1 minute',updated_at=now() WHERE id=${job.id}`;
        await emitEvent(tx, job.id, 'lease_expired', { attempts: job.attempts });
        if (job.attempts < this.settings.maxAttempts) await dispatch(tx,job.id,job.kind,job.snapshot);
      }
      const unattended = await tx<{ id: string }[]>`SELECT id FROM jobs WHERE state='pending' AND created_at<now()-interval '1 day'
        AND NOT EXISTS(SELECT 1 FROM events e WHERE e.job_id=jobs.id AND e.kind='missing_executor') LIMIT 100`;
      for (const job of unattended) await emitEvent(tx, job.id, 'missing_executor', {});
    });
  }
}
