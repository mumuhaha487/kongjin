/** Real library/HTTP/WS/SQLite; sparse visits across a virtual eight-hour day. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import WebSocket from 'ws';
import {KongjingSync,MemoryQueueStore,MemorySecretStore,identity,deriveGroup,b64url,random,hex,sha256,utf8} from '../../shared/protocol/src/index.ts';
const native={now:Date.now,timeout:globalThis.setTimeout,clear:globalThis.clearTimeout,interval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
const sleep=(ms:number)=>new Promise<void>(r=>native.timeout(r,ms));
// Start in the future so workerd's real alarm clock cannot race the virtual clock.
let time=Math.ceil(Date.now()/3600000)*3600000,timerId=0;
const timers=new Map<number,{at:number,fn:()=>void,interval?:number}>();
const modelTimers=new Set([0,800,1000,5000,10000,30000,60000,300000,600000]);
function installClock(){
 Date.now=()=>time;
 globalThis.setTimeout=((fn:any,ms=0,...args:any[])=>{if(!modelTimers.has(ms))return native.timeout(fn,ms,...args);const id=++timerId;timers.set(id,{at:time+ms,fn:()=>fn(...args)});return id;})as any;
 globalThis.setInterval=((fn:any,ms:number,...args:any[])=>{const id=++timerId;timers.set(id,{at:time+ms,fn:()=>fn(...args),interval:ms});return id;})as any;
 globalThis.clearTimeout=((id:any)=>{if(!timers.delete(id))native.clear(id);})as any;
 globalThis.clearInterval=((id:any)=>{if(!timers.delete(id))native.clearInterval(id);})as any;
}
function restoreClock(){Date.now=native.now;globalThis.setTimeout=native.timeout;globalThis.clearTimeout=native.clear;globalThis.setInterval=native.interval;globalThis.clearInterval=native.clearInterval;timers.clear();}
async function run(target:'local'|'workerd'){
 let mf:any,child:any,base:string;
 await mkdir('.data',{recursive:true});await mkdir('artifacts',{recursive:true});
 if(target==='local'){
  const dir=await mkdtemp(resolve('.data/daily-'));
  child=spawn(process.execPath,['local/server.mjs','--port','8794','--data',dir,'--pow','0','--sqlite','--test-controls'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stderr.on('data',(b:Buffer)=>{if(!b.toString().includes('ExperimentalWarning')&&!b.toString().includes('trace-warnings'))console.error(b.toString());});
  base='http://127.0.0.1:8794';for(let i=0;i<100;i++){try{if((await fetch(base+'/__test/metrics')).ok)break;}catch{}await sleep(50);}
 }else{
  const {outputFiles}=await build({entryPoints:['test/continuity-runtime.mjs'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});
  mf=new Miniflare({...convertV4MiniflareOptions({workers:[{name:'kongjing-daily-test',modules:true,script:outputFiles[0].text,compatibilityDate:'2026-10-21',durableObjects:{GROUPS:{className:'GroupRoom',useSQLite:true},PAIRS:{className:'PairRoom',useSQLite:true},GUARDS:{className:'Guard',useSQLite:true}},r2Buckets:['BUCKET'],bindings:{TESTING:'true',LOCAL:'true',TEST_CONFIG:'{"difficulty":0}',POW_SECRET:'daily-test-only',IP_HASH_SALT:'daily-test-only'}}]}),unsafeInspectDurableObjects:true});base=(await mf.ready).origin;
 }
 const clients:any[]=[],counts:Record<string,number>={},delivered=[new Set(),new Set(),new Set()];let active=0,upgrades=0;
 const rawFetch=fetch;
 const request:typeof fetch=(async(url:any,init:any={})=>{
  const headers=new Headers(init.headers);headers.set('X-Test-Clock',String(time));active++;
  try{const r=await rawFetch(url,{...init,headers});const key=(init.method??'GET')+' '+new URL(url).pathname.replace(/[\w-]{32}|[\w-]{22}/g,':id');counts[key]=(counts[key]??0)+1;assert.notEqual(r.status,429,'Unexpected rate limit in sparse workload');return r;}finally{active--;}
 })as any;
 const control=async(path:string)=>{const r=await rawFetch(base+'/__test/'+path,{headers:{'X-Test-Clock':String(time)}});if(r.status!==200)throw new Error(path+': '+r.status+' '+await r.text());return r.json();};
 const settle=async()=>{
  for(let i=0;i<50;i++){await sleep(3);for(const c of clients){await c.continuity.enqueues;await c.continuity.commits;await c.continuity.saves;}if(active)continue;await sleep(4);if(!active)return;}throw new Error('Network did not settle');
 };
 const advance=async(to:number)=>{
  for(;;){const due=[...timers].filter(([,t])=>t.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;await control('tick');
   for(const[id,t]of [...timers].filter(([,t])=>t.at<=time)){if(!timers.has(id))continue;if(t.interval)t.at+=t.interval;else timers.delete(id);t.fn();}await settle();}
  time=to;await control('tick');await settle();
 };
 try{
  const ids=await Promise.all([identity(),identity(),identity()]),gk=random(32),keys=await deriveGroup(gk,1);
  const pow=await(await request(base+'/v1/pow?purpose=group')).json();
  const r=await request(base+'/v1/groups',{method:'POST',body:JSON.stringify({room:keys.roomId,tokenHash:hex(await sha256(utf8(keys.roomToken))),pow:{...pow,nonce:b64url(new Uint8Array(8))}})});assert.equal(r.status,201);
  const members=ids.map((id,i)=>({deviceId:id.deviceId,pub:id.pub,name:'Daily '+i,platform:'Node',joinedAt:time,addedBy:ids[0].deviceId}));installClock();
  for(let i=0;i<3;i++){
   const secrets=new MemorySecretStore();await secrets.set('identity',ids[i]);await secrets.set('group',{gk:b64url(gk),epoch:1,members,rev:0,name:'Daily '+i,platform:'Node'});
   const c=new KongjingSync({relayUrl:base,secrets,queueStore:new MemoryQueueStore(),loadLocal:async()=>({}),saveMerged:async()=>{},merge:(a,b)=>({...a,...b}),fetch:request,WebSocket:class extends WebSocket{constructor(u:any,p:any){upgrades++;super(u,p);}}as any});
   c.onJournal(rows=>{for(const row of rows)delivered[i].add(row.id);});c.onSlots(()=>{});clients.push(c);await c.init();
  }
  await settle();for(const c of clients)assert.equal(c.status().connection,'online');const start=time;
  for(let i=0;i<500;i++){
   await advance(start+i*57600);const c=clients[i%3],visit={u:'https://daily-load.example/'+i,ti:'Daily title '+i,at:time};
   c.journalAppend('hv',{v:[visit]});await c.putSlot({windows:[{focused:true,tabs:[{...visit,active:true}]}],last:visit});await settle();await advance(time+12000);
   if(i%100===99)console.log(target+': '+(i+1)+' sparse visits');
  }
  await advance(start+8*3600000);assert.deepEqual(delivered.map(d=>d.size),[500,500,500]);
  for(const c of clients){assert.equal(c.journalCursor(),500);assert.equal(c.status().error,undefined);}
  const metrics=await control('metrics'),result={timestamp:new Date(native.now()).toISOString(),target,model:{devices:3,visits:500,onlineHoursPerDevice:8,slotChanges:500,spacingSeconds:57.6},...metrics,httpByRoute:counts,websocketUpgrades:upgrades,httpIncludingUpgrades:metrics.http+(target==='local'?upgrades:0),applicationUniqueRecords:delivered.map(d=>d.size),limitsUnchanged:true,result:'passed'};
  assert.ok(result.sqlWrites<=5000,'SQLite write budget: '+result.sqlWrites);assert.ok(result.httpIncludingUpgrades<=2500,'HTTP budget: '+result.httpIncludingUpgrades);
  await writeFile('artifacts/daily-load-'+target+'.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{for(const c of clients)c.dispose();restoreClock();if(mf)await mf.dispose();if(child)child.kill();}
}
for(const target of (process.argv[2]?[process.argv[2]]:['local','workerd']))await run(target as any);

