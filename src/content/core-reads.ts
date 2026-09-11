import type { Database } from '../storage/database.ts';
import type { Identity } from '../auth/identity.ts';
import { Reader, type ReadPolicy } from './reads.ts';
import { requireCondition } from '../runtime/errors.ts';
import { coreDocumentSchema, skillSchema, type Kind } from './core-schema.ts';

export interface CoreFilter { limit:number; offset:number; kind?:Kind; topic?:string; format?:string; collection?:string; maturity?:string; query?:string; mode?:'auto'|'strict'|'broad' }
export class CoreReader extends Reader {
  constructor(db:Database,identity:Identity,policy:ReadPolicy) { super(db,identity,policy); }
  async revision(revision:string) {
    this.ensureAccess();
    const [row]=await this.db<{id:string}[]>`SELECT r.id FROM revisions v JOIN records r ON r.id=v.record_id
      WHERE v.id=${revision} AND (${this.privateAccess} OR (NOT r.archived AND r.published_revision=v.id))`;
    requireCondition(row,'not_found','Resource unavailable',404);
    return this.record(row.id,revision);
  }
  async record(id:string,revision?:string) {
    const page=await super.page(id,revision);
    const [info]=await this.db<{kind:Kind;edit_locked:boolean;lock_version:number;maturity:'seed'|'growing'|'evergreen'|null;check_policy:'automatic'|'manual';native:boolean;legacy_revision:string|null}[]>`
      SELECT r.kind,r.edit_locked,r.lock_version,d.maturity,d.check_policy,d.native,d.legacy_revision
      FROM records r JOIN revision_details d ON d.revision_id=${page.revision} WHERE r.id=${id}`;
    requireCondition(info,'not_found','Resource unavailable',404);
    const terms=await this.db<{id:string;vocabulary:'topic'|'format';name:string;aliases:string[]}[]>`
      SELECT term_id AS id,vocabulary,name,aliases FROM revision_terms WHERE revision_id=${page.revision} ORDER BY vocabulary,term_id`;
    const derivations=await this.db<{revision:string;kind:'derived_from'|'used_skill'}[]>`
      SELECT e.target_revision AS revision,e.kind FROM derivations e JOIN revisions v ON v.id=e.target_revision JOIN records r ON r.id=v.record_id
      WHERE e.revision_id=${page.revision} AND (${this.privateAccess} OR (NOT r.archived AND r.published_revision=v.id)) ORDER BY e.target_revision,e.kind`;
    const skills=await this.db<{id:string}[]>`SELECT l.skill_id AS id FROM revision_skill_links l JOIN records r ON r.id=l.skill_id
      WHERE l.revision_id=${page.revision} AND (${this.privateAccess} OR (NOT r.archived AND r.published_revision IS NOT NULL)) ORDER BY l.skill_id`;
    const details=await this.db`SELECT description,use_when,avoid_when,requirements FROM skill_revisions WHERE revision_id=${page.revision}`;
    const dependencies=await this.db<{revision:string;required:boolean}[]>`
      SELECT d.target_revision AS revision,d.required FROM skill_dependencies d JOIN revisions v ON v.id=d.target_revision JOIN records r ON r.id=v.record_id
      WHERE d.revision_id=${page.revision} AND (${this.privateAccess} OR (NOT r.archived AND r.published_revision=v.id)) ORDER BY d.target_revision`;
    const document=coreDocumentSchema.parse({title:page.title,slug:page.slug,body:page.body,maturity:info.maturity,check_policy:info.check_policy,
      topics:terms.filter(t=>t.vocabulary==='topic').map(t=>t.id),format:terms.find(t=>t.vocabulary==='format')?.id??null,
      relations:page.relations,sources:page.sources,derivations,skills:skills.map(s=>s.id),attachments:page.attachments});
    return {id,revision:page.revision,kind:info.kind,document,terms,
      skill:details.length?skillSchema.parse({...details[0],dependencies}):null,
      origin:info.kind==='source'?page.metadata:null,original_base64:page.original_base64,original_hash:page.original_hash,
      legacy_revision:!info.native?page.revision:this.privateAccess?info.legacy_revision:null,
      content_hash:page.content_hash,created_at:new Date(page.created_at).toISOString(),
      edit_locked:this.privateAccess?info.edit_locked:null,lock_version:this.privateAccess?info.lock_version:null};
  }

