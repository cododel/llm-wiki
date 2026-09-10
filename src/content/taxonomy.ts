import type { RecordType } from './schema.ts';
export const initialTags = [
  'pattern','architecture','methodology','workflow','tool','research','learning','thought',
  'person','company','open-source','engineering','product','security','automation',
  'content','article','social-media','writing-style','seo','semantic-core',
  'wiki','source','provenance','readout','evidence','analysis','factcheck','mcp',
  'idea','comparison','summary','meta','adr',
] as const;
export const discoveryTags: Partial<Record<RecordType,readonly string[]>> = {
  'raw-source':['source'],readout:['readout'],idea:['idea'],note:['thought','learning'],
  'post-draft':['content'],'article-draft':['content'],comparison:['comparison'],query:['summary'],adr:['adr'],meta:['meta','wiki','tool','mcp','workflow'],
};
