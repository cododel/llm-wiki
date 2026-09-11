import type {Transaction} from '../storage/database.ts';

/** V2 ingestion retains its original contract while populating the fixed native projection. */
export async function projectLegacyRevision(tx:Transaction,revision:string,type:string) {
  await tx`INSERT INTO terms(id,vocabulary,name)
    SELECT md5('llm-wiki:legacy-tag:'||t.tag)::uuid,'topic',t.tag FROM revision_tags t WHERE t.revision_id=${revision}
    ON CONFLICT(id) DO NOTHING`;
  await tx`INSERT INTO legacy_term_map SELECT t.tag,md5('llm-wiki:legacy-tag:'||t.tag)::uuid FROM revision_tags t WHERE t.revision_id=${revision}
    ON CONFLICT(tag) DO NOTHING`;
  await tx`INSERT INTO revision_terms SELECT t.revision_id,m.term_id,'topic',t.tag,'{}' FROM revision_tags t
    JOIN legacy_term_map m USING(tag) WHERE t.revision_id=${revision}`;
  if(type!=='raw-source') {
    await tx`INSERT INTO terms(id,vocabulary,name) VALUES(md5('llm-wiki:legacy-format:'||${type})::uuid,'format',${type}) ON CONFLICT(id) DO NOTHING`;
    await tx`INSERT INTO revision_terms VALUES(${revision},md5('llm-wiki:legacy-format:'||${type})::uuid,'format',${type},'{}')`;
  }
}
