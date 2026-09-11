import type {SQL} from 'bun';
import {seed as initialize} from '../src/storage/seed.ts';
import {initialTags} from '../src/content/taxonomy.ts';
// V2 fixtures explicitly opt into the old taxonomy; production initialization stays empty.
export async function seed(db:SQL) {
  await initialize(db);
  for(const tag of initialTags)await db`INSERT INTO taxonomy VALUES(${tag},${`Legacy test facet: ${tag}`}) ON CONFLICT DO NOTHING`;
}
