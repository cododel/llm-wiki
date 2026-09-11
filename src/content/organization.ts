import type { SQL } from 'bun';
import type { z as Zod } from 'zod';
import { requireRole,type Identity } from '../auth/identity.ts';
import { requireCondition } from '../runtime/errors.ts';
import { sha256,type Transaction } from '../storage/database.ts';
import { canonical,idSchema } from './schema.ts';
import { CoreReader } from './core-reads.ts';
const { z }=await import('zod');

const version=z.number().int().nonnegative();
const key=z.string().min(1).max(128);
export const termChangeSchema=z.object({id:idSchema,expected_version:version.nullable(),idempotency_key:key,
  vocabulary:z.enum(['topic','format']),name:z.string().trim().min(1).max(200),
  aliases:z.array(z.string().trim().min(1).max(200)).max(30).default([]),archived:z.boolean().default(false)}).strict();
export const collectionChangeSchema=z.object({id:idSchema,expected_version:version.nullable(),idempotency_key:key,
  title:z.string().trim().min(1).max(300),members:z.array(idSchema).max(1000),archived:z.boolean().default(false)}).strict();
export const lockChangeSchema=z.object({id:idSchema,expected_version:version,idempotency_key:key,locked:z.boolean()}).strict();

async function mutate(db:SQL,identity:Identity,key:string,input:unknown,action:string,run:(tx:Transaction)=>Promise<unknown>) {
  requireRole(identity,'personal');
  const hash=sha256(canonical({action,input}));
  return db.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(71822002)`;
    const [prior]=await tx`SELECT request_hash,response FROM idempotency WHERE actor=${identity.actor} AND key=${key}`;
    if(prior) {requireCondition(prior.request_hash===hash,'idempotency_conflict','Key used for another request',409);return prior.response;}
    const response=await run(tx);
    await tx`INSERT INTO audit(actor,action,detail) VALUES(${identity.actor},${action},${{input,response}}::jsonb)`;
    await tx`INSERT INTO idempotency VALUES(${identity.actor},${key},${hash},${response}::jsonb)`;
    return response;
  });
}
export async function changeTerm(db:SQL,identity:Identity,input:Zod.infer<typeof termChangeSchema>) {
  const a=termChangeSchema.parse(input);
  return mutate(db,identity,a.idempotency_key,a,'term_change',async tx=>{
    const [old]=await tx`SELECT * FROM terms WHERE id=${a.id} FOR UPDATE`;
    requireCondition(old?old.version===a.expected_version:a.expected_version===null,'version_conflict','Term version changed',409);
    requireCondition(!old||old.vocabulary===a.vocabulary,'invalid_term','Vocabulary is immutable');
    const next=(old?.version??0)+1,aliases=[...new Set(a.aliases)];
    await tx`INSERT INTO terms(id,vocabulary,name,aliases,version,archived) VALUES(${a.id},${a.vocabulary},${a.name},${tx.array(aliases,'TEXT')},${next},${a.archived})
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases=excluded.aliases,version=excluded.version,archived=excluded.archived`;
    return {id:a.id,version:next};
  });
}
export async function changeCollection(db:SQL,identity:Identity,input:Zod.infer<typeof collectionChangeSchema>) {
  const a=collectionChangeSchema.parse(input);
  return mutate(db,identity,a.idempotency_key,a,'collection_change',async tx=>{
    const [old]=await tx`SELECT version FROM collections WHERE id=${a.id} FOR UPDATE`;
    requireCondition(old?old.version===a.expected_version:a.expected_version===null,'version_conflict','Collection version changed',409);
    requireCondition(new Set(a.members).size===a.members.length,'invalid_members','Duplicate collection member');
    for(const id of a.members) {
      const rows=await tx`SELECT id FROM records WHERE id=${id} AND NOT archived`;
      requireCondition(rows.length,'invalid_members','Member unavailable');
    }
    const next=(old?.version??0)+1;
    await tx`INSERT INTO collections(id,version,title,archived) VALUES(${a.id},${next},${a.title},${a.archived})
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,title=excluded.title,archived=excluded.archived`;
    await tx`DELETE FROM collection_members WHERE collection_id=${a.id}`;
    for(const [position,id] of a.members.entries())await tx`INSERT INTO collection_members VALUES(${a.id},${id},${position})`;
    return {id:a.id,version:next};
  });
}
export async function changeLock(db:SQL,identity:Identity,input:Zod.infer<typeof lockChangeSchema>) {
  requireCondition(identity.capabilities?.includes('manage_locks'),'forbidden','Local manage_locks capability required',403);
  const a=lockChangeSchema.parse(input);
  return mutate(db,identity,a.idempotency_key,a,'lock_change',async tx=>{
    const rows=await tx`UPDATE records SET edit_locked=${a.locked},lock_version=lock_version+1
      WHERE id=${a.id} AND lock_version=${a.expected_version} RETURNING lock_version`;
    requireCondition(rows.length,'version_conflict','Object or lock version changed',409);
    return {id:a.id,version:rows[0].lock_version,locked:a.locked};
  });
}
export async function listTerms(reader:CoreReader,vocabulary:'topic'|'format',name?:string,offset=0) {
  reader.ensureAccess();
  type Term={id:string;name:string;aliases:string[];version:number|null};
  const page=(rows:Term[])=>({items:rows.slice(0,100),next_offset:rows.length>100?offset+100:null});
  if(reader.privateAccess)return page(await reader.db<Term[]>`
    SELECT id,name,aliases,version FROM terms WHERE vocabulary=${vocabulary} AND NOT archived
    AND (${name??null}::text IS NULL OR lower(name)=lower(${name??null}) OR EXISTS(SELECT 1 FROM unnest(aliases) a WHERE lower(a)=lower(${name??null})))
    ORDER BY id LIMIT 101 OFFSET ${offset}`);
  // Public names and aliases come only from owner-approved snapshots, never the mutable registry.
  return page(await reader.db<Term[]>`
    SELECT DISTINCT t.term_id AS id,t.name,t.aliases,NULL::int AS version FROM records r JOIN revision_terms t ON t.revision_id=r.published_revision
    WHERE NOT r.archived AND t.vocabulary=${vocabulary}
    AND (${name??null}::text IS NULL OR lower(t.name)=lower(${name??null}) OR EXISTS(SELECT 1 FROM unnest(t.aliases) a WHERE lower(a)=lower(${name??null})))
    ORDER BY id,name,aliases LIMIT 101 OFFSET ${offset}`);
}
export async function listCollections(reader:CoreReader,id?:string,offset=0) {
  requireRole(reader.identity,'personal','factchecker','owner');
  const items=await reader.db<{id:string;title:string;version:number}[]>`SELECT id,title,version FROM collections
    WHERE NOT archived AND (${id??null}::uuid IS NULL OR id=${id??null}) ORDER BY id LIMIT 101 OFFSET ${offset}`;
  const result=[];
  for(const item of items.slice(0,100)) {
    const members=id?await reader.db<{id:string;position:number}[]>`SELECT m.record_id AS id,m.position FROM collection_members m
      JOIN records r ON r.id=m.record_id WHERE m.collection_id=${item.id} AND NOT r.archived ORDER BY position`:[];
    result.push({...item,members,members_included:!!id});
  }
  return {items:result,next_offset:items.length>100?offset+100:null};
}
