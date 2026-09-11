import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { requireRole, type Identity } from '../auth/identity.ts';
import { canonical, type Document } from '../content/schema.ts';
import { writeRevision } from '../content/changes.ts';
import { sha256 } from '../storage/database.ts';
import { requireCondition } from '../runtime/errors.ts';
import { resultSchema } from './protocol.ts';
import { dispatch, emitEvent, type Job } from './queue.ts';
import {isNativeSnapshot} from './snapshot.ts';
import {writeCoreRevision} from '../content/core-write.ts';
import {coreDocumentSchema} from '../content/core-schema.ts';

export async function complete(db: SQL, identity: Identity, id: string, token: string, input: unknown) {
  requireRole(identity, 'personal', 'factchecker');
  const parsed = resultSchema.safeParse(input);
  requireCondition(parsed.success, 'invalid_result', 'Result does not match the required schema');
  const result = parsed.data;
  const resultHash = sha256(canonical(result));
  return db.begin(async tx => {
    const rows = await tx<Job[]>`SELECT * FROM jobs WHERE id=${id} FOR UPDATE`;
    requireCondition(rows.length, 'not_found', 'Assignment unavailable', 404);
    const job = rows[0]!;
    requireCondition(job.executor === identity.actor && job.claim_token === token, 'stale_claim', 'Assignment is not owned', 409);
    if (job.state === 'complete' || job.state === 'blocked') {
      requireCondition(job.result_hash === resultHash, 'result_conflict', 'Different result already accepted', 409);
      return { job_id: id, state: job.state };
    }
    requireCondition(job.state === 'running' && job.lease_until && job.lease_until.getTime() > Date.now(), 'stale_claim', 'Assignment lease expired', 409);
    requireCondition(result.records.length === 1 && result.records[0]!.id === job.target_id && result.records[0]!.revision === job.revision_id,
      'invalid_coverage', 'Cover exactly the assigned snapshots');
    const entry = result.records[0]!;
    requireCondition((entry.coverage === 'checked') === (entry.claims.length > 0), 'invalid_coverage', 'Checked coverage requires claims; other coverage must not contain claims');
    requireCondition(!['skipped','blocked','no_claims'].includes(entry.coverage) || entry.reason.trim().length > 0, 'invalid_coverage', 'Coverage reason is required');
    for (const claim of entry.claims) {
      requireCondition(claim.end > claim.start && job.snapshot.body.slice(claim.start, claim.end) === claim.quote, 'invalid_claim', 'Claim location does not match snapshot');
      requireCondition(!['confirmed','contradicted'].includes(claim.verdict) || claim.evidence.length > 0, 'invalid_evidence', 'Supported verdict requires evidence');
    }
    requireCondition(job.kind === 'review' || result.suggestions.length === 0, 'invalid_result', 'Quality suggestions belong to review');
    requireCondition(result.suggestions.every(s => s.record_id === job.target_id), 'invalid_result', 'Suggestion outside assignment');
    const blocked = ['skipped','blocked'].includes(entry.coverage);
    const state = blocked ? 'blocked' : 'complete';
    const readoutId = randomUUID();
    const report={assignment:id,snapshot:job.revision_id,coverage:entry.coverage,reason:entry.reason,
      claims:entry.claims.map(claim=>({start:claim.start,end:claim.end,verdict:claim.verdict,quote:claim.quote.slice(0,200),reasoning:claim.reasoning.slice(0,200),evidence_count:claim.evidence.length})),
      suggestion_count:result.suggestions.length};
    const document: Document = {
      title: `${job.kind} evidence for ${job.snapshot.title}`.slice(0,300), slug: `${job.kind}-${id}`,
      body: `# ${job.kind} result\n\nFull evidence: wiki_assignment_result with job_id ${id}. Quotes and reasoning below are bounded previews.\n\n${JSON.stringify(report, null, 2)}\n`,
      metadata: { summary: `Coverage: ${entry.coverage}` }, tags: ['readout','research','factcheck'],
      relations: [{ target: job.target_id, kind: 'related' }], sources: job.snapshot.sources, attachments: [],
    };
    await tx`INSERT INTO records(id,type) VALUES(${readoutId},'readout')`;
    if(isNativeSnapshot(job.snapshot))await writeCoreRevision(tx,identity,readoutId,'record',coreDocumentSchema.parse({
      title:document.title,slug:document.slug,body:document.body,check_policy:'manual',maturity:null,
      relations:document.relations,sources:document.sources,derivations:[{revision:job.revision_id,kind:'derived_from'}],
    }),{generated:true});
    else {
      for(const tag of document.tags)await tx`INSERT INTO taxonomy VALUES(${tag},${'Legacy generated evidence'}) ON CONFLICT DO NOTHING`;
      await writeRevision(tx, identity, readoutId, 'readout', document, null, true);
    }
    await tx`UPDATE jobs SET state=${state},result=${result}::jsonb,result_hash=${resultHash},updated_at=now() WHERE id=${id}`;
    if (!blocked && job.kind === 'factcheck') await tx`INSERT INTO checkpoints VALUES(${job.target_id},${job.fingerprint},${id}) ON CONFLICT DO NOTHING`;
    if (blocked) await emitEvent(tx, id, 'clarification', { reason: entry.reason });
    if (entry.claims.some(c => c.verdict === 'contradicted' || c.verdict === 'unverified')) await emitEvent(tx, id, 'discrepancy', { readout_id: readoutId });
    if (result.suggestions.length) await emitEvent(tx, id, 'review_suggestions', { readout_id: readoutId });
    await tx`INSERT INTO audit(actor,action,detail) VALUES(${identity.actor},'complete_assignment',${{ id, state, readoutId }}::jsonb)`;
    return { job_id: id, state };
  });
}

