import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRouter,hash} from '../lib/router.mjs';
import {MemoryStorage} from '../lib/storage.mjs';
import {publicHost,safeFetch} from '../lib/icon.mjs';
import {publicAddress} from '../lib/public-fetch.mjs';
import {runProtocol} from './protocol-suite.mjs';
test('v3.1 default watch checks every 1s and returns after exactly 25s',async()=>{
  let clock=Date.now();const storage=new MemoryStorage(()=>clock),waits=[];
  const room='W'.repeat(32),token='test';await storage.set('g/'+room+'/meta',Buffer.from(JSON.stringify({tokenHash:hash(token),createdAt:clock})));
  const router=createRouter({storage,secret:'watch-test',now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;}});
  const before=storage.counts.list,result=await router(new Request('http://localhost/v2/rooms/'+room+'/watch?since=e30',{headers:{'X-KJ-Token':token}}));
  assert.equal(result.status,200);assert.equal(waits.length,25);assert.ok(waits.every(ms=>ms===1000));assert.equal(storage.counts.list-before,26);assert.deepEqual((await result.json()).changed,[]);
});
test('Edge protocol: auth, proof, bounds, watch, CORS, pair mailboxes',async()=>{
  let clock=Date.now();const storage=new MemoryStorage(()=>clock);const router=createRouter({storage,secret:'test-secret',difficulty:4,now:()=>clock,watchMs:80,intervalMs:15,sleep:async ms=>{await new Promise(r=>setTimeout(r,ms));clock+=ms;}});
  const result=await runProtocol((path,init)=>router(new Request('http://localhost'+path,init)),{local:true,storage,advance:ms=>clock+=ms});assert.ok(result.checks>=30);
});
test('SSRF rejects literal/private and revalidates redirects',async()=>{
  for(const host of['127.0.0.1','localhost','foo.internal','0x7f000001','[::1]','foo.local'])assert.equal(publicHost(host),false);
  for(const ip of['10.1.1.1','127.0.0.1','::1','::ffff:127.0.0.1','169.254.1.1','192.168.1.2'])assert.equal(publicAddress(ip),false);
  let calls=0;await assert.rejects(safeFetch('https://example.com/',1024,async()=>{calls++;return new Response(null,{status:302,headers:{Location:'http://localhost/'}});}));assert.equal(calls,1);
});
test('expiry, per-instance lockout, PoW expiry and bounded cleanup',async()=>{
  let clock=Date.now();const storage=new MemoryStorage(()=>clock),router=createRouter({storage,secret:'test',difficulty:0,now:()=>clock});const req=(p,o={})=>router(new Request('http://localhost/v2'+p,o));
  for(let i=0;i<5;i++)assert.equal((await req('/pair/'+'x'.repeat(32)+'/host/0')).status,404);
  const lock=await req('/pair/'+'x'.repeat(32)+'/host/0');assert.equal(lock.status,429);assert.equal(lock.headers.get('Retry-After'),'1800');
  clock+=1800001;assert.equal((await req('/pair/'+'x'.repeat(32)+'/host/0')).status,404);
  const p=await(await req('/pow?purpose=group')).json();clock+=120001;
  assert.equal((await req('/groups',{method:'POST',body:JSON.stringify({room:'x'.repeat(32),tokenHash:hash('t'),pow:{...p,nonce:'AAAAAAAAAAA'}})})).status,400);
  for(let i=0;i<80;i++)await storage.set('pow/'+i,Buffer.from(JSON.stringify({expiresAt:0})));
  const fresh=await(await req('/pow?purpose=group')).json();const before=storage.counts.delete;
  await req('/groups',{method:'POST',body:JSON.stringify({room:'y'.repeat(32),tokenHash:hash('t'),pow:{...fresh,nonce:'AAAAAAAAAAA'}})});
  assert.ok(storage.counts.delete-before<=50);
});
