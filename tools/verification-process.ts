/** Own child processes so interruption reaches the resource owner's finally block. */
export class VerificationProcesses {
  private children=new Map<ReturnType<typeof Bun.spawn>,()=>void>();
  interrupted=false;
  private interrupt=()=>{
    this.interrupted=true;
    for(const stop of this.children.values())stop();
  };
  constructor(){process.on('SIGINT',this.interrupt);process.on('SIGTERM',this.interrupt);}
  async run(command:string[],options:{cwd:string;env?:Record<string,string|undefined>;capture?:boolean;input?:Uint8Array;timeout?:number;killGrace?:number;cleanup?:boolean}) {
    if(this.interrupted&&!options.cleanup)throw new Error('Verification interrupted');
    const child=Bun.spawn(command,{cwd:options.cwd,env:options.env,stdin:options.input?'pipe':'ignore',stdout:options.capture?'pipe':'inherit',stderr:'inherit'});
    let timedOut=false,hardKill:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{child.kill('SIGTERM');hardKill??=setTimeout(()=>child.kill('SIGKILL'),options.killGrace??30_000);};
    this.children.set(child,stop);
    const timeout=setTimeout(()=>{timedOut=true;stop();},options.timeout??180_000);
    try{
      if(options.input&&child.stdin){child.stdin.write(options.input);child.stdin.end();}
      const bytes=options.capture?new Uint8Array(await new Response(child.stdout).arrayBuffer()):new Uint8Array();
      const code=await child.exited;
      if(timedOut)throw new Error(`Verification subprocess timed out: ${command[0]}`);
      if(code!==0)throw new Error(`Verification subprocess failed (${code}): ${command[0]}`);
      if(this.interrupted&&!options.cleanup)throw new Error('Verification interrupted');
      return bytes;
    }finally{clearTimeout(timeout);if(hardKill)clearTimeout(hardKill);this.children.delete(child);}
  }
  close(){process.off('SIGINT',this.interrupt);process.off('SIGTERM',this.interrupt);}
}
