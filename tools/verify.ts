#!/usr/bin/env bun
import { resolve } from 'node:path';
const repository=resolve(import.meta.dir,'..');
for(const script of ['tools/verify-package.ts','tools/verify-service.ts','tools/verify-compose.ts']) {
  const child=Bun.spawn([process.execPath,'run',resolve(repository,script)],{
    cwd:repository,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdout:'inherit',stderr:'inherit',
  });
  const status=await child.exited;
  if(status!==0)process.exit(status);
}
console.log('Unified local verification passed. External client reconnect and schedules are not verified.');
