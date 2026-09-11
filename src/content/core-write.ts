import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { requireRole,type Identity } from '../auth/identity.ts';
import { sha256,type Transaction } from '../storage/database.ts';
import { requireCondition } from '../runtime/errors.ts';
import { canonical } from './schema.ts';
import { coreChangeSchema,coreDocumentSchema,type CoreDocument,type Kind,type Skill } from './core-schema.ts';
import { CoreReader } from './core-reads.ts';

function fingerprintFor(doc:CoreDocument,original:Uint8Array|null,skill:Skill|null) {
  return sha256(canonical({version:3,title:doc.title,body:doc.body,
    sources:[...new Set(doc.sources.map(canonical))].sort(),derivations:[...new Set(doc.derivations.map(canonical))].sort(),
    attachments:[...new Set(doc.attachments)].sort(),original:original?sha256(original):null,skill}));
}

export async function writeCoreRevision(tx:Transaction,identity:Identity,id:string,kind:Kind,document:CoreDocument,
  options:{original?:Uint8Array;origin?:unknown;skill?:Skill;generated?:boolean;revision?:string}={}) {
  const revision=options.revision??randomUUID(),doc=coreDocumentSchema.parse(document);
  if(kind!=='record') {doc.maturity=null;doc.check_policy='manual';}
  const original=options.original??null;
  let fingerprint=fingerprintFor(doc,original,options.skill??null),legacyRevision:string|null=null;
  const [current]=await tx`SELECT current_revision FROM records WHERE id=${id}`;
  if(current?.current_revision) {
    const old=await new CoreReader(tx,identity,{publicEnabled:false}).record(id,current.current_revision);
    legacyRevision=old.legacy_revision;
    // Preserve checkpoints across format-only migration and subsequent non-evidence edits.
    if(fingerprint===fingerprintFor(old.document,old.original_base64===null?null:Buffer.from(old.original_base64,'base64'),old.skill))fingerprint=old.content_hash;
  }
  await tx`INSERT INTO revisions(id,record_id,title,slug,body,metadata,original,original_hash,content_hash,generated,actor)
    VALUES(${revision},${id},${doc.title},${doc.slug??id},${doc.body},${options.origin??{}}::jsonb,
      ${original},${original?sha256(original):null},${fingerprint},${options.generated??false},${identity.actor})`;
  await tx`UPDATE revision_details SET native=true,legacy_revision=${legacyRevision},maturity=${doc.maturity},check_policy=${doc.check_policy} WHERE revision_id=${revision}`;
  for(const term of [...new Set(doc.topics),...(doc.format?[doc.format]:[])]) {
    const rows=await tx<{id:string;vocabulary:string;name:string;aliases:string[]}[]>`SELECT * FROM terms WHERE id=${term} AND NOT archived`;
    const value=rows[0];
    requireCondition(value&&value.vocabulary===(term===doc.format?'format':'topic'),'invalid_term','Term is unavailable or belongs to another vocabulary');
    requireCondition(!(term===doc.format&&doc.topics.includes(term)),'invalid_term','A format is not a topic');
    await tx`INSERT INTO revision_terms VALUES(${revision},${term},${value.vocabulary},${value.name},${tx.array(value.aliases,'TEXT')})`;
  }
  for(const edge of doc.relations) {
    const target=await tx`SELECT id FROM records WHERE id=${edge.target} AND (${options.generated??false} OR NOT archived)`;
    requireCondition(target.length&&edge.target!==id,'invalid_relation','Target unavailable or self-referential');
    await tx`INSERT INTO relations VALUES(${revision},${edge.target},${edge.kind}) ON CONFLICT DO NOTHING`;
  }
  for(const source of doc.sources) {
    if('revision' in source) {
      const target=await tx`SELECT v.id FROM revisions v JOIN sources s ON s.record_id=v.record_id WHERE v.id=${source.revision}`;
      requireCondition(target.length,'invalid_provenance','Evidence requires a preserved source revision; use derivations for records');
    }
    await tx`INSERT INTO provenance VALUES(${randomUUID()},${revision},${'revision' in source?source.revision:null},${'url' in source?source.url:null})`;
  }
  for(const edge of doc.derivations) {
    const target=await tx`SELECT r.id,r.kind FROM revisions v JOIN records r ON r.id=v.record_id WHERE v.id=${edge.revision}`;
    requireCondition(target.length&&target[0].id!==id&&(edge.kind!=='used_skill'||target[0].kind==='skill'),'invalid_derivation','Invalid historical dependency');
    await tx`INSERT INTO derivations VALUES(${revision},${edge.revision},${edge.kind}) ON CONFLICT DO NOTHING`;
  }
  for(const skill of new Set(doc.skills)) {
    const target=await tx`SELECT id FROM records WHERE id=${skill} AND kind='skill' AND NOT archived`;
    requireCondition(target.length&&skill!==id,'invalid_skill','Skill unavailable');
    await tx`INSERT INTO revision_skill_links VALUES(${revision},${skill})`;
  }
  for(const hash of new Set(doc.attachments)) {
    const target=await tx`SELECT hash FROM blobs WHERE hash=${hash}`;
    requireCondition(target.length,'invalid_attachment','Finalize original attachment first');
    await tx`INSERT INTO revision_blobs VALUES(${revision},${hash})`;
  }
  if(kind==='skill') {
    const skill=options.skill;requireCondition(skill,'invalid_skill','Skill instructions and application context required');
    requireCondition(doc.body.trim().length,'invalid_skill','Skill instructions must not be empty');
    await tx`INSERT INTO skill_revisions VALUES(${revision},${skill.description},${skill.use_when},${skill.avoid_when},${tx.array(skill.requirements,'TEXT')})`;
    for(const dependency of skill.dependencies) {
      const target=await tx`SELECT record_id FROM revisions WHERE id=${dependency.revision}`;
      requireCondition(target.length&&target[0].record_id!==id,'invalid_dependency','Dependency unavailable or self-referential');
      await tx`INSERT INTO skill_dependencies VALUES(${revision},${dependency.revision},${dependency.required}) ON CONFLICT DO NOTHING`;
    }
  }
  await tx`INSERT INTO revision_seals VALUES(${revision})`;
  await tx`UPDATE records SET current_revision=${revision} WHERE id=${id}`;
  await tx`UPDATE publication_requests SET state='stale' WHERE record_id=${id} AND state='pending'`;
  return revision;
}

