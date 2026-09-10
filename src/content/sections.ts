import { requireCondition } from '../runtime/errors.ts';

/** Heading selection preserves original lines and ignores fenced code. */
export function sectionBody(body: string, heading: string) {
  const lines=body.split('\n');
  const headings: { index:number; level:number; title:string }[]=[];
  let fence:string|null=null;
  for(let index=0;index<lines.length;index++) {
    const line=lines[index]!;
    const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker) {
      if(!fence) fence=marker[1]!;
      else if(marker[1]![0]===fence[0] && marker[1]!.length>=fence.length) fence=null;
      continue;
    }
    if(fence)continue;
    const match=line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if(match) headings.push({index,level:match[1]!.length,title:match[2]!});
  }
  const matches=headings.filter(item=>item.title===heading);
  requireCondition(matches.length===1,matches.length?'ambiguous':'not_found','Heading must resolve exactly once',matches.length?409:404);
  const selected=matches[0]!;
  const end=headings.find(item=>item.index>selected.index && item.level<=selected.level)?.index??lines.length;
  return lines.slice(selected.index,end).join('\n');
}
