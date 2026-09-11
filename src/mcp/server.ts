import type { SQL } from 'bun';
import type { z as Zod } from 'zod';
import type { Identity } from '../auth/identity.ts';
import { Reader } from '../content/reads.ts';
import { sectionBody } from '../content/sections.ts';
import { queryTags } from '../content/tag-query.ts';
import { campaignSummary } from '../factcheck/summary.ts';
import { health,lint,visibility } from '../content/diagnostics.ts';
import { applyChange } from '../content/changes.ts';
import { requestPublication, unpublish } from '../content/publication.ts';
import { changeSchema, hashSchema, idSchema, documentSchema } from '../content/schema.ts';
import { search, regexSearch } from '../search/search.ts';
import { Queue } from '../factcheck/queue.ts';
import { workflow, resultSchema, type WorkSettings } from '../factcheck/protocol.ts';
import { complete, fail, listEvents, markEvent, assignmentResult } from '../factcheck/results.ts';
import { errorResult } from '../runtime/errors.ts';
import { BlobStore } from '../storage/blobs.ts';
import { snapshotSchema, catalogItem, searchItem, boundedList, pageInput, jobInput, claimInput, searchInput } from './schemas.ts';
import { coreTools } from './core-tools.ts';
import { workTaskSchema } from './work-schemas.ts';
import { requireCondition } from '../runtime/errors.ts';
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = await import('zod');

