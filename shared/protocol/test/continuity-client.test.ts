import { it, expect, vi } from "vitest";
import { ContinuityClient } from "../src/continuity.ts";
import { deriveGroup, b64url, unb64 } from "../src/crypto.ts";
import { MemoryQueueStore } from "../src/queue-store.ts";
import { sealJournal } from "../src/continuity-crypto.ts";

async function fixture() {
  const gk = new Uint8Array(32), keys = await deriveGroup(gk, 1), context = { ...keys, gk: b64url(gk), epoch: 1, deviceId: "device-A" };
  const rows: any[] = [], batches: any[] = [], store = new MemoryQueueStore();
  let online = true, floor = 1;
  const host = { context: () => context, local: async () => ({}), gap: vi.fn(), fail: vi.fn(),
    request: async(path: string, init: any = {}) => {
      if(!online) throw new Error("offline");
      if(init.method === "POST") {
        const items=JSON.parse(init.body).items;batches.push(items);
        const seqs=items.map((item:any)=>{let row=rows.find(r=>r.id===item.id);if(!row){row={...item,seq:rows.length+1,at:Date.now()};rows.push(row);}return row.seq;});
        return new Response(JSON.stringify({seqs,head:rows.length}));
      }
      if(path.endsWith('/slots'))return new Response('{"slots":[]}');
      const after=Number(new URL('https://relay'+path).searchParams.get('after'));
      return new Response(JSON.stringify({items:rows.filter(r=>r.seq>after&&r.seq>=floor),head:rows.length,floor,...(after<floor-1?{gap:true}:{})}));
    }
  };
  return {host,store,rows,batches,context,setOnline:(v:boolean)=>{online=v;},setFloor:(v:number)=>{floor=v;},make:()=>new ContinuityClient(host,store)};
}
it('persists offline ciphertext outside secrets, resumes queue and cursor without replay',async()=>{
  const f=await fixture();let client=f.make();f.setOnline(false);
  const id=client.append('sh',{q:[{s:'PRIVATE-SEARCH',at:Date.now()}]});
  await expect(client.flush()).rejects.toThrow('offline');client.dispose();
  const state=await f.store.get<any>('continuity/device-A/'+f.context.roomId);
  expect(state.pending[0].id).toBe(id);expect(JSON.stringify(state)).not.toContain('PRIVATE-SEARCH');
  f.setOnline(true);client=f.make();const delivered:any[]=[];client.onJournal(r=>delivered.push(...r));
  await client.catchUp();expect(f.batches).toHaveLength(1);expect(delivered.map(r=>r.id)).toEqual([id]);expect(client.cursor()).toBe(1);client.dispose();
  client=f.make();client.onJournal(r=>delivered.push(...r));await client.catchUp();expect(delivered).toHaveLength(1);expect(client.cursor()).toBe(1);client.dispose();
});
it('persists pending ids before upload; a lost POST response is retried idempotently',async()=>{
  const f=await fixture(),request=f.host.request;let lost=true;
  f.host.request=async(path,init)=>{const r=await request(path,init);if(init?.method==='POST'&&lost){lost=false;throw new Error('response lost');}return r;};
  const client=f.make();client.append('sh',{q:[{s:'search',at:Date.now()}]});
  try{await expect(client.flush()).rejects.toThrow('response lost');await client.flush();expect(f.batches).toHaveLength(2);expect(f.batches[0][0].id).toBe(f.batches[1][0].id);expect(f.rows).toHaveLength(1);}finally{client.dispose();}
});
it('batches at 50 and persists a single gap notification across restart',async()=>{
  const f=await fixture(),client=f.make();
  try {
    for(let i=0;i<101;i++)client.append('sh',{q:[{s:String(i),at:Date.now()}]});
    await client.flush();expect(f.batches.map(b=>b.length)).toEqual([50,50,1]);
  }finally{client.dispose();}
  const gap=await fixture();
  for(let i=1;i<=4;i++)gap.rows.push({seq:i,id:b64url(new Uint8Array(16).fill(i)),at:1,env:await sealJournal(gap.context.encKey,gap.context.roomId,b64url(new Uint8Array(16).fill(i)),{t:'sh',dev:'device-B',at:1,q:[]})});
  gap.setFloor(3);
  let c=gap.make();const notifications:any[]=[];c.onJournal((r,info)=>notifications.push({r,info}));await c.catchUp();
  expect(notifications.filter(n=>n.r.length===0)).toEqual([{r:[],info:{replay:true}}]);expect(c.cursor()).toBe(4);expect(gap.host.gap).toHaveBeenCalledWith(true);c.dispose();
  c=gap.make();c.onJournal((r,info)=>notifications.push({r,info}));await c.catchUp();expect(notifications.filter(n=>n.r.length===0)).toHaveLength(1);c.dispose();
});
it('automatically uploads after ten seconds or immediately at 50 queued records',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const f=await fixture(),c=f.make();
  try {
    c.append('sh',{q:[]});await (c as any).enqueues;
    await vi.advanceTimersByTimeAsync(9999);expect(f.batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);await c.flush();expect(f.batches).toHaveLength(1);
    for(let i=0;i<50;i++)c.append('sh',{q:[]});
    await(c as any).enqueues;await vi.advanceTimersByTimeAsync(0);await c.flush();
    expect(f.batches.map(b=>b.length)).toEqual([1,50]);
  }finally{c.dispose();vi.useRealTimers();}
});
it('persists offline slot overwrite/deletion and retries after a process restart',async()=>{
  const f=await fixture(),request=f.host.request;const operations:string[]=[];
  f.host.request=async(path,init)=>{if(init?.method==='PUT'||init?.method==='DELETE'){operations.push(init.method);return new Response('{}');}return request(path,init);};
  let c=f.make();
  f.host.request=async()=>{throw new Error('offline');};
  await expect(c.putSlot({windows:[]})).rejects.toThrow('offline');c.dispose();
  f.host.request=async(path,init)=>{if(init?.method==='PUT'||init?.method==='DELETE'){operations.push(init.method);return new Response('{}');}return request(path,init);};
  c=f.make();await c.catchUp();expect(operations).toEqual(['PUT']);
  const online=f.host.request;f.host.request=async()=>{throw new Error('offline');};
  // Within the ten-second cooldown the durable deletion is deferred without a request.
  await c.deleteSlot();c.dispose();
  f.host.request=online;c=f.make();await c.catchUp();expect(operations).toEqual(['PUT','DELETE']);c.dispose();
});
it('delivers durable pending incoming messages when the consumer is installed after a restart',async()=>{
  const f=await fixture(),id=b64url(new Uint8Array(16).fill(91));
  f.rows.push({id,seq:1,at:Date.now(),env:await sealJournal(f.context.encKey,f.context.roomId,id,{t:'snd',dev:'device-B',at:Date.now(),to:'device-A',k:'text',tx:'private'})});
  let c=f.make();await c.catchUp();c.dispose();
  c=f.make();const incoming:any[]=[];c.onIncoming(r=>incoming.push(r));await c.catchUp();
  expect(incoming.map(r=>r.id)).toEqual([id]);await c.catchUp();expect(incoming).toHaveLength(1);c.dispose();
});
it('waits for an asynchronous application callback before persisting its cursor',async()=>{
  const f=await fixture(),id=b64url(new Uint8Array(16).fill(90));
  f.rows.push({id,seq:1,at:Date.now(),env:await sealJournal(f.context.encKey,f.context.roomId,id,{t:'sh',dev:'device-B',at:Date.now(),q:[]})});
  const c=f.make();let release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r),commit=new Promise<void>(r=>release=r);
  c.onJournal(async()=>{entered();await commit;});
  try{await started;expect(c.cursor()).toBe(0);release();await c.catchUp();expect(c.cursor()).toBe(1);}finally{c.dispose();}
});

