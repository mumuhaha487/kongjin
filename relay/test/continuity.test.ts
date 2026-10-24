import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { GroupRoom } from "../src/rooms.mjs";
import { Guard, guard } from "../src/guard.mjs";
import { hash } from "../src/common.mjs";

const DAY = 86400000, envBody = { v: 1, iv: "A".repeat(16), ct: "B".repeat(22) };
const id = (n: number) => Buffer.alloc(16, n).toString("base64url");
function fixture(sql = false) {
  let clock = 1700000000000;
  const values = new Map<string, any>(), files = new Map<string, Uint8Array>(), sockets: any[] = [];
  const db = sql ? new DatabaseSync(":memory:") : undefined;
  const storage: any = {
    get: async(k:string)=>structuredClone(values.get(k)), put:async(k:string,v:any)=>{values.set(k,structuredClone(v));},
    delete:async(k:string)=>{values.delete(k);}, list:async({prefix=""}={})=>new Map([...values].filter(([k])=>k.startsWith(prefix))),
    setAlarm:async(t:number)=>{values.set("alarm",t);}, deleteAll:async()=>{values.clear();db?.exec("DELETE FROM kj_journal; DELETE FROM kj_slots; DELETE FROM kj_blobs; DELETE FROM kj_channel_state;");},
  };
  if(db) {
    storage.sql = {exec(query:string,...bindings:any[]){
      if(!bindings.length&&query.trim().split(';').filter(Boolean).length>1){db.exec(query);return{toArray:()=>[]};}
      const statement=db.prepare(query),rows=statement.columns().length?statement.all(...bindings):(statement.run(...bindings),[]);
      return {toArray:()=>rows};
    }};
    storage.transactionSync=(fn:()=>any)=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
  }
  const env:any={TESTING:"true",testClock:()=>clock,testConfig:{},BUCKET:{
    async put(k:string,v:any){files.set(k,typeof v==='string'?new TextEncoder().encode(v):new Uint8Array(v));},
    async get(k:string){const b=files.get(k);return b?{body:b,json:async()=>JSON.parse(new TextDecoder().decode(b)),arrayBuffer:async()=>b.buffer}:null;},
    async delete(keys:string|string[]){for(const k of Array.isArray(keys)?keys:[keys])files.delete(k);},
  }};
  const guardValues = new Map<string,any>();
  const guardObject=new Guard({storage:{...storage,sql:undefined,get:async(k:string)=>structuredClone(guardValues.get(k)),put:async(k:string,v:any)=>{guardValues.set(k,structuredClone(v));}}},env);
  env.GUARDS={idFromName:(id:string)=>id,get:()=>({fetch:(r:Request)=>guardObject.fetch(r)})};
  const ctx:any={storage,getWebSockets:()=>sockets};
  let room = new GroupRoom(ctx, env);
  const call=(path:string,method='GET',body?:any,token='test-token'):Promise<Response>=>room.fetch(new Request('https://internal/'+path,{method,headers:{'X-KJ-Token':token,'X-KJ-IP-Hash':'1234'},...(body!==undefined?{body:body instanceof Uint8Array?body.slice().buffer as ArrayBuffer:typeof body==='string'?body:JSON.stringify(body)}:{})})) as unknown as Promise<Response>;
  return {env,values,files,db,sockets,call,set:(t:number)=>{clock=t;},get time(){return clock;},alarm:()=>room.alarm(),restart:()=>{room=new GroupRoom(ctx,env);},
    create:async()=>call('create','POST',{room:'A'.repeat(32),tokenHash:await hash('test-token')}),dispose:()=>db?.close()};
}
for(const sql of [false,true]) {
  const backend=sql?'SQLite':'file-adapter';
  it(`${backend}: lazy additive tables preserve existing rooms; journal is ordered, paginated and idempotent`,async()=>{
    const f=fixture(sql);try{
      await f.create();
      const items=Array.from({length:10},(_,i)=>({id:id(i),env:envBody}));
      let r=await f.call('journal','POST',{items});expect(r.status).toBe(200);expect(await r.json()).toEqual({seqs:[1,2,3,4,5,6,7,8,9,10],head:10});
      r=await f.call('journal','POST',{items:[{...items[2],env:{...envBody,ct:'C'.repeat(22)}}]});expect(await r.json()).toEqual({seqs:[3],head:10});
      f.restart();
      const page=await(await f.call('journal?after=3&limit=2')).json();expect(page).toMatchObject({head:10,floor:1});expect(page.items.map((r:any)=>r.seq)).toEqual([4,5]);
      expect((await(await f.call('journal?after=0&limit=500')).json()).items[2].env).toEqual(envBody);
      for(const q of ['after=-1','after=1.2','limit=0','limit=501','after=9007199254740992'])expect((await f.call('journal?'+q)).status).toBe(400);
      expect((await f.call('journal','GET',undefined,'wrong')).status).toBe(401);
      expect((await f.call('journal','POST',{items:[{id:'bad',env:envBody}]})).status).toBe(400);
      expect((await f.call('journal','POST',{items:Array.from({length:101},()=>items[0])})).status).toBe(400);
      const raw=JSON.stringify({items:[items[0]]});expect((await f.call('journal','POST',raw+' '.repeat(262144-Buffer.byteLength(raw)))).status).toBe(200);
      expect((await f.call('journal','POST',' '.repeat(262145))).status).toBe(413);
    }finally{f.dispose();}
  });
  it(`${backend}: count/byte capacity eviction, gaps and 90-day alarm retain monotonic head`,async()=>{
    const f=fixture(sql);try{
      await f.create();f.env.testConfig.journalCount=3;
      await f.call('journal','POST',{items:Array.from({length:5},(_,i)=>({id:id(i),env:envBody}))});
      let p=await(await f.call('journal')).json();expect(p).toMatchObject({head:5,floor:3,gap:true});expect(p.items.map((r:any)=>r.seq)).toEqual([3,4,5]);
      f.env.testConfig.journalBytes=Buffer.byteLength(JSON.stringify(envBody));
      await f.call('journal','POST',{items:[{id:id(10),env:envBody}]});p=await(await f.call('journal')).json();expect(p.floor).toBe(6);expect(p.items).toHaveLength(1);
      f.set(f.time+90*DAY);await f.alarm();p=await(await f.call('journal')).json();expect(p).toMatchObject({items:[],head:6,floor:7,gap:true});
      await f.call('journal','POST',{items:[{id:id(11),env:envBody}]});expect((await(await f.call('journal?after=6')).json()).head).toBe(7);
    }finally{f.dispose();}
  });
  it(`${backend}: slot overwrite, 12-slot cap, 64KiB limit, delete and 30-day expiry`,async()=>{
    const f=fixture(sql);try{
      await f.create();const raw=new Uint8Array(65536);raw[0]=1;
      for(let i=0;i<12;i++)expect((await f.call('slots/'+id(i),'PUT',raw)).status).toBe(200);
      expect((await f.call('slots/'+id(12),'PUT',raw)).status).toBe(429);
      expect((await f.call('slots/'+id(0),'PUT',raw)).status).toBe(200);
      expect((await f.call('slots/'+id(0),'PUT',new Uint8Array(65537))).status).toBe(413);
      expect((await(await f.call('slots')).json()).slots).toHaveLength(12);
      expect((await f.call('slots/'+id(0),'DELETE')).status).toBe(204);
      f.set(f.time+30*DAY);await f.alarm();expect((await(await f.call('slots')).json()).slots).toEqual([]);
    }finally{f.dispose();}
  });
  it(`${backend}: blob limits and quota include replacements, cascading retirement clears all channels`,async()=>{
    const f=fixture(sql);try{
      await f.create();const raw=new Uint8Array(3*1024*1024);raw[0]=1;
      for(let i=0;i<3;i++)expect((await f.call('blobs/'+id(i),'PUT',raw)).status).toBe(200);
      expect((await f.call('blobs/'+id(3),'PUT',raw)).status).toBe(413);
      expect((await f.call('blobs/'+id(0),'PUT',raw)).status).toBe(200);
      expect((await f.call('blobs/'+id(4),'PUT',new Uint8Array(3*1024*1024+1))).status).toBe(413);
      expect(Buffer.from(await(await f.call('blobs/'+id(0))).arrayBuffer()).equals(raw)).toBe(true);
      expect((await f.call('blobs/'+id(0),'DELETE')).status).toBe(204);
      expect((await f.call('blobs/'+id(0))).status).toBe(404);
      await f.call('journal','POST',{items:[{id:id(0),env:envBody}]});const slot=new Uint8Array(29);slot[0]=1;await f.call('slots/'+id(0),'PUT',slot);
      await f.call('forward','POST',{env:envBody});expect((await f.call('delete','DELETE')).status).toBe(204);
      expect([...f.files.keys()]).toEqual(['g/'+'A'.repeat(32)+'/forward']);
      for(const op of ['journal','slots','blobs/'+id(0)])expect((await f.call(op)).status).toBe(410);
      if(f.db)for(const table of ['kj_journal','kj_slots','kj_blobs'])expect((f.db.prepare('SELECT count(*) AS n FROM '+table).get() as any).n).toBe(0);
      else expect(f.values.get('continuity')).toMatchObject({journal:[],slots:{},blobs:{}});
      expect((await f.call('forward')).status).toBe(200);
    }finally{f.dispose();}
  });
}
it('new exact production quotas: journal 60 write/120 read, slot 30, blob 10 and IP 600/hour',async()=>{
  for(const [path,method,limit,body]of [
    ['journal','POST',60,{items:[{id:id(1),env:envBody}]}],['journal','GET',120,undefined],
    ['slots','GET',30,undefined],['blobs/'+id(1),'PUT',10,new Uint8Array([1,...new Uint8Array(28)])],
  ]as const){const f=fixture();try{await f.create();for(let i=0;i<limit;i++)expect((await f.call(path,method,body)).status).toBe(200);const r=await f.call(path,method,body);expect(r.status).toBe(429);expect(r.headers.get('Retry-After')).toBe('60');f.set(f.time+60000);expect((await f.call(path,method,body)).status).toBe(200);}finally{f.dispose();}}
  const f=fixture();try{for(let i=0;i<600;i++)await guard(f.env,'1234','rate',{op:'journal'});await expect(guard(f.env,'1234','rate',{op:'journal'})).rejects.toMatchObject({status:429,retryAfter:3600});f.set(f.time+3600000);await expect(guard(f.env,'1234','rate',{op:'journal'})).resolves.toMatchObject({ok:true});}finally{f.dispose();}
});

it('SQLite statistics migrate the legacy head without changing stored ciphertext or original meta',async()=>{
 const f=fixture(true);try{
  await f.create();await f.call('journal','POST',{items:[{id:id(21),env:envBody}]});
  f.db!.exec("DROP TABLE kj_channel_stats; UPDATE kj_channel_state SET value=10 WHERE key='head';");f.restart();
  let page=await(await f.call('journal')).json();expect(page.head).toBe(10);expect(page.items[0].env).toEqual(envBody);
  const r=await(await f.call('journal','POST',{items:[{id:id(22),env:envBody}]})).json();expect(r.seqs).toEqual([11]);
 }finally{f.dispose();}
});
