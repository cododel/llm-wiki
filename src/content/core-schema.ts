import type { z as Zod } from 'zod';
import { idSchema, hashSchema } from './schema.ts';
const { z } = await import('zod');

export const kindSchema = z.enum(['record','source','skill']);
export const maturitySchema = z.enum(['seed','growing','evergreen']);
export const relationSchema = z.object({ target:idSchema,kind:z.enum(['related','supports','contradicts','supersedes','about','part_of']) }).strict();
export const derivationSchema = z.object({ revision:idSchema,kind:z.enum(['derived_from','used_skill']) }).strict();
const url = z.string().url().max(2048).refine(value=>['http:','https:'].includes(new URL(value).protocol));
export const evidenceSchema = z.union([z.object({revision:idSchema}).strict(),z.object({url}).strict()]);
export const skillSchema = z.object({
  description:z.string().trim().min(1).max(1024),use_when:z.string().trim().min(1).max(5000),
  avoid_when:z.string().max(5000).default(''),requirements:z.array(z.string().min(1).max(300)).max(30).default([]),
  dependencies:z.array(z.object({revision:idSchema,required:z.boolean().default(true)}).strict()).max(100).default([]),
}).strict();
export const originSchema = z.object({
  source_kind:z.enum(['user-note','chat','transcript','doc','article','asset-note','log']),
  source_channel:z.enum(['telegram','web','file','manual','import']),
  capture_boundary:z.enum(['complete','excerpt','attachment']),source_url:url.optional(),
  source_filename:z.string().max(300).optional(),source_note:z.string().max(5000).optional(),
}).strict().refine(value=>value.source_channel!=='web'||!!value.source_url,'Web source requires source_url');
export const coreDocumentSchema = z.object({
  title:z.string().trim().min(1).max(300),slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/).optional(),
  body:z.string().max(1_000_000).refine(value=>!value.includes('\0')).default(''),
  maturity:maturitySchema.nullable().default('seed'),check_policy:z.enum(['automatic','manual']).default('automatic'),
  topics:z.array(idSchema).max(30).default([]),format:idSchema.nullable().default(null),
  relations:z.array(relationSchema).max(200).default([]),sources:z.array(evidenceSchema).max(200).default([]),
  derivations:z.array(derivationSchema).max(200).default([]),skills:z.array(idSchema).max(50).default([]),
  attachments:z.array(hashSchema).max(30).default([]),
}).strict();
// Defaults belong to creation only: omitted patch fields preserve their stored values.
export const corePatchSchema=coreDocumentSchema.partial();
const create=z.object({op:z.literal('create'),id:idSchema,document:coreDocumentSchema}).strict();
const edit=z.object({op:z.literal('edit'),id:idSchema,expected_revision:idSchema,patch:corePatchSchema}).strict();
const source=z.object({op:z.literal('source'),id:idSchema,expected_revision:idSchema.nullable(),document:coreDocumentSchema,
  origin:originSchema,original_base64:z.string().max(1_400_000),checksum:hashSchema,new_revision:idSchema.optional()}).strict();
const skill=z.object({op:z.literal('skill'),id:idSchema,expected_revision:idSchema.nullable(),document:coreDocumentSchema,skill:skillSchema}).strict();
const archive=z.object({op:z.literal('archive'),id:idSchema,expected_revision:idSchema}).strict();
export const coreChangeSchema=z.object({contract_version:z.literal(3),idempotency_key:z.string().min(1).max(128),
  operations:z.array(z.discriminatedUnion('op',[create,edit,source,skill,archive])).min(1).max(50)}).strict();
export type CoreDocument=Zod.infer<typeof coreDocumentSchema>;
export type Skill=Zod.infer<typeof skillSchema>;
export type Kind=Zod.infer<typeof kindSchema>;
export type CoreChange=Zod.infer<typeof coreChangeSchema>;
