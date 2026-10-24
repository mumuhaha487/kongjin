import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRouter,hash,mac} from '../lib/router.mjs';
import {MemoryStorage} from '../lib/storage.mjs';

async function fixture(){
  let clock=Date.UTC(2026,9,24);const storage=new MemoryStorage(()=>clock),router=createRouter({storage,secret:'rate-tests',now:()=>clock,watchMs:0});
  const groups=['A','B','C'].map(c=>({room:c.repeat(32),token:c.repeat(43),slot:c.repeat(22)}));
  for(const g of groups)await storage.set('g/'+g.room+'/meta',Buffer.from(JSON.stringify({tokenHash:hash(g.token),createdAt:clock-7200000})));
  const request=(g,path='/watch',method='GET',token=g.token,ip='127.0.0.1')=>router(new Request('https://test.example/v2/rooms/'+g.room+path,{method,headers:{'X-Forwarded-For':ip,'X-KJ-Token':token,'X-KJ-Slot':g.slot,'X-KJ-Slot-Proof':mac(g.token,g.slot)},...(['PUT','POST'].includes(method)?{body:Buffer.alloc(30)}:{})}));
  return {storage,router,groups,request,advance:ms=>clock+=ms};
}

test('3 fallback rooms on one IP each admit 150 watches and 50 writes; 600-IP ceiling remains',async()=>{
  const h=await fixture();let admitted=0;
  for(let i=0;i<150;i++)for(const g of h.groups){
    assert.equal((await h.request(g)).status,200);admitted++;
    if(i<50){assert.equal((await h.request(g,'/obj/d/'+g.slot+'/state','PUT')).status,200);admitted++;}
  }
  assert.equal(admitted,600);const before={...h.storage.counts},r=await h.request(h.groups[0],'/list');assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');assert.deepEqual(h.storage.counts,before,'IP rejection precedes any Blob access');
  h.advance(60001);assert.equal((await h.request(h.groups[0])).status,200);
});

test('room watch/write are independent, shared across IPs, and rejects do not touch lease/list/data',async()=>{
  const h=await fixture(),g=h.groups[0];
  for(let i=0;i<240;i++)assert.equal((await h.request(g,'/watch','GET',g.token,'192.0.2.'+(i%2+1))).status,200);
  h.advance(7000);let before={...h.storage.counts},r=await h.request(g);assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'53');assert.equal((await r.json()).retryAfter,53);assert.equal(h.storage.counts.get-before.get,1);assert.equal(h.storage.counts.list,before.list);assert.equal(h.storage.counts.set,before.set);
  for(let i=0;i<239;i++)assert.equal((await h.request(g,'/obj/d/'+g.slot+'/state','PUT')).status,200);
  assert.equal((await h.request(g,'/obj/d/'+g.slot+'/state','DELETE')).status,204);
  before={...h.storage.counts};r=await h.request(g,'/obj/d/'+g.slot+'/state','PUT');assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');assert.equal(h.storage.counts.get-before.get,1);assert.equal(h.storage.counts.list,before.list);assert.equal(h.storage.counts.set,before.set);
  assert.equal((await h.request(h.groups[1],'/watch')).status,200,'different room has separate quota');
});

test('bad tokens cannot spend a room quota or amplify Blob operations; 300/min IP lock stays',async()=>{
  const h=await fixture(),g=h.groups[0],before={...h.storage.counts};
  // A valid but wrong token causes only one fixed meta GET, even on stale leases.
  for(let i=0;i<300;i++)assert.equal((await h.request(g,'/list','GET','wrong-token')).status,401);
  assert.equal(h.storage.counts.get-before.get,300);for(const op of ['set','list','head','delete'])assert.equal(h.storage.counts[op],before[op]);
  h.advance(9000);const blocked={...h.storage.counts},r=await h.request(g,'/watch','GET','wrong-token');assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'51');assert.equal((await r.json()).retryAfter,51);assert.deepEqual(h.storage.counts,blocked);
  assert.equal((await h.request(g,'/watch','GET',g.token,'192.0.2.10')).status,200,'guesses never consume room watch quota');
  h.advance(51001);assert.equal((await h.request(g)).status,200,'original fixed-window IP lock expires');
});

test('concurrent bad-token reservations are bounded before awaiting authentication',async()=>{
  const h=await fixture(),g=h.groups[0],original=h.storage.get.bind(h.storage);let release;const gate=new Promise(r=>release=r);let reads=0;
  h.storage.get=async key=>{reads++;await gate;return original(key);};
  const pending=Array.from({length:310},()=>h.request(g,'/list','GET','guessed-token'));
  await new Promise(r=>setImmediate(r));assert.equal(reads,300,'only 300 metadata reads may start');release();const responses=await Promise.all(pending);assert.equal(responses.filter(r=>r.status===401).length,300);assert.equal(responses.filter(r=>r.status===429).length,10);assert.equal(h.storage.counts.list,0);
});
