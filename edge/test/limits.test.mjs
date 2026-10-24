import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRouter,hash,mac} from '../lib/router.mjs';
import {MemoryStorage,FileStorage} from '../lib/storage.mjs';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
test('local listing tolerates a signal consumed/deleted after directory enumeration',async()=>{
  const artifacts=fileURLToPath(new URL('../artifacts/',import.meta.url));await mkdir(artifacts,{recursive:true});const directory=await mkdtemp(resolve(artifacts,'file-race-'));
  if(!directory.startsWith(resolve(artifacts)+sep))throw new Error('Invalid test directory');
  try{const storage=new FileStorage(directory);await storage.set('sig/one',Buffer.alloc(29));const original=storage.head.bind(storage);storage.head=async key=>{await storage.delete(key);return original(key);};assert.deepEqual(await storage.list('sig/'),[]);}finally{await rm(directory,{recursive:true,force:true});}
});
const DAY=86400000;

for(const opaque of [false,true])test('identical encrypted PUTs skip storage rewrites (opaque etag='+opaque+')',async()=>{
  const clock=Date.now(),storage=new MemoryStorage(()=>clock),room='I'.repeat(32),slot='S'.repeat(22),token='write-test',router=createRouter({storage,secret:'write',now:()=>clock});
  if(opaque){const head=storage.head.bind(storage);storage.head=async key=>{const item=await head(key);return item?{...item,etag:'opaque-provider-etag'}:null;};}
  await storage.set('g/'+room+'/meta',Buffer.from(JSON.stringify({tokenHash:hash(token),createdAt:clock})));
  const send=bytes=>router(new Request('http://localhost/v2/rooms/'+room+'/obj/d/'+slot+'/state',{method:'PUT',headers:{'X-KJ-Token':token,'X-KJ-Slot':slot,'X-KJ-Slot-Proof':mac(token,slot)},body:bytes}));
  const before=storage.counts.set,first=await send(Buffer.alloc(29,1)),retry=await send(Buffer.alloc(29,1));assert.equal(first.status,200);assert.deepEqual(await first.json(),await retry.json());assert.equal(storage.counts.set-before,1);
  assert.equal((await send(Buffer.alloc(29,2))).status,200);assert.equal(storage.counts.set-before,2);
});
test('all object TTLs, room blob quota, invalid proof and slot capacity',async()=>{
  let clock=Date.UTC(2026,9,24);const storage=new MemoryStorage(()=>clock),room='R'.repeat(32),token='T'.repeat(43),slot='A'.repeat(22),router=createRouter({storage,secret:'tests',now:()=>clock});
  await storage.set('g/'+room+'/meta',Buffer.from(JSON.stringify({tokenHash:hash(token),createdAt:clock})));
  const req=(p,method='GET',data,extra={})=>router(new Request('http://localhost/v2/rooms/'+room+p,{method,headers:{'X-KJ-Token':token,'X-KJ-Slot':slot,'X-KJ-Slot-Proof':mac(token,slot),...extra},...(data?{body:data}:{})}));
  assert.equal((await req('/obj/d/'+slot+'/state','PUT',Buffer.alloc(29),{'X-KJ-Slot-Proof':'wrong'})).status,403);
  const objects=[['d/'+slot+'/tabs',30*DAY],['d/'+slot+'/presence',180000],['d/'+slot+'/ev/'+clock+'-aaaaaaaa',7*DAY],['sig/'+slot+'/'+clock+'-aaaaaaaa',120000],['d/'+slot+'/h/20261024',91*DAY]];
  for(const[path,ttl]of objects){const at=clock;await storage.set('g/'+room+'/'+path,Buffer.alloc(30));clock+=ttl+1;assert.equal((await req('/obj/'+path)).status,404);assert.equal(await storage.get('g/'+room+'/'+path),null);clock=at;}
  const full=Buffer.alloc(3145728);for(const c of['B','C','D'])assert.equal((await req('/obj/b/'+c.repeat(22),'PUT',full)).status,200);
  assert.equal((await req('/obj/b/'+'E'.repeat(22),'PUT',full)).status,413);
  assert.equal((await req('/obj/b/'+'B'.repeat(22),'PUT',Buffer.alloc(64))).status,200);
  for(let i=0;i<10;i++)await storage.set('g/'+room+'/d/'+String(i).repeat(22)+'/state',Buffer.alloc(30));
  assert.equal((await req('/obj/d/'+slot+'/state','PUT',Buffer.alloc(30))).status,429);
  assert.equal((await req('/obj/d/'+slot+'/h/19990101','PUT',Buffer.alloc(30))).status,400);
});
test('IP unauthenticated/pow and room write/watch fixed windows with Retry-After',async()=>{
  const make=async()=>{let clock=Date.now();const storage=new MemoryStorage(()=>clock),router=createRouter({storage,secret:'tests',difficulty:0,now:()=>clock,watchMs:0});const room='R'.repeat(32),token='T'.repeat(43),slot='A'.repeat(22);await storage.set('g/'+room+'/meta',Buffer.from(JSON.stringify({tokenHash:hash(token),createdAt:clock})));return{advance:ms=>clock+=ms,req:(path,method='GET',data)=>router(new Request('http://localhost/v2'+path,{method,headers:{'X-KJ-Token':token,'X-KJ-Slot':slot,'X-KJ-Slot-Proof':mac(token,slot)},...(data?{body:data}:{})})),room,slot};};
  let h=await make();for(let i=0;i<30;i++)assert.equal((await h.req('/pow?purpose=group')).status,200);let r=await h.req('/pow?purpose=group');assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');h.advance(60001);assert.equal((await h.req('/pow?purpose=group')).status,200);
  h=await make();for(let i=0;i<240;i++)assert.equal((await h.req('/rooms/'+h.room+'/obj/d/'+h.slot+'/state','PUT',Buffer.alloc(30))).status,200);r=await h.req('/rooms/'+h.room+'/obj/d/'+h.slot+'/state','PUT',Buffer.alloc(30));assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');assert.equal((await r.json()).retryAfter,60);h.advance(60001);assert.equal((await h.req('/rooms/'+h.room+'/obj/d/'+h.slot+'/state','PUT',Buffer.alloc(30))).status,200);
  h=await make();for(let i=0;i<240;i++)assert.equal((await h.req('/rooms/'+h.room+'/watch')).status,200);h.advance(12000);r=await h.req('/rooms/'+h.room+'/watch');assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'48');assert.equal((await r.json()).retryAfter,48);h.advance(48001);assert.equal((await h.req('/rooms/'+h.room+'/watch')).status,200);
  h=await make();for(let i=0;i<300;i++)assert.equal((await h.req('/absent')).status,404);assert.equal((await h.req('/absent')).status,429);assert.equal((await h.req('/health')).status,200);
});
test('inactive room cleanup preserves metadata until children have been removed, <=50 deletes',async()=>{
  const clock=Date.now(),storage=new MemoryStorage(()=>clock),room='O'.repeat(32),router=createRouter({storage,secret:'test',difficulty:0,now:()=>clock});await storage.set('g/'+room+'/meta',Buffer.from(JSON.stringify({tokenHash:hash('t'),createdAt:clock-181*DAY})));for(let i=0;i<80;i++)await storage.set('g/'+room+'/b/'+String(i).padStart(22,'0'),Buffer.alloc(30));
  const p=await(await router(new Request('http://localhost/v2/pow?purpose=group'))).json();const before=storage.counts.delete;await router(new Request('http://localhost/v2/groups',{method:'POST',body:JSON.stringify({room:'N'.repeat(32),tokenHash:hash('n'),pow:{...p,nonce:'AAAAAAAAAAA'}})}));assert.ok(storage.counts.delete-before<=50);assert.ok(await storage.get('g/'+room+'/meta'));assert.equal((await storage.list('g/'+room+'/')).length,31);
});