  async catalog(options:CoreFilter) {
    this.ensureAccess();
    if(options.collection) {
      requireCondition(this.privateAccess,'not_found','Collection unavailable',404);
      const found=await this.db`SELECT id FROM collections WHERE id=${options.collection} AND NOT archived`;
      requireCondition(found.length,'not_found','Collection unavailable',404);
    }
    const words=options.query?.match(/[\p{L}\p{N}_-]+/gu)?.slice(0,40)??[];
    const run=async (broad:boolean)=>this.db<{id:string;revision:string;kind:Kind;title:string;slug:string;maturity:string|null;score:number}[]>`
      WITH candidates AS (
        SELECT r.id,v.id AS revision,r.kind,v.title,v.slug,d.maturity,v.search_en,v.search_ru
        FROM records r JOIN revisions v ON v.id=CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END
        JOIN revision_details d ON d.revision_id=v.id WHERE NOT r.archived
        AND (${options.kind??null}::text IS NULL OR r.kind=${options.kind??null})
        AND (${options.maturity??null}::text IS NULL OR d.maturity=${options.maturity??null})
        AND (${options.topic??null}::uuid IS NULL OR EXISTS(SELECT 1 FROM revision_terms t WHERE t.revision_id=v.id AND t.term_id=${options.topic??null} AND t.vocabulary='topic'))
        AND (${options.format??null}::uuid IS NULL OR EXISTS(SELECT 1 FROM revision_terms t WHERE t.revision_id=v.id AND t.term_id=${options.format??null} AND t.vocabulary='format'))
        AND (${options.collection??null}::uuid IS NULL OR EXISTS(SELECT 1 FROM collection_members m WHERE m.record_id=r.id AND m.collection_id=${options.collection??null}))
      ), q AS (SELECT websearch_to_tsquery('english',${words.join(broad?' OR ':' ')}) en,websearch_to_tsquery('russian',${words.join(broad?' OR ':' ')}) ru)
      SELECT a.id,a.revision,a.kind,a.title,a.slug,a.maturity,
        greatest(ts_rank_cd(a.search_en,q.en),ts_rank_cd(a.search_ru,q.ru)) AS score
      FROM candidates a CROSS JOIN q WHERE ${!options.query} OR a.search_en@@q.en OR a.search_ru@@q.ru
      ORDER BY score DESC,a.id LIMIT ${options.limit+1} OFFSET ${options.offset}`;
    let rows=await run(options.mode==='broad');
    if(!rows.length&&options.query&&options.mode==='auto')rows=await run(true);
    return {items:rows.slice(0,options.limit),next_offset:rows.length>options.limit?options.offset+options.limit:null};
  }

  async context(ids:string[],limit=60_000,revisions?:Map<string,string>) {
    const records:Awaited<ReturnType<CoreReader['record']>>[]=[];
    let used=0;
    for(const id of [...new Set(ids)]) {
      const record=await this.record(id,revisions?.get(id));
      const size=Buffer.byteLength(JSON.stringify(record));
      if(used+size>limit)return {records,truncated:true,remaining_ids:ids.filter(id=>!records.some(r=>r.id===id)),next_action:'Fetch remaining records with wiki_get_page and contract_version=3; originals are never summarized.'};
      records.push(record);used+=size;
    }
    return {records,truncated:false,remaining_ids:[],next_action:null};
  }

  async relationships(id:string,revision?:string,offset=0) {
    const record=await this.record(id,revision);
    const rows=await this.db<{id:string;revision:string;kind:string}[]>`SELECT r.id,v.id AS revision,e.kind FROM records r
      JOIN revisions v ON v.id=CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END
      JOIN relations e ON e.revision_id=v.id WHERE e.target_id=${id} AND NOT r.archived
      ORDER BY r.id,e.kind LIMIT 201 OFFSET ${offset}`;
    return {outgoing:record.document.relations,incoming:rows.slice(0,200),incoming_next_offset:rows.length>200?offset+200:null};
  }
  async provenance(id:string,revision?:string,offset=0) {
    const record=await this.record(id,revision);
    const rows=await this.db<{id:string;revision:string}[]>`SELECT DISTINCT r.id,v.id AS revision FROM records r
      JOIN revisions v ON v.id=CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END
      JOIN provenance p ON p.revision_id=v.id WHERE p.source_revision=${record.revision} AND NOT r.archived
      ORDER BY r.id LIMIT 201 OFFSET ${offset}`;
    return {sources:record.document.sources,processed_to:rows.slice(0,200),original_hash:record.original_hash,next_offset:rows.length>200?offset+200:null};
  }
  async lineage(id:string,revision?:string,offset=0) {
    const record=await this.record(id,revision);
    const dependents=await this.db<{id:string;revision:string;kind:string}[]>`
      SELECT r.id,v.id AS revision,e.kind FROM records r
      JOIN revisions v ON v.id=CASE WHEN ${this.privateAccess} THEN r.current_revision ELSE r.published_revision END
      JOIN derivations e ON e.revision_id=v.id WHERE e.target_revision=${record.revision} AND NOT r.archived
      ORDER BY r.id,e.kind LIMIT 201 OFFSET ${offset}`;
    return {record_id:id,revision:record.revision,derivations:record.document.derivations,
      dependents:dependents.slice(0,200),truncated:dependents.length>200,next_offset:dependents.length>200?offset+200:null};
  }
}
