import { Reader } from './reads.ts';
import { sha256 } from '../storage/database.ts';

export async function health(reader:Reader) {
  reader.ensureAccess();
  const rows=await reader.db<{ id:string; original:Uint8Array|null; original_hash:string|null; tags:number; relations:number; provenance:number;native:boolean }[]>`
    SELECT v.id,v.original,v.original_hash,d.native,
      (SELECT count(*)::int FROM revision_tags t WHERE t.revision_id=v.id) AS tags,
      (SELECT count(*)::int FROM relations e LEFT JOIN records target ON target.id=e.target_id WHERE e.revision_id=v.id AND target.id IS NULL) AS relations,
      (SELECT count(*)::int FROM provenance p JOIN revisions source ON source.id=p.source_revision JOIN records raw ON raw.id=source.record_id
        WHERE p.revision_id=v.id AND raw.type<>'raw-source') AS provenance
    FROM records r JOIN revisions v ON v.id=CASE WHEN ${reader.privateAccess} THEN r.current_revision ELSE r.published_revision END
    JOIN revision_details d ON d.revision_id=v.id WHERE NOT r.archived`;
  return { visible_records:rows.length, untagged:rows.filter(r=>!r.native&&r.tags===0).length,
    source_integrity_errors:rows.filter(r=>r.original && sha256(r.original)!==r.original_hash).length,
    invalid_relations:rows.reduce((n,r)=>n+r.relations,0), invalid_provenance:rows.reduce((n,r)=>n+r.provenance,0) };
}
export async function lint(reader:Reader) {
  reader.ensureAccess();
  const [counts]=await reader.db<{ visible_records:number; empty_body:number; missing_provenance:number; drafts_without_original:number }[]>`
    SELECT count(*)::int AS visible_records,
      count(*) FILTER(WHERE NOT d.native AND length(trim(v.body))=0)::int AS empty_body,
      count(*) FILTER(WHERE NOT d.native AND r.type IN ('concept','comparison','query') AND NOT EXISTS(SELECT 1 FROM provenance p WHERE p.revision_id=v.id))::int AS missing_provenance,
      count(*) FILTER(WHERE NOT d.native AND r.type IN ('article-draft','post-draft') AND NOT EXISTS(SELECT 1 FROM provenance p WHERE p.revision_id=v.id)
        AND v.body !~* '## (original draft|исходный набросок)')::int AS drafts_without_original
    FROM records r JOIN revisions v ON v.id=CASE WHEN ${reader.privateAccess} THEN r.current_revision ELSE r.published_revision END
    JOIN revision_details d ON d.revision_id=v.id WHERE NOT r.archived`;
  return counts!;
}
export async function visibility(reader:Reader) {
  reader.ensureAccess();
  const [counts]=await reader.db<{ public_records:number; public_attachments:number }[]>`
    SELECT count(*)::int AS public_records,
      COALESCE(sum((SELECT count(*) FROM published_blobs b WHERE b.record_id=r.id)),0)::int AS public_attachments
    FROM records r WHERE NOT archived AND published_revision IS NOT NULL`;
  return { ...counts!, publication_enabled:reader.policy.publicEnabled, policy:'owner-approved-revision' as const };
}
