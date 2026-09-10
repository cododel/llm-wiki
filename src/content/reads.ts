import type { Database } from '../storage/database.ts';
import type { Identity } from '../auth/identity.ts';
import { requireCondition } from '../runtime/errors.ts';
import type { Document, RecordType } from './schema.ts';

export interface Snapshot {
  id: string; revision: string; type: RecordType; title: string; slug: string; body: string;
  metadata: Document['metadata']; content_hash: string; created_at: Date;
  tags: string[]; relations: Document['relations']; sources: Document['sources']; attachments: string[];
  original_base64: string | null; original_hash: string | null;
}
export interface ReadPolicy { publicEnabled: boolean }
export class Reader {
  constructor(readonly db: Database, readonly identity: Identity, readonly policy: ReadPolicy) {}
  get privateAccess(): boolean { return this.identity.role !== 'public'; }
  ensureAccess(): void { requireCondition(this.privateAccess || this.policy.publicEnabled, 'not_found', 'Resource unavailable', 404); }

  async page(id: string, revision?: string): Promise<Snapshot> {
    this.ensureAccess();
    const rows = await this.db<{
      id: string; revision: string; type: RecordType; title: string; slug: string; body: string;
      metadata: Document['metadata']; content_hash: string; created_at: Date; original: Uint8Array | null; original_hash: string | null;
    }[]>`SELECT r.id,v.id AS revision,r.type,v.title,v.slug,v.body,v.metadata,v.content_hash,v.created_at,v.original,v.original_hash
      FROM records r JOIN revisions v ON v.record_id=r.id
      WHERE r.id=${id} AND (${this.privateAccess} OR NOT r.archived)
      AND v.id=COALESCE(${revision ?? null}::uuid,CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END)
      AND (${this.privateAccess} OR v.id=r.published_revision)`;
    requireCondition(rows.length, 'not_found', 'Resource unavailable', 404);
    const row = rows[0]!;
    const tags = await this.db<{ tag: string }[]>`SELECT tag FROM revision_tags WHERE revision_id=${row.revision} ORDER BY tag`;
    const relations = await this.db<Document['relations']>`SELECT e.target_id AS target,e.kind FROM relations e JOIN records r ON r.id=e.target_id
      WHERE e.revision_id=${row.revision} AND (${this.privateAccess} OR (NOT r.archived AND r.published_revision IS NOT NULL)) ORDER BY e.target_id,e.kind`;
    const sources = await this.db<{ source_revision: string | null; external_url: string | null }[]>`SELECT p.source_revision,p.external_url FROM provenance p
      LEFT JOIN revisions v ON v.id=p.source_revision LEFT JOIN records r ON r.id=v.record_id
      WHERE p.revision_id=${row.revision} AND (${this.privateAccess} OR p.external_url IS NOT NULL OR (NOT r.archived AND r.published_revision=p.source_revision)) ORDER BY p.id`;
    const attachments = await this.db<{ hash: string }[]>`SELECT b.hash FROM revision_blobs b WHERE b.revision_id=${row.revision}
      AND (${this.privateAccess} OR EXISTS(SELECT 1 FROM published_blobs p WHERE p.record_id=${id} AND p.hash=b.hash)) ORDER BY b.hash`;
    const { original, ...rest } = row;
    return { ...rest, original_base64: original ? Buffer.from(original).toString('base64') : null,
      tags: tags.map(t => t.tag), relations, sources: sources.map(p => p.source_revision ? { revision: p.source_revision } : { url: p.external_url! }),
      attachments: attachments.map(b => b.hash) };
  }

  async list(options: { limit: number; offset: number; type?: string; tag?: string }) {
    this.ensureAccess();
    return this.db<{ id: string; revision: string; type: RecordType; title: string; slug: string }[]>`
      SELECT r.id,v.id AS revision,r.type,v.title,v.slug FROM records r
      JOIN revisions v ON v.id=CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END
      WHERE NOT r.archived AND (${options.type ?? null}::text IS NULL OR r.type=${options.type ?? null})
      AND (${options.tag ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM revision_tags t WHERE t.revision_id=v.id AND t.tag=${options.tag ?? null}))
      ORDER BY r.id LIMIT ${options.limit} OFFSET ${options.offset}`;
  }

  async resolve(name: string) {
    this.ensureAccess();
    const candidates = await this.db<{ id: string; revision: string; title: string; slug: string }[]>`
      SELECT r.id,v.id AS revision,v.title,v.slug FROM records r
      JOIN revisions v ON v.id=CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END
      WHERE NOT r.archived AND (v.slug=${name} OR lower(v.title)=lower(${name}) OR r.id::text=${name}) ORDER BY r.id LIMIT 20`;
    return { status: candidates.length === 1 ? 'resolved' : candidates.length ? 'ambiguous' : 'not_found', candidates };
  }

  async related(id: string) {
    const page = await this.page(id);
    const incoming = await this.db<{ id: string; revision: string; kind: string }[]>`
      SELECT r.id,v.id AS revision,e.kind FROM records r
      JOIN revisions v ON v.id=CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END
      JOIN relations e ON e.revision_id=v.id
      WHERE e.target_id=${id} AND NOT r.archived ORDER BY r.id LIMIT 200`;
    return { outgoing: page.relations, incoming };
  }

  async sources(id: string) {
    const page = await this.page(id);
    const processedTo = await this.db<{ id: string; revision: string }[]>`
      SELECT r.id,v.id AS revision FROM records r
      JOIN revisions v ON v.id=CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END
      JOIN provenance p ON p.revision_id=v.id WHERE p.source_revision=${page.revision} AND NOT r.archived ORDER BY r.id LIMIT 200`;
    return { sources: page.sources, processed_to: processedTo, original_hash: page.original_hash };
  }
}
