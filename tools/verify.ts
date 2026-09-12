#!/usr/bin/env bun
import { resolve } from 'node:path';
import {mkdtemp,writeFile,readFile,appendFile} from 'node:fs/promises';
import {tmpdir,platform,arch} from 'node:os';
import {VerificationProcesses} from './verification-process.ts';
const repository=resolve(import.meta.dir,'..');
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--extended')||args.length>1)throw new Error('Usage: bun run tools/verify.ts [--extended]');
const extended=args.includes('--extended'),processes=new VerificationProcesses();
const directory=await mkdtemp(resolve(tmpdir(),'llm-wiki-verification-report-'));
const git=(args:string[])=>{
  const result=Bun.spawnSync(['git',...args],{cwd:repository,stdout:'pipe',stderr:'pipe'});
  if(result.exitCode!==0)throw new Error('Cannot fingerprint verification checkout');
  return result.stdout.toString().trim();
};
const stages=[
  {id:'package',script:'tools/verify-package.ts',invariant:'Distribution integrity and documented paths'},
  {id:'service',script:'tools/verify-service.ts',invariant:'Integrity, authorization, transactions, migration, queue and search regressions'},
  {id:'compose',script:'tools/verify-compose.ts',invariant:'Real OAuth, restart, backup and restoration'},
  ...(extended?[{id:'endurance',script:'tools/verify-service.ts',invariant:'Eight clients, 60 minutes at 10k; 100k headroom; durable state, no execution exhaustion, sampled resources'}]:[]),
];
const results=stages.map(s=>({id:s.id,invariant:s.invariant,status:'not run',duration_ms:0}));
const sourceFiles=[...new Set(git(['ls-files','--cached','--others','--exclude-standard']).split('\n').filter(Boolean))].sort();
const sourceHashes:Record<string,string>={};
for(const path of sourceFiles){try{sourceHashes[path]=new Bun.CryptoHasher('sha256').update(await readFile(resolve(repository,path))).digest('hex');}
  catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')sourceHashes[path]='deleted';else throw error;}}
const report={version:1,started_at:new Date().toISOString(),revision:git(['rev-parse','HEAD']),
  diff_sha256:new Bun.CryptoHasher('sha256').update(git(['diff','HEAD'])).digest('hex'),
  untracked:git(['ls-files','--others','--exclude-standard']).split('\n').filter(Boolean),
  source_sha256:new Bun.CryptoHasher('sha256').update(JSON.stringify(sourceHashes)).digest('hex'),source_files:sourceHashes,
  environment:{bun:Bun.version,os:platform(),arch:arch()},profile:extended?'extended':'base',results,
  operator:[{id:'real-agent',status:'not run',invariant:'User intent, retrieval and untrusted-content handling'},
    {id:'original-capture',status:'not run',invariant:'Independent input bytes equal stored originals through the real client transport'}]};
const save=()=>writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Verification report: ${directory}/report.json`);
if(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`report_directory=${directory}\n`);
try{
  await save();
  for(const [i,stage] of stages.entries()){
    const start=performance.now();
    try{
      await processes.run([process.execPath,'run',resolve(repository,stage.script),...(stage.id==='endurance'?['--endurance']:extended&&stage.id==='compose'?['--extended']:[])],{
        cwd:repository,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,VERIFICATION_REPORT_DIR:directory},
        timeout:stage.id==='endurance'?5_400_000:1_200_000,killGrace:120_000});
      results[i]!.status='passed';
    }catch(error){results[i]!.status='failed';throw error;}
    finally{results[i]!.duration_ms=Math.round(performance.now()-start);await save();}
  }
  console.log('Automated verification passed. Real-agent acceptance and original capture remain operator gates.');
}finally{await save();processes.close();}
