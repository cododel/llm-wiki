import {test,expect} from 'bun:test';
import {sectionBody} from '../src/content/sections.ts';
test('heading sections preserve nested content and ignore fenced headings',()=>{
  const body='# Start\n\n## Selected\nText\n```md\n# Fake\n```\n### Child\nChild text\n## Next\nEnd';
  expect(sectionBody(body,'Selected')).toBe('## Selected\nText\n```md\n# Fake\n```\n### Child\nChild text');
  expect(()=>sectionBody(body,'Fake')).toThrow();
  expect(()=>sectionBody('# Duplicate\n# Duplicate','Duplicate')).toThrow();
});