export async function assignmentResult(db:SQL,identity:Identity,id:string) {
  requireRole(identity,'personal','factchecker');
  const rows=await db`SELECT result FROM jobs WHERE id=${id}`;
  requireCondition(rows.length,'not_found','Assignment unavailable',404);
  return {job_id:id,result:rows[0].result===null?null:resultSchema.parse(rows[0].result)};
}

export async function fail(db: SQL, identity: Identity, id: string, token: string, reason: string, maxAttempts: number) {
  requireRole(identity, 'personal', 'factchecker');
  return db.begin(async tx => {
    const rows = await tx<Job[]>`SELECT * FROM jobs WHERE id=${id} AND executor=${identity.actor} AND claim_token=${token}
      AND state='running' AND lease_until>now() FOR UPDATE`;
    requireCondition(rows.length, 'stale_claim', 'Assignment lease is no longer owned', 409);
    const state = rows[0]!.attempts >= maxAttempts ? 'failed' : 'pending';
    await tx`UPDATE jobs SET state=${state},executor=NULL,claim_token=NULL,available_at=now()+interval '1 minute',updated_at=now() WHERE id=${id}`;
    await emitEvent(tx, id, 'execution_failure', { reason });
    if (state === 'pending') await dispatch(tx,id,rows[0]!.kind,rows[0]!.snapshot);
    return { job_id: id, state };
  });
}

export async function listEvents(db: SQL, identity: Identity, offset: number) {
  requireRole(identity, 'personal');
  return db`SELECT * FROM events ORDER BY created_at,id LIMIT 100 OFFSET ${offset}`;
}
export async function markEvent(db: SQL, identity: Identity, id: string, action: 'acknowledge' | 'resolve', resolution?: string) {
  requireRole(identity, 'personal');
  return db.begin(async tx => {
    const rows = action === 'acknowledge'
      ? await tx`UPDATE events SET acknowledged_at=COALESCE(acknowledged_at,now()),acknowledged_by=COALESCE(acknowledged_by,${identity.actor}) WHERE id=${id} RETURNING id`
      : await tx`UPDATE events SET resolved_at=COALESCE(resolved_at,now()),resolved_by=COALESCE(resolved_by,${identity.actor}),resolution=COALESCE(resolution,${resolution ?? ''}) WHERE id=${id} RETURNING id`;
    requireCondition(rows.length, 'not_found', 'Event unavailable', 404);
    await tx`INSERT INTO audit(actor,action,detail) VALUES(${identity.actor},${action},${{ id }}::jsonb)`;
    return { saved: true };
  });
}