export async function applyCoreChange(db:SQL,identity:Identity,input:unknown) {
  requireRole(identity,'personal');
  const parsed=coreChangeSchema.safeParse(input);requireCondition(parsed.success,'invalid_input','Invalid v3 change');
  const change=parsed.data,hash=sha256(canonical(change));
  return db.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(71822002)`;
    const previous=await tx`SELECT request_hash,response FROM idempotency WHERE actor=${identity.actor} AND key=${change.idempotency_key}`;
    if(previous.length) {requireCondition(previous[0].request_hash===hash,'idempotency_conflict','Key used for another change',409);return previous[0].response;}
    const seen=new Set<string>(),kinds=new Map<string,Kind>();
    for(const op of change.operations) {
      requireCondition(!seen.has(op.id),'duplicate_target','One operation per object');seen.add(op.id);
      const rows=await tx<{kind:Kind;current_revision:string;edit_locked:boolean;archived:boolean}[]>`SELECT * FROM records WHERE id=${op.id} FOR UPDATE`;
      const fresh=op.op==='create'||((op.op==='source'||op.op==='skill')&&op.expected_revision===null);
      if(fresh) {
        requireCondition(!rows.length,'revision_conflict','Object already exists',409);
        const kind=op.op==='source'?'source':op.op==='skill'?'skill':'record';kinds.set(op.id,kind);
        await tx`INSERT INTO records(id,type,kind) VALUES(${op.id},${kind==='source'?'raw-source':kind==='skill'?'meta':'note'},${kind})`;
      } else {
        const row=rows[0];
        requireCondition(row&&!row.archived&&'expected_revision' in op&&row.current_revision===op.expected_revision,'revision_conflict','Expected revision is not current',409);
        requireCondition(!row.edit_locked,'edit_locked','Object is locked',409);
        requireCondition(op.op==='archive'||(row.kind==='record'&&op.op==='edit')||(row.kind==='source'&&op.op==='source')||(row.kind==='skill'&&op.op==='skill'),
          'invalid_operation','Use the specialized source or skill operation');kinds.set(op.id,row.kind);
      }
    }
    const reader=new CoreReader(tx,identity,{publicEnabled:false});
    const changed:{id:string;revision:string|null}[]=[];
    // Source intake first permits creating a record and its exact evidence atomically.
    const operations=[...change.operations].sort((a,b)=>Number(b.op==='source')-Number(a.op==='source'));
    for(const op of operations) {
      if(op.op==='archive') {
        await tx`UPDATE records SET archived=true,published_revision=NULL WHERE id=${op.id}`;
        await tx`DELETE FROM published_blobs WHERE record_id=${op.id}`;
        await tx`UPDATE publication_requests SET state='withdrawn' WHERE record_id=${op.id} AND state='pending'`;
        changed.push({id:op.id,revision:null});continue;
      }
      const doc=op.op==='edit'?coreDocumentSchema.parse({...((await reader.record(op.id)).document),...op.patch}):op.document;
      let original:Uint8Array|undefined;
      if(op.op==='source') {
        const bytes=Buffer.from(op.original_base64,'base64');
        requireCondition(bytes.toString('base64')===op.original_base64&&bytes.length<=1_000_000&&sha256(bytes)===op.checksum,'invalid_source','Invalid original encoding, size or checksum');original=bytes;
      }
      const kind=kinds.get(op.id);requireCondition(kind,'invalid_operation','Missing object kind');
      const revision=await writeCoreRevision(tx,identity,op.id,kind,doc,{original,origin:op.op==='source'?op.origin:undefined,skill:op.op==='skill'?op.skill:undefined,revision:op.op==='source'?op.new_revision:undefined});
      changed.push({id:op.id,revision});
    }
    const response={version:3,changed};
    await tx`INSERT INTO audit(actor,action,detail) VALUES(${identity.actor},'apply_change_v3',${response}::jsonb)`;
    await tx`INSERT INTO idempotency VALUES(${identity.actor},${change.idempotency_key},${hash},${response}::jsonb)`;
    return response;
  });
}
