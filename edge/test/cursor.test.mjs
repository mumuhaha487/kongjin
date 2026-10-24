import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRouter,hash} from '../lib/router.mjs';
import {MemoryStorage} from '../lib/storage.mjs';

async function fixture(){
  let clock=Date.UTC(2026,9,24);const storage=new MemoryStorage(()=>clock),room='C'.repeat(32),token='cursor-test';
  await storage.set('g/'+room+'/meta',Buffer.from(JSON.stringify({tokenHash:hash(token),createdAt:clock})));
  for(let device=0;device<3;device++)for(let day=0;day<80;day++){
    const stamp=new Date(clock-day*86400000).toISOString().slice(0,10).replaceAll('-','');
    await storage.set('g/'+room+'/d/'+String(device).repeat(22)+'/h/'+stamp,Buffer.alloc(29,day));
  }
  const router=createRouter({storage,secret:'cursor',now:()=>clock,sleep:async ms=>{clock+=ms;}});
  const request=suffix=>router(new Request('http://localhost/v2/rooms/'+room+suffix,{headers:{'X-KJ-Token':token}}));
  return {storage,request,room};
}

test('240 retained daily objects use a constant-size negotiated list/watch cursor',async()=>{
  const {storage,request,room}=await fixture();
  const legacy=await(await request('/list')).json();assert.equal(legacy.objects.length,240);assert.ok(legacy.cursor.length>32768);
  const list=await(await request('/list?cursor=hash')).json();assert.match(list.cursor,/^h1\.[a-f0-9]{64}$/);
  const url='/watch?cursor=hash&since='+list.cursor;assert.ok(url.length<128);
  const before=storage.counts.list,unchanged=await request(url);assert.equal(unchanged.status,200);
  assert.deepEqual(await unchanged.json(),{changed:[],cursor:list.cursor});assert.equal(storage.counts.list-before,26);
  const removed=list.objects[0].key,updated=list.objects[1].key;await storage.delete('g/'+room+'/'+removed);await storage.set('g/'+room+'/'+updated,Buffer.alloc(30,42));
  const changed=await(await request(url)).json();assert.equal(changed.reset,true);assert.equal(changed.tags[removed],undefined);assert.notEqual(changed.tags[updated],list.objects[1].etag);
  assert.equal(changed.changed.length,239);assert.equal(changed.cursor.length,list.cursor.length);
  assert.equal((await(await request('/list?cursor=hash')).json()).cursor,changed.cursor);
});

test('hash cursors are order independent and report deletion of the last object',async()=>{
  const {storage,request,room}=await fixture(),initial=await(await request('/list?cursor=hash')).json();
  const list=storage.list.bind(storage);storage.list=async prefix=>(await list(prefix)).reverse();
  assert.equal((await(await request('/watch?cursor=hash&since='+initial.cursor)).json()).cursor,initial.cursor);
  for(const o of initial.objects)await storage.delete('g/'+room+'/'+o.key);
  const deleted=await(await request('/watch?cursor=hash&since='+initial.cursor)).json();
  assert.equal(deleted.reset,true);assert.deepEqual(deleted.tags,{});assert.deepEqual(deleted.changed,[]);assert.notEqual(deleted.cursor,initial.cursor);
});

test('legacy clients keep etag-map responses and oversized/malformed watches fail before listing',async()=>{
  const {storage,request,room}=await fixture();for(const o of(await storage.list('g/'+room+'/')).filter(o=>!o.key.endsWith('/meta')).slice(1))await storage.delete(o.key);
  const list=await(await request('/list')).json(),tags=JSON.parse(Buffer.from(list.cursor,'base64url').toString());assert.equal(Object.keys(tags).length,1);
  await storage.delete('g/'+room+'/'+list.objects[0].key);
  const watch=await(await request('/watch?since='+list.cursor)).json();assert.deepEqual(watch.changed,[list.objects[0].key]);assert.deepEqual(JSON.parse(Buffer.from(watch.cursor,'base64url').toString()),{});
  const before={...storage.counts};for(const suffix of ['/watch?cursor=hash&since=bad','/watch?cursor=hash&since='+'x'.repeat(40000),'/watch?since='+'x'.repeat(40000)])assert.equal((await request(suffix)).status,400);
  assert.equal(storage.counts.list,before.list);assert.equal(storage.counts.set,before.set);
});
