import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url)),dataRoot=join(root,'.data');
async function fixture(){
 await mkdir(dataRoot,{recursive:true});const folder=await mkdtemp(join(dataRoot,'adapter-test-'));
 let child:ChildProcess|undefined,base='';
 async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}child=undefined;}
 return {folder,get base(){return base;},stop,
  async start(){const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));base='http://127.0.0.1:'+port;
   child=spawn(process.execPath,['local/server.mjs','--port',String(port),'--data',folder,'--pow','0'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
   await new Promise<void>((ok,bad)=>{let text='';const ready=(chunk:Buffer)=>{text+=chunk.toString();if(text.includes('Kongjing local relay:')){child!.stdout!.off('data',ready);ok();}};child!.stdout!.on('data',ready);child!.once('error',bad);child!.once('exit',(code)=>bad(new Error('Local relay startup exited '+code)));child!.stderr!.on('data',()=>{});});
  },
  async dispose(){await stop();if(!resolve(folder).startsWith(resolve(dataRoot)+sep))throw new Error('Unsafe test cleanup path');await rm(folder,{recursive:true,force:true});}
 };
}

it('cold concurrent requests share one Guard and enforce the exact 300/IP quota',async()=>{
 const f=await fixture();try{await f.start();const statuses=await Promise.all(Array.from({length:301},async()=>{const r=await fetch(f.base+'/v1/health');await r.text();return r.status;}));expect(statuses.filter(s=>s===200)).toHaveLength(300);expect(statuses.filter(s=>s===429)).toHaveLength(1);}finally{await f.dispose();}
},30000);

it('local defaults and self-hosted template allow Android preflight/GET without allowing other origins',async()=>{
 const f=await fixture(),origin='https://appassets.androidplatform.net';
 try{
  const template=await readFile(join(root,'wrangler.example.toml'),'utf8');
  expect(template).toMatch(/EXTRA_ORIGINS\s*=\s*"https:\/\/appassets\.androidplatform\.net"/);
  await f.start();
  for(const source of [origin,'http://localhost:5173','chrome-extension://agijcmabomapmbobdgblmckibkpobdij','https://evil.example',origin+'.evil.example']){
   for(const method of ['OPTIONS','GET']){
    const response=await fetch(f.base+'/v1/health',{method,headers:{Origin:source,...(method==='OPTIONS'?{'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'X-KJ-Token'}:{})}});
    expect(response.status).toBe(method==='OPTIONS'?204:200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe([origin,'http://localhost:5173','chrome-extension://agijcmabomapmbobdgblmckibkpobdij'].includes(source)?source:null);
    expect(response.headers.get('Vary')).toContain('Origin');await response.text();
   }
  }
 }finally{await f.dispose();}
},30000);

it('restart restores persisted alarms before serving expired group or pair rooms',async()=>{
 const f=await fixture();try{
  await f.start();const room=randomBytes(24).toString('base64url'),pairRoom=randomBytes(24).toString('base64url'),token='test-capability';
  const proof=async(purpose:string)=>({...await(await fetch(f.base+'/v1/pow?purpose='+purpose)).json(),nonce:'AAAAAAAAAAA'});
  let r=await fetch(f.base+'/v1/groups',{method:'POST',body:JSON.stringify({room,tokenHash:createHash('sha256').update(token).digest('hex'),pow:await proof('group')})});expect(r.status).toBe(201);await r.text();
  r=await fetch(f.base+'/v1/groups/'+room+'/snapshot',{method:'PUT',headers:{'X-KJ-Token':token,'If-Match':'"0"'},body:'test ciphertext'});expect(r.status).toBe(200);await r.text();
  r=await fetch(f.base+'/v1/pair',{method:'POST',body:JSON.stringify({room:pairRoom,pow:await proof('pair')})});expect(r.status).toBe(201);await r.text();await f.stop();
  const groupFile=join(f.folder,'do/groups',Buffer.from(room).toString('hex')+'.json'),pairFile=join(f.folder,'do/pairs',Buffer.from(pairRoom).toString('hex')+'.json');
  const group=JSON.parse(await readFile(groupFile,'utf8')),pair=JSON.parse(await readFile(pairFile,'utf8'));group.meta.last=Date.now()-181*86400000;group._alarm=Date.now()-1;pair.meta.expiresAt=Date.now()-1;pair._alarm=Date.now()-1;
  await writeFile(groupFile,JSON.stringify(group));await writeFile(pairFile,JSON.stringify(pair));await f.start();
  r=await fetch(f.base+'/v1/groups/'+room+'/snapshot',{headers:{'X-KJ-Token':token}});expect(r.status).toBe(404);await r.text();
  await expect(readFile(join(f.folder,'r2/g',room,'snapshot'))).rejects.toMatchObject({code:'ENOENT'});
  expect(JSON.parse(await readFile(pairFile,'utf8')).meta).toBeUndefined();
  const capacity=JSON.parse(await readFile(join(f.folder,'do/guards',Buffer.from('kongjing-capacity').toString('hex')+'.json'),'utf8'));expect(capacity.count).toBe(0);
 }finally{await f.dispose();}
},30000);
