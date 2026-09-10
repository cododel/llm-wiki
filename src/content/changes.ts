import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { requireRole, type Identity } from '../auth/identity.ts';
import { requireCondition, ServiceError } from '../runtime/errors.ts';
import { sha256, type Transaction } from '../storage/database.ts';
import { canonical, changeSchema, documentSchema, type Document, type RecordType } from './schema.ts';
import { discoveryTags } from './taxonomy.ts';

export async function writeRevision(tx: Transaction, identity: Identity, id: string, type: RecordType, doc: Document,
  original: Uint8Array | null = null, generated = false): Promise<string> {
  doc=documentSchema.parse(doc);
  const revision = randomUUID();
  const requiredTags=discoveryTags[type];
  requireCondition(!requiredTags || requiredTags.some(tag=>doc.tags.includes(tag)),'missing_discovery_tag','Record type requires its discovery tag');
  const sources=[...new Set(doc.sources.map(source=>canonical(source)))].sort();
  const fingerprint = sha256(canonical({ type, title: doc.title, body: doc.body, sources, attachments: [...new Set(doc.attachments)].sort(), original: original ? sha256(original) : null }));
  if (type === 'raw-source') {
    requireCondition(original && doc.metadata.source_kind && doc.metadata.source_channel && doc.metadata.capture_boundary && doc.tags.includes('source'),
      'invalid_source', 'Source requires original bytes and provenance metadata');
    requireCondition(doc.metadata.source_channel !== 'web' || doc.metadata.source_url, 'invalid_source', 'Web source requires source_url');
  }
  await tx`INSERT INTO revisions(id,record_id,title,slug,body,metadata,original,original_hash,content_hash,generated,actor)
    VALUES (${revision},${id},${doc.title},${doc.slug},${doc.body},${doc.metadata}::jsonb,
    ${original},${original ? sha256(original) : null},${fingerprint},${generated},${identity.actor})`;
  for (const tag of new Set(doc.tags)) {
    const exists = await tx`SELECT tag FROM taxonomy WHERE tag=${tag}`;
    requireCondition(exists.length, 'unknown_tag', 'Use an existing taxonomy tag or add it explicitly');
    await tx`INSERT INTO revision_tags VALUES (${revision},${tag})`;
  }
  for (const relation of doc.relations) {
    const target = await tx`SELECT id FROM records WHERE id=${relation.target} AND (${generated} OR NOT archived)`;
    requireCondition(target.length && relation.target !== id, 'invalid_relation', 'Relation target is unavailable or self-referential');
    await tx`INSERT INTO relations VALUES (${revision},${relation.target},${relation.kind}) ON CONFLICT DO NOTHING`;
  }
  for (const source of doc.sources) {
    if ('revision' in source) {
      const raw = await tx`SELECT r.id FROM revisions v JOIN records r ON r.id=v.record_id WHERE v.id=${source.revision} AND r.type='raw-source'`;
      requireCondition(raw.length, 'invalid_provenance', 'Provenance must reference a preserved source revision');
    }
    await tx`INSERT INTO provenance VALUES (${randomUUID()},${revision},${'revision' in source ? source.revision : null},${'url' in source ? source.url : null})`;
  }
  for (const hash of new Set(doc.attachments)) {
    const blob = await tx`SELECT hash FROM blobs WHERE hash=${hash}`;
    requireCondition(blob.length, 'invalid_attachment', 'Attachment must be finalized before use');
    await tx`INSERT INTO revision_blobs VALUES (${revision},${hash})`;
  }
  await tx`INSERT INTO revision_seals VALUES(${revision})`;
  await tx`UPDATE records SET current_revision=${revision} WHERE id=${id}`;
  await tx`UPDATE publication_requests SET state='stale' WHERE record_id=${id} AND state='pending'`;
  return revision;
}

export async function applyChange(db: SQL, identity: Identity, input: unknown) {
  requireRole(identity, 'personal');
  const parsed = changeSchema.safeParse(input);
  requireCondition(parsed.success, 'invalid_input', 'Invalid change schema');
  const change = parsed.data;
  const requestHash = sha256(canonical(change));
  return db.begin(async tx => {
    // Serialize accepted change groups, including creation and taxonomy additions.
    await tx`SELECT pg_advisory_xact_lock(71822002)`;
    const previous = await tx`SELECT request_hash,response FROM idempotency WHERE actor=${identity.actor} AND key=${change.idempotency_key}`;
    if (previous.length) {
      requireCondition(previous[0].request_hash === requestHash, 'idempotency_conflict', 'Key was used for another request', 409);
      return previous[0].response;
    }
    const targets = new Set<string>();
    for (const op of change.operations) {
      if (op.op === 'tag') {
        await tx`INSERT INTO taxonomy(tag,description) VALUES(${op.tag},${op.description}) ON CONFLICT(tag) DO UPDATE SET description=excluded.description`;
        continue;
      }
      requireCondition(!targets.has(op.id), 'duplicate_target', 'One operation per record per change group');
      targets.add(op.id);
      const existing = await tx`SELECT current_revision,type,archived FROM records WHERE id=${op.id} FOR UPDATE`;
      const isNew = op.op === 'create' || (op.op === 'source' && op.expected_revision === null);
      if (isNew) {
        requireCondition(!existing.length, 'revision_conflict', 'Record already exists', 409);
        const type = op.op === 'source' ? 'raw-source' : op.type;
        requireCondition(type !== 'raw-source' || op.op === 'source', 'invalid_source', 'Use source intake for raw originals');
        await tx`INSERT INTO records(id,type) VALUES (${op.id},${type})`;
      } else {
        requireCondition(existing.length && !existing[0].archived && existing[0].current_revision === op.expected_revision,
          'revision_conflict', 'Expected revision is not current', 409);
        requireCondition((existing[0].type === 'raw-source') === (op.op === 'source') || op.op === 'archive', 'invalid_source', 'Source corrections require source intake');
      }
    }
    const changed: { id: string; revision: string | null }[] = [];
    for (const op of change.operations) {
      if (op.op === 'tag') continue;
      if (op.op === 'archive') {
        await tx`UPDATE records SET archived=true,published_revision=NULL WHERE id=${op.id}`;
        await tx`DELETE FROM published_blobs WHERE record_id=${op.id}`;
        await tx`UPDATE publication_requests SET state='withdrawn' WHERE record_id=${op.id} AND state='pending'`;
        changed.push({ id: op.id, revision: null });
        continue;
      }
      let original: Uint8Array | null = null;
      if (op.op === 'source') {
        const bytes = Buffer.from(op.original_base64, 'base64');
        requireCondition(bytes.toString('base64') === op.original_base64 && bytes.length <= 1_000_000 && sha256(bytes) === op.checksum,
          'invalid_source', 'Original encoding, size or checksum is invalid');
        original = bytes;
      }
      const [record] = await tx`SELECT type FROM records WHERE id=${op.id}`;
      if (!record) throw new ServiceError('internal_error', 'Missing change target', 500);
      const revision = await writeRevision(tx, identity, op.id, record.type, op.document, original);
      changed.push({ id: op.id, revision });
    }
    const response = { version: 2, changed };
    await tx`INSERT INTO audit(actor,action,detail) VALUES(${identity.actor},'apply_change',${response}::jsonb)`;
    await tx`INSERT INTO idempotency VALUES(${identity.actor},${change.idempotency_key},${requestHash},${response}::jsonb)`;
    return response;
  });
}
