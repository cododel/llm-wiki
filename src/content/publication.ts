import type { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { requireRole, type Identity } from '../auth/identity.ts';
import { requireCondition } from '../runtime/errors.ts';

export async function requestPublication(db: SQL, identity: Identity, enabled: boolean, id: string, revision: string, attachments: string[]) {
  requireRole(identity, 'personal');
  requireCondition(enabled, 'disabled', 'Publication is disabled');
  return db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(71822002)`;
    const row = await tx`SELECT id FROM records WHERE id=${id} AND current_revision=${revision} AND NOT archived FOR UPDATE`;
    requireCondition(row.length, 'revision_conflict', 'Requested revision is not current', 409);
    for (const hash of attachments) {
      const found = await tx`SELECT hash FROM revision_blobs WHERE revision_id=${revision} AND hash=${hash}`;
      requireCondition(found.length, 'invalid_attachment', 'Requested attachment is not part of this revision');
    }
    const existing = await tx`SELECT id FROM publication_requests WHERE record_id=${id} AND revision_id=${revision}
      AND attachments=${[...new Set(attachments)].sort()}::jsonb AND state='pending' AND expires_at>now()`;
    if (existing.length) return { request_id: existing[0].id };
    const requestId = randomUUID();
    await tx`INSERT INTO publication_requests(id,record_id,revision_id,attachments,requested_by)
      VALUES(${requestId},${id},${revision},${[...new Set(attachments)].sort()}::jsonb,${identity.actor})`;
    await tx`INSERT INTO audit(actor,action,detail) VALUES(${identity.actor},'request_publication',${{ requestId, id, revision }}::jsonb)`;
    return { request_id: requestId };
  });
}

// Only the browser route calls this after session, origin and CSRF validation.
export async function approvePublication(db: SQL, owner: Identity, enabled: boolean, requestId: string) {
  requireRole(owner, 'owner');
  requireCondition(enabled, 'disabled', 'Publication is disabled');
  return db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(71822002)`;
    const rows = await tx<{ record_id: string; revision_id: string; attachments: string[] }[]>`
      SELECT p.record_id,p.revision_id,p.attachments FROM publication_requests p JOIN records r ON r.id=p.record_id
      WHERE p.id=${requestId} AND p.state='pending' AND p.expires_at>now() AND p.revision_id=r.current_revision AND NOT r.archived FOR UPDATE`;
    requireCondition(rows.length, 'stale_approval', 'Publication request is stale or unavailable', 409);
    const row = rows[0]!;
    await tx`UPDATE records SET published_revision=${row.revision_id} WHERE id=${row.record_id}`;
    await tx`DELETE FROM published_blobs WHERE record_id=${row.record_id}`;
    for (const hash of row.attachments) await tx`INSERT INTO published_blobs VALUES(${row.record_id},${hash})`;
    await tx`UPDATE publication_requests SET state='approved',approved_by=${owner.actor} WHERE id=${requestId}`;
    await tx`INSERT INTO audit(actor,action,detail) VALUES(${owner.actor},'approve_publication',${{ requestId, revision: row.revision_id }}::jsonb)`;
    return { published_revision: row.revision_id };
  });
}

export async function unpublish(db: SQL, identity: Identity, id: string) {
  requireRole(identity, 'personal');
  return db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(71822002)`;
    await tx`UPDATE records SET published_revision=NULL WHERE id=${id}`;
    await tx`DELETE FROM published_blobs WHERE record_id=${id}`;
    await tx`UPDATE publication_requests SET state='withdrawn' WHERE record_id=${id} AND state='pending'`;
    await tx`INSERT INTO audit(actor,action,detail) VALUES(${identity.actor},'unpublish',${{ id }}::jsonb)`;
    return { unpublished: true };
  });
}
