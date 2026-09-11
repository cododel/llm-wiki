import type {SQL} from 'bun';

/** API and worker await this resumable projection before serving any requests. */
export async function backfillCore(db:SQL,batchSize=1000,maxBatches=Number.POSITIVE_INFINITY) {
  let batches=0,total=0;
  while(batches<maxBatches) {
    const count=await db.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(71822001)`;
      const rows=await tx<{revision_id:string}[]>`SELECT revision_id FROM legacy_backfill_pending ORDER BY revision_id LIMIT ${batchSize} FOR UPDATE`;
      if(!rows.length)return 0;
      const ids=tx.array(rows.map(row=>row.revision_id),'UUID');
      await tx`INSERT INTO revision_details(revision_id,native,maturity,check_policy)
        SELECT v.id,false,NULL,CASE WHEN r.type IN ('raw-source','meta','adr') OR v.generated THEN 'manual' ELSE 'automatic' END
        FROM revisions v JOIN records r ON r.id=v.record_id WHERE v.id=ANY(${ids})`;
      await tx`INSERT INTO revision_terms SELECT rt.revision_id,m.term_id,'topic',rt.tag,'{}'
        FROM revision_tags rt JOIN legacy_term_map m USING(tag) WHERE rt.revision_id=ANY(${ids})`;
      await tx`INSERT INTO revision_terms SELECT v.id,md5('llm-wiki:legacy-format:'||r.type)::uuid,'format',r.type,'{}'
        FROM revisions v JOIN records r ON r.id=v.record_id WHERE r.kind='record' AND v.id=ANY(${ids})`;
      await tx`DELETE FROM legacy_backfill_pending WHERE revision_id=ANY(${ids})`;
      return rows.length;
    });
    if(!count)break;
    batches++;total+=count;
  }
  return {batches,revisions:total};
}
