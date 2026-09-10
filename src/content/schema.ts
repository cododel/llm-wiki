import type { z as Zod } from 'zod';
const { z } = await import('zod');
export const idSchema = z.string().uuid();
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const typeSchema = z.enum(['raw-source','readout','entity','concept','comparison','query','idea','note','article-draft','post-draft','meta','adr']);
export const tagSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const urlSchema = z.string().url().max(2048).refine(value => ['http:', 'https:'].includes(new URL(value).protocol));
export const sourceSchema = z.union([
  z.object({ revision: idSchema }).strict(),
  z.object({ url: urlSchema }).strict(),
]);
export const documentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
  body: z.string().max(1_000_000).refine(value => !value.includes('\0')),
  metadata: z.object({
    summary: z.string().max(5000).optional(),
    status: z.enum(['inbox','draft','active','researching','incubating','ready','published','archived','observed','analyzed','acted-on','proposed','accepted','deprecated','superseded']).optional(),
    confidence: z.enum(['high','medium','low']).optional(),
    contested: z.boolean().optional(),
    source_kind: z.enum(['user-note','chat','transcript','doc','article','asset-note','log']).optional(),
    source_channel: z.enum(['telegram','web','file','manual','import']).optional(),
    source_filename: z.string().max(300).optional(),
    source_note: z.string().max(5000).optional(),
    import_batch: z.string().max(200).optional(),
    source_url: urlSchema.optional(),
    capture_boundary: z.enum(['complete','excerpt','attachment']).optional(),
  }).strict(),
  tags: z.array(tagSchema).min(1).max(30),
  relations: z.array(z.object({ target: idSchema, kind: z.enum(['related','supports','contradicts','supersedes']) }).strict()).max(200),
  sources: z.array(sourceSchema).max(200),
  attachments: z.array(hashSchema).max(30),
}).strict();
const createSchema = z.object({ op: z.literal('create'), id: idSchema, type: typeSchema, document: documentSchema }).strict();
const editSchema = z.object({ op: z.literal('edit'), id: idSchema, expected_revision: idSchema, document: documentSchema }).strict();
const rawSchema = z.object({ op: z.literal('source'), id: idSchema, expected_revision: idSchema.nullable(), document: documentSchema,
  original_base64: z.string().max(1_400_000), checksum: hashSchema,
}).strict();
const archiveSchema = z.object({ op: z.literal('archive'), id: idSchema, expected_revision: idSchema }).strict();
const taxonomySchema = z.object({ op: z.literal('tag'), tag: tagSchema, description: z.string().min(1).max(1000) }).strict();
export const changeSchema = z.object({
  idempotency_key: z.string().min(1).max(128),
  operations: z.array(z.discriminatedUnion('op', [createSchema, editSchema, rawSchema, archiveSchema, taxonomySchema])).min(1).max(50),
}).strict();
export type Document = Zod.infer<typeof documentSchema>;
export type Change = Zod.infer<typeof changeSchema>;
export type RecordType = Zod.infer<typeof typeSchema>;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