export interface McpContext { db: SQL; identity: Identity; publicationEnabled: boolean; work: WorkSettings; blobs: BlobStore }
export function createMcp(context: McpContext) {
  const { db, identity, publicationEnabled, work, blobs } = context;
  const reader = new Reader(db, identity, { publicEnabled: publicationEnabled }), queue = new Queue(db,work);
  const server = new McpServer({ name: 'llm-wiki', version: '3.0.0' });
  const native=coreTools(context),registered=new Set<string>();
  function tool<I extends Zod.ZodRawShape, O extends Zod.ZodRawShape>(name: string, description: string, input: Zod.ZodObject<I>, output: Zod.ZodObject<O>,
    handler: (args: Zod.infer<Zod.ZodObject<I>>) => Promise<unknown>, readonly = true,defaultVersion:2|3=2) {
    registered.add(name);
    const v3=native.get(name);
    const shape:Zod.ZodRawShape={...input.shape};
    if(v3)for(const [key,value] of Object.entries(v3.input.shape))shape[key]=key in shape?z.union([shape[key]!,value]):value;
    // Version-specific strict parsing below owns required fields and forbids cross-version mixing.
    const advertised=z.object(shape).partial().extend({contract_version:z.union([z.literal(2),z.literal(3)]).default(defaultVersion)}).strict();
    const envelope = z.object({ version: z.union([z.literal(2),z.literal(3)]), data: (v3?z.union([output,v3.output]):output).optional(), error: z.object({ code: z.string(), message: z.string(), status: z.number() }).strict().optional() }).strict();
    server.registerTool(name, { description: v3?`${description} Native v3: ${v3.description}`:description, inputSchema: advertised, outputSchema: envelope, annotations: { readOnlyHint: readonly, destructiveHint: false, openWorldHint: false } }, async args => {
      const {contract_version:version,...fields}=advertised.parse(args);
      try {
        requireCondition(version===3||defaultVersion===2,'unsupported_contract','This tool requires contract_version=3',409);
        requireCondition(version!==3||name!=='wiki_tags','unsupported_contract','wiki_tags is a legacy-only projection; use wiki_terms_list with v3',409);
        if(version===2&&readonly&&name.startsWith('wiki_')&&!name.startsWith('wiki_assignment')&&!name.startsWith('wiki_review')&&!name.startsWith('wiki_events')) {
          reader.ensureAccess();
          // Never return a fabricated old type or silently omit native catalog entries.
          const explicitId=idSchema.safeParse(fields.id);
          const exact=name==='wiki_get_page'?pageInput.parse(fields):explicitId.success?{id:explicitId.data,revision:undefined}:null;
          const rows=await db`SELECT v.id FROM records r JOIN revisions v
            ON v.id=COALESCE(${exact?.revision??null}::uuid,CASE WHEN ${reader.privateAccess} THEN r.current_revision ELSE r.published_revision END)
            JOIN revision_details d ON d.revision_id=v.id WHERE (NOT r.archived OR (${!!exact} AND ${reader.privateAccess})) AND d.native
            AND (${exact?.id??null}::uuid IS NULL OR r.id=${exact?.id??null}) AND v.record_id=r.id
            AND (${reader.privateAccess} OR r.published_revision=v.id) LIMIT 1`;
          requireCondition(!rows.length,'unsupported_contract','Visible native data requires contract_version=3',409);
        }
        // Serialization normalizes database timestamps before strict output validation.
        const result=version===3&&v3?await v3.run(fields):await handler(input.parse(fields));
        if(version===2&&['wiki_factcheck_next','wiki_review_next','wiki_assignment_get'].includes(name)) {
          const parsed=workTaskSchema.nullable().safeParse(name==='wiki_assignment_get'?result:
            result&&typeof result==='object'&&'task' in result?result.task:null);
          requireCondition(!parsed.success||parsed.data?.version!==2,'unsupported_contract','Assignment requires contract_version=3; its pinned snapshot is unchanged',409);
        }
        const data = (version===3&&v3?v3.output:output).parse(JSON.parse(JSON.stringify(result)));
        const content = { version, data };
        return { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content };
      } catch (error) {
        const content = { version, error: error instanceof z.ZodError?{code:'invalid_input',message:'Request or result does not match the contract',status:400}:errorResult(error) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content };
      }
    });
  }
  const empty = z.object({}).strict();
  tool('wiki_get_page','Read an authorized stable ID, optional revision and exact unique heading; filesystem paths are not supported.',pageInput,z.object({ page: snapshotSchema }).strict(),async a => {
    const page=await reader.page(a.id,a.revision);
    return {page:a.heading?{...page,body:sectionBody(page.body,a.heading)}:page};
  });
  tool('wiki_list','Get the authorized paginated catalog.',boundedList,z.object({ items: z.array(catalogItem) }).strict(),async a => ({ items: await reader.list(a) }));
  tool('wiki_resolve','Resolve an ID, slug or title without guessing ambiguous matches.',z.object({ name: z.string().min(1).max(300) }).strict(),
    z.object({ status: z.enum(['resolved','ambiguous','not_found']), candidates: z.array(catalogItem.omit({ type: true })) }).strict(),a => reader.resolve(a.name));
  tool('wiki_search','RU/EN full-text search over authorized revisions.',searchInput,z.object({ items: z.array(searchItem) }).strict(),async a => ({ items: await search(reader,a) }));
  tool('wiki_search_and_read','Search and read bounded authorized snapshots.',searchInput,z.object({ items: z.array(snapshotSchema) }).strict(),async a => ({ items: await Promise.all((await search(reader,a)).map(hit => reader.page(hit.id,hit.revision))) }));
  tool('wiki_regex_search','Bounded ripgrep regex on authorized snapshots through stdin.',z.object({ pattern: z.string().min(1).max(1000), limit: z.number().int().min(1).max(100).default(20) }).strict(),
    z.object({ matches: z.array(z.object({ id: idSchema, revision: idSchema, line: z.number().int(), text: z.string() }).strict()), truncated: z.boolean() }).strict(),a => regexSearch(reader,a.pattern,a.limit));
  tool('wiki_get_related','Get authorized incoming and outgoing relationships.',z.object({ id: idSchema }).strict(),
    z.object({ outgoing: documentSchema.shape.relations, incoming: z.array(z.object({ id: idSchema, revision: idSchema, kind: z.string() }).strict()) }).strict(),a => reader.related(a.id));
  tool('wiki_get_sources','Get provenance and server-computed processed_to.',z.object({ id: idSchema }).strict(),
    z.object({ sources: documentSchema.shape.sources, processed_to: z.array(z.object({ id: idSchema, revision: idSchema }).strict()), original_hash: hashSchema.nullable() }).strict(),a => reader.sources(a.id));
  const count=z.number().int().nonnegative();
  tool('wiki_tags','Governed taxonomy counts, show, deterministic suggestion context, or validation.',
    z.object({mode:z.enum(['counts','show','suggest','validate']),tag:z.string().max(64).optional(),id:idSchema.optional()}).strict(),
    z.object({mode:z.string(),tags:z.array(z.object({tag:z.string(),description:z.string(),count}).strict()),selected:z.array(z.string()),required:z.array(z.string()),
      context:z.object({id:idSchema,title:z.string(),type:z.string(),excerpt:z.string()}).strict().nullable(),warnings:z.array(z.string())}).strict(),
    a=>queryTags(reader,a.mode,a.tag,a.id));
  tool('wiki_health_summary','Source checksums, tags, relations and provenance on visible revisions.',empty,
    z.object({visible_records:count,untagged:count,source_integrity_errors:count,invalid_relations:count,invalid_provenance:count}).strict(),()=>health(reader));
  tool('wiki_lint_summary','Layer-aware editorial warnings on visible revisions.',empty,
    z.object({visible_records:count,empty_body:count,missing_provenance:count,drafts_without_original:count}).strict(),()=>lint(reader));
  tool('wiki_audit_visibility','Audit the explicitly owner-approved revision surface.',empty,
    z.object({public_records:count,public_attachments:count,publication_enabled:z.boolean(),policy:z.literal('owner-approved-revision')}).strict(),()=>visibility(reader));
  tool('wiki_apply_change','Apply one typed atomic change group with expected revisions and idempotency.',changeSchema,
    z.object({ version: z.literal(2), changed: z.array(z.object({ id: idSchema, revision: idSchema.nullable() }).strict()) }).strict(),a => applyChange(db,identity,a),false);
  tool('wiki_ingest_attachment','Validate and persist an original binary before referencing it.',z.object({ original_base64: z.string().max(28_000_000), checksum: hashSchema, media_type: z.enum(['image/png','image/jpeg','application/pdf']) }).strict(),
    z.object({ hash: hashSchema, size: z.number().int(), media_type: z.string() }).strict(),a => blobs.ingest(identity,Buffer.from(a.original_base64,'base64'),a.media_type,a.checksum),false);
  tool('wiki_request_publication','Request owner browser approval of this exact revision and attachment set.',z.object({ id: idSchema, revision: idSchema, attachments: z.array(hashSchema).max(30) }).strict(),
    z.object({ request_id: idSchema }).strict(),a => requestPublication(db,identity,publicationEnabled,a.id,a.revision,a.attachments),false);
  tool('wiki_unpublish','Withdraw public access without deleting history.',z.object({ id: idSchema }).strict(),z.object({ unpublished: z.boolean() }).strict(),a => unpublish(db,identity,a.id),false);
  const task = z.object({ version: z.literal(1), job_id: idSchema, kind: z.enum(['factcheck','review']), state: z.string(),
    workflow: z.object({ version: z.literal(workflow.version), instructions: z.array(z.string()) }).strict(), snapshots: z.array(snapshotSchema),
    progress: z.unknown().nullable(), result_schema: z.record(z.unknown()) }).strict();
  for (const kind of ['factcheck','review'] as const) {
    native.set(`wiki_${kind}_next`,{description:'Pinned native or preserved legacy assignment. Claim before researching.',input:empty,
      output:z.object({task:workTaskSchema.nullable()}).strict(),run:async args=>{empty.parse(args);return {task:await queue.next(identity,kind)};},readonly:false});
    tool(`wiki_${kind}_next`,'Obtain available work; claim before researching.',empty,z.object({ task: task.nullable() }).strict(),async () => ({ task: await queue.next(identity,kind) }),false);
  }
  tool('wiki_review_start','Start a bounded review campaign of current snapshots.',z.object({ ids: z.array(idSchema).min(1).max(100), idempotency_key: z.string().min(1).max(128) }).strict(),
    z.object({ campaign_id: idSchema, jobs: z.array(idSchema) }).strict(),a => queue.reviewStart(identity,a.ids,a.idempotency_key),false);
  native.set('wiki_assignment_get',{description:'Read the exact versioned assignment snapshot.',input:jobInput,output:workTaskSchema,
    run:args=>queue.snapshot(identity,jobInput.parse(args).job_id),readonly:true});
  tool('wiki_assignment_get','Read a pinned assignment.',jobInput,task,a => queue.snapshot(identity,a.job_id));
  tool('wiki_assignment_result','Read the full accepted structured evidence behind a bounded readout.',jobInput,
    z.object({job_id:idSchema,result:resultSchema.nullable()}).strict(),a=>assignmentResult(db,identity,a.job_id));
  tool('wiki_review_summary','Get deterministic campaign progress and accepted result totals.',z.object({campaign_id:idSchema}).strict(),
    z.object({campaign_id:idSchema,total:count,finished:z.boolean(),states:z.array(z.object({state:z.string(),count}).strict()),
      verdicts:z.array(z.object({verdict:z.string(),count}).strict()),suggestions:count}).strict(),a=>campaignSummary(db,identity,a.campaign_id));
  tool('wiki_assignment_claim','Atomically reserve work for this identity.',jobInput,z.object({ job_id: idSchema, claim_token: idSchema, lease_until: z.string().datetime() }).strict(),a => queue.claim(identity,a.job_id),false);
  tool('wiki_assignment_progress','Save bounded progress and renew the owned lease.',claimInput.extend({ progress: z.object({ stage: z.string().max(200), notes: z.string().max(50000) }).strict() }).strict(),
    z.object({ saved: z.boolean() }).strict(),a => queue.progress(identity,a.job_id,a.claim_token,a.progress),false);
  tool('wiki_assignment_complete','Validate results, generate evidence, checkpoint and escalate atomically.',claimInput.extend({ result: resultSchema }).strict(),
    z.object({ job_id: idSchema, state: z.enum(['complete','blocked']) }).strict(),a => complete(db,identity,a.job_id,a.claim_token,a.result),false);
  tool('wiki_assignment_fail','Report technical failure without a successful checkpoint.',claimInput.extend({ reason: z.string().min(1).max(5000) }).strict(),
    z.object({ job_id: idSchema, state: z.enum(['pending','failed']) }).strict(),a => fail(db,identity,a.job_id,a.claim_token,a.reason,work.maxAttempts),false);
  tool('wiki_events_list','List durable escalations; delivery, acknowledgement and resolution are independent.',z.object({ offset: z.number().int().min(0).max(100000).default(0) }).strict(),
    z.object({ events: z.array(z.object({ id: idSchema, job_id: idSchema.nullable(), kind: z.string(), detail: z.record(z.unknown()), acknowledged_by:z.string().nullable(),acknowledged_at:z.string().nullable(),resolved_by:z.string().nullable(),resolved_at:z.string().nullable(),resolution:z.string().nullable(),created_at:z.string() }).strict()) }).strict(),async a => ({ events:await listEvents(db,identity,a.offset) }));
  for (const action of ['acknowledge','resolve'] as const) tool(`wiki_event_${action}`,'Record operator event handling without conflating delivery state.',z.object({ id:idSchema,resolution:z.string().min(1).max(5000).optional() }).strict(),z.object({ saved:z.boolean() }).strict(),a => markEvent(db,identity,a.id,action,a.resolution),false);
  for(const [name,spec] of native)if(!registered.has(name))tool(name,spec.description,spec.input,spec.output,spec.run,spec.readonly,3);
  return server;
}
