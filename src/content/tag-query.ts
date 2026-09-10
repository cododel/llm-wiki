import { Reader } from './reads.ts';
import { discoveryTags } from './taxonomy.ts';
import { requireCondition } from '../runtime/errors.ts';

export async function queryTags(reader:Reader, mode:'counts'|'show'|'suggest'|'validate', tag?:string, id?:string) {
  reader.ensureAccess();
  const tags=await reader.db<{tag:string;description:string;count:number}[]>`
    WITH visible AS MATERIALIZED (
      SELECT v.id FROM records r JOIN revisions v ON v.id=CASE WHEN ${reader.privateAccess} THEN r.current_revision ELSE r.published_revision END
      WHERE NOT r.archived
    ) SELECT t.tag,CASE WHEN ${reader.privateAccess} THEN t.description ELSE '' END AS description,count(visible.id)::int AS count FROM taxonomy t
    LEFT JOIN revision_tags rt ON rt.tag=t.tag LEFT JOIN visible ON visible.id=rt.revision_id
    GROUP BY t.tag,t.description HAVING ${reader.privateAccess} OR count(visible.id)>0 ORDER BY t.tag`;
  if(mode==='show')requireCondition(tag,'invalid_input','show requires tag');
  if(mode==='suggest')requireCondition(id,'invalid_input','suggest requires id');
  const page=id?await reader.page(id):null;
  const warnings:string[]=[];
  if(mode==='validate') {
    // Revision acceptance enforces taxonomy membership; this checks layer discovery rules as well.
    let offset=0;
    for(;;) {
      const batch=await reader.list({limit:100,offset});
      for(const row of batch) {
        const snapshot=await reader.page(row.id,row.revision),required=discoveryTags[snapshot.type];
        if(required&&!required.some(t=>snapshot.tags.includes(t)))warnings.push(`${row.id}: missing discovery tag`);
      }
      if(batch.length<100)break;
      offset+=100;
    }
  }
  return {mode,tags:mode==='show'?tags.filter(t=>t.tag===tag):tags,
    selected:page?.tags??[],required:page?discoveryTags[page.type]??[]:[],
    context:mode==='suggest'&&page?{id:page.id,title:page.title,type:page.type,excerpt:page.body.slice(0,2000)}:null,warnings};
}
