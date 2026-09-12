import {test,expect} from 'bun:test';
import {tmpdir} from 'node:os';
import {VerificationProcesses} from '../tools/verification-process.ts';

test('timeout cannot pass when a child ignores TERM and exits zero later',async()=>{
  const processes=new VerificationProcesses();
  try{
    await expect(processes.run([process.execPath,'-e',"process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),500)"],{cwd:tmpdir(),timeout:150,killGrace:1000})).rejects.toThrow('timed out');
  }finally{processes.close();}
});
test('uncooperative timed-out child is killed after cleanup grace',async()=>{
  const processes=new VerificationProcesses(),start=performance.now();
  try{
    await expect(processes.run([process.execPath,'-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],{cwd:tmpdir(),timeout:150,killGrace:100})).rejects.toThrow('timed out');
    expect(performance.now()-start).toBeLessThan(3000);
  }finally{processes.close();}
});
