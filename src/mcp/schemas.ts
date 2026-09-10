import { documentSchema, idSchema, typeSchema, hashSchema } from '../content/schema.ts';
const { z } = await import('zod');
export const snapshotSchema = documentSchema.extend({
  id: idSchema, revision: idSchema, type: typeSchema, content_hash: hashSchema,
  created_at: z.string().datetime(), original_base64: z.string().nullable(), original_hash: hashSchema.nullable(),
}).strict();
export const catalogItem = z.object({ id: idSchema, revision: idSchema, type: typeSchema, title: z.string(), slug: z.string() }).strict();
export const searchItem = z.object({ id: idSchema, revision: idSchema, title: z.string(), slug: z.string(), score: z.number(), excerpt: z.string() }).strict();
export const boundedList = z.object({ limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().nonnegative().max(100000).default(0), type: typeSchema.optional(), tag: z.string().max(64).optional() }).strict();
export const pageInput = z.object({ id: idSchema, revision: idSchema.optional(), heading:z.string().min(1).max(300).optional() }).strict();
export const jobInput = z.object({ job_id: idSchema }).strict();
export const claimInput = jobInput.extend({ claim_token: idSchema }).strict();
export const searchInput = z.object({ query: z.string().min(1).max(2000), mode: z.enum(['auto','strict','broad']).default('auto'), limit: z.number().int().min(1).max(100).default(10), type: typeSchema.optional(), tag: z.string().max(64).optional() }).strict();
