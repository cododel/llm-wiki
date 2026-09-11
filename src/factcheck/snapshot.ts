import type {Database} from '../storage/database.ts';
import type {Identity} from '../auth/identity.ts';
import {Reader,type Snapshot} from '../content/reads.ts';
import {CoreReader} from '../content/core-reads.ts';

export interface NativeSnapshot {
  contract_version:3;id:string;revision:string;title:string;body:string;content_hash:string;sources:Snapshot['sources'];
  record:Awaited<ReturnType<CoreReader['record']>>;
}
export type WorkSnapshot=Snapshot|NativeSnapshot;
export const isNativeSnapshot=(snapshot:WorkSnapshot):snapshot is NativeSnapshot=>'contract_version' in snapshot;
export async function capture(db:Database,identity:Identity,id:string,revision?:string):Promise<WorkSnapshot> {
  const record=await new CoreReader(db,identity,{publicEnabled:false}).record(id,revision);
  const [details]=await db`SELECT native FROM revision_details WHERE revision_id=${record.revision}`;
  if(!details.native)return new Reader(db,identity,{publicEnabled:false}).page(id,record.revision);
  return {contract_version:3,id,revision:record.revision,title:record.document.title,body:record.document.body,
    content_hash:record.content_hash,sources:record.document.sources,record};
}
