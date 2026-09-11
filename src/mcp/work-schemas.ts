import {idSchema,hashSchema,documentSchema} from '../content/schema.ts';
import {snapshotSchema} from './schemas.ts';
import {coreSnapshotSchema} from './core-tools.ts';
import {workflow} from '../factcheck/protocol.ts';
const {z}=await import('zod');
const nativeSnapshot=z.object({contract_version:z.literal(3),id:idSchema,revision:idSchema,title:z.string(),body:z.string(),
  content_hash:hashSchema,sources:documentSchema.shape.sources,record:coreSnapshotSchema}).strict();
export const workTaskSchema=z.object({version:z.union([z.literal(1),z.literal(2)]),job_id:idSchema,kind:z.enum(['factcheck','review']),state:z.string(),
  workflow:z.object({version:z.literal(workflow.version),instructions:z.array(z.string())}).strict(),
  snapshots:z.array(z.union([snapshotSchema,nativeSnapshot])),progress:z.unknown().nullable(),result_schema:z.record(z.unknown())}).strict();