it('replays after application commit/cursor failure; recordId idempotency prevents duplicate effects',async()=>{
  const f=await fixture(),id=b64url(new Uint8Array(16).fill(92));
  f.rows.push({id,seq:1,at:Date.now(),env:await sealJournal(f.context.encKey,f.context.roomId,id,{t:'sh',dev:'device-B',at:Date.now(),q:[]})});
  const set=f.store.set.bind(f.store);let fail=true;
  f.store.set=async(k,v)=>{if(fail&&(v as any).cursor===1){fail=false;throw new Error('crash before cursor commit');}await set(k,v);};
  const applied=new Set<string>();let callbacks=0,effects=0;
  const apply=(rows:any[])=>{callbacks++;for(const r of rows)if(!applied.has(r.id)){applied.add(r.id);effects++;}};
  let c=f.make();(c as any).journalListeners.add(apply);
  await expect(c.catchUp()).rejects.toThrow('crash before cursor commit');expect(c.cursor()).toBe(0);c.dispose();
  c=f.make();(c as any).journalListeners.add(apply);await c.catchUp();
  expect(callbacks).toBe(2);expect(effects).toBe(1);expect(c.cursor()).toBe(1);c.dispose();
});
it('rejects a failed application callback without advancing the cursor',async()=>{
  const f=await fixture(),id=b64url(new Uint8Array(16).fill(93));
  f.rows.push({id,seq:1,at:Date.now(),env:await sealJournal(f.context.encKey,f.context.roomId,id,{t:'sh',dev:'device-B',at:Date.now(),q:[]})});
  const c=f.make();(c as any).journalListeners.add(()=>{throw new Error('application transaction failed');});
  try{await expect(c.catchUp()).rejects.toThrow('application transaction failed');expect(c.cursor()).toBe(0);}finally{c.dispose();}
});
it('keeps server-retained sends opaque but only notifies the client inbox within seven days',async()=>{
  const f=await fixture();
  for(const [i,days]of [[94,8],[95,6]]){const id=b64url(new Uint8Array(16).fill(i));f.rows.push({id,seq:f.rows.length+1,at:Date.now(),env:await sealJournal(f.context.encKey,f.context.roomId,id,{t:'snd',dev:'device-B',at:Date.now()-days*86400000,to:'device-A',k:'text',tx:'private'})});}
  const c=f.make(),incoming:any[]=[];c.onIncoming(r=>incoming.push(r));
  try{await c.catchUp();expect(incoming.map(r=>r.id)).toEqual([f.rows[1].id]);expect(c.cursor()).toBe(2);}finally{c.dispose();}
});
it('suppresses unchanged slots, coalesces changed content for ten seconds, and merges notices for one second',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
  const f=await fixture(),request=f.host.request,writes:any[]=[],c=f.make();
  f.host.request=async(p,i)=>{if(i?.method==='PUT'){writes.push(i.body);return new Response('{}');}return request(p,i);};
  try{
    await c.putSlot({windows:[]});await c.putSlot({windows:[]});expect(writes).toHaveLength(1);
    await c.putSlot({windows:[],last:{u:'new'}});await vi.advanceTimersByTimeAsync(9999);expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);await c.flush();expect(writes).toHaveLength(2);
    const pull=vi.spyOn(c,'pullJournal').mockResolvedValue();c.notify({type:'journal',head:2});c.notify({type:'journal',head:3});
    await vi.advanceTimersByTimeAsync(999);expect(pull).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(pull).toHaveBeenCalledTimes(1);
  }finally{c.dispose();vi.useRealTimers();}
});

it('uses bounded encrypted slot WS hints, authenticates identity, and falls back for legacy notices',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const f=await fixture(),c=f.make(),request=f.host.request;let reads=0;
  f.host.request=async(p,i)=>{if(p.endsWith('/slots'))reads++;return request(p,i);};
  const {deriveSlotId,sealSlot,bytesEnvelope}=await import('../src/continuity-crypto.ts');
  const id=await deriveSlotId(unb64(f.context.gk),1,'device-B');
  const env=bytesEnvelope(await sealSlot(f.context.encKey,f.context.roomId,id,{dev:'device-B',at:Date.now(),windows:[]}));
  const slots:any[]=[];c.onSlots(s=>slots.push(s));await c.catchUp();const before=reads;
  try{
    c.notify({type:'slot',slotId:id,updatedAt:Date.now(),env});await vi.advanceTimersByTimeAsync(1000);await(c as any).noticeTask;
    expect(reads).toBe(before);expect(slots.at(-1)[0].dev).toBe('device-B');
    c.notify({type:'slot',slotId:id,updatedAt:Date.now()});await vi.advanceTimersByTimeAsync(1000);await(c as any).noticeTask;expect(reads).toBe(before+1);
  }finally{c.dispose();vi.useRealTimers();}
});
