import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { KongjingSync, MemorySecretStore, MemoryQueueStore, deriveGroup, unb64, historyEntryId } from "../../shared/protocol/src/index.ts";
import { network } from "../scripts/network.mjs";

export async function continuityE2E(base: string, proxy?: string, inspect?: (rooms: Map<string, string>, needles: Uint8Array[]) => Promise<unknown>, artifactName?: string) {
  const net = network(proxy), secrets = [0,1,2].map(() => new MemorySecretStore()), queues = [0,1,2].map(() => new MemoryQueueStore());
  const rooms = new Map<string,string>(), checks: string[] = [], current: any[] = [{}, {}, {}];
  const received = [[],[],[]] as any[][], inbox: any[] = [], slots: any[] = [];
  const visits = Array.from({length:500}, (_, i) => ({u:`https://continuity-test.example/visit-${i}`, ti:`私密接力标题-${i}`, at:Date.now() + i}));
  const image = new TextEncoder().encode("\u0089PNG\r\nCONFIDENTIAL-CONTINUITY-IMAGE-" + Date.now());
  const request: typeof fetch = (async (url: any, init: any = {}) => {
    const match = /\/v1\/groups\/([\w-]{32})/.exec(String(url));
    const token = new Headers(init.headers).get("X-KJ-Token");
    if (match && token) rooms.set(match[1], token);
    for(;;){
      const response=await net.fetch(url,init);
      if(response.status!==429)return response;
      const body:any=await response.json(),seconds=Number(response.headers.get('Retry-After')??body.retryAfter);
      if(!Number.isFinite(seconds)||seconds<1)throw new Error('429 without retryAfter');
      summary.rateLimitWaits??=[];summary.rateLimitWaits.push(seconds);
      console.log('Rate limited; waiting '+seconds+' seconds before retrying the same request');
      let remaining=seconds*1000;while(remaining>0){const delay=Math.min(remaining,30000);await new Promise(r=>setTimeout(r,delay));remaining-=delay;}
    }
  }) as typeof fetch;
  const make = (i: number) => {
    const client = new KongjingSync({ relayUrl: base, secrets:secrets[i], queueStore:queues[i],
      loadLocal: async()=>current[i], saveMerged: async(d:any)=>{current[i]=d;}, merge: (a:any,b:any)=>({...a,...b}), fetch:request, WebSocket:net.WebSocket as any });
    client.onJournal((rows)=>received[i].push(...rows));
    if (i===0) client.onIncoming(item=>inbox.push(item));
    return client;
  };
  const devices = [0,1,2].map(make);
  const wait = async (condition:()=>boolean, timeout=30000) => {
    const end=Date.now()+timeout;
    while(!condition()) { if(Date.now()>end) throw new Error('Condition timed out; '+JSON.stringify(devices.map(d=>d.status()))); await new Promise(r=>setTimeout(r,20)); }
  };
  const step = async(name:string, fn:()=>Promise<void>)=>{await fn();checks.push(name);console.log('PASS '+name);};
  const pair = async(i:number,j:number)=>{
    const invite=await devices[i].invite(), peer=new Promise<any>(r=>invite.onPeer(r));
    const join=await devices[j].join(invite.code,'Continuity '+ 'ABC'[j], 'Node');
    const [a,b]=await Promise.all([peer,join.sas]); assert.equal(a.sas,b.sas); assert.equal(b.inviterName,'Continuity '+ 'ABC'[i]);
    await join.confirm();await invite.confirm();await Promise.all([invite.done,join.done]);
    await wait(()=>devices[j].status().connection==='online');
  };
  const summary:any={timestamp:new Date().toISOString(),base,mode:proxy?'proxy':'direct',checks,result:'running',residualRooms:[]};
  try {
    await Promise.all(devices.map(d=>d.init()));
    await step('A/B/C pair using current authenticated inviter names',async()=>{await devices[0].createGroup('Continuity A','Node');await pair(0,1);await pair(1,2);await wait(()=>devices[0].status().devices.length===3);});
    await step('500 visits arrive at B/C in seq order without duplicate records',async()=>{
      for(const v of visits) devices[0].journalAppend('hv',{v:[v]});
      await devices[0].syncNow();
      await wait(()=>received[1].filter(r=>r.t==='hv').length===500 && received[2].filter(r=>r.t==='hv').length===500,60000);
      for(const i of [1,2]) {const records=received[i].filter(r=>r.t==='hv');assert.equal(new Set(records.map(r=>r.id)).size,500);assert.deepEqual(records.map(r=>r.v[0].u),visits.map(v=>v.u));assert.ok(records.every((r,j)=>j===0||r.seq>records[j-1].seq));}
    });
    await step('slot update pushes to A; encrypted background round-trips',async()=>{
      devices[0].onSlots(s=>{slots.splice(0,slots.length,...s);});
      await devices[0].putSlot({windows:[{focused:true,tabs:[]}],last:visits[0]});
      await devices[1].putSlot({windows:[{focused:true,tabs:[{...visits[1],active:true}]}],last:visits[1]});
      await wait(()=>slots.some(s=>s.payload.last?.u===visits[1].u));
      const blob=await devices[0].putBlob(image,'image/png');
      current[0]={settings:{background:{image:{...blob,mime:'image/png',w:1,h:1}}}};
      await devices[0].syncNow();
      assert.deepEqual(await devices[1].getBlob(blob.blobId),image);
    });
    await step('C sends to A; A receives once and publishes ack',async()=>{
      const id=devices[0].status().devices.find(d=>d.self)!.deviceId;
      const message=devices[2].sendTo(id,{k:'url',u:visits[2].u,ti:visits[2].ti});
      await devices[2].syncNow();await wait(()=>inbox.some(r=>r.id===message));
      devices[0].ack(message);await devices[0].syncNow();
      await wait(()=>received[2].some(r=>r.t==='ack'&&r.ref===message));
      assert.equal(inbox.filter(r=>r.id===message).length,1);
    });
    await step('durable cursor avoids replay on restart',async()=>{
      const before=received[1].length,cursor=devices[1].journalCursor();
      devices[1].dispose();devices[1]=make(1);await devices[1].init();
      await wait(()=>devices[1].status().connection==='online');
      assert.equal(received[1].length,before);assert.equal(devices[1].journalCursor(),cursor);
    });
    await step('rotation migrates complete history, own slots and image; C loses access',async()=>{
      const oldGroup=await secrets[0].get<any>('group'),old=await deriveGroup(unb64(oldGroup.gk),oldGroup.epoch);
      const c=devices[2].status().devices.find(d=>d.self)!.deviceId;
      let removed=false;devices[2].on('removed',()=>{removed=true;});
      await devices[0].removeDevice(c);
      await wait(()=>removed&&devices[1].status().epoch===2,60000);
      assert.equal(devices[2].status().paired,false);
      const group=await secrets[0].get<any>('group'),next=await deriveGroup(unb64(group.gk),2);
      assert.equal((await request(base+'/v1/groups/'+next.roomId+'/journal',{headers:{'X-KJ-Token':old.roomToken}})).status,401);
      for(const op of ['journal','slots','blobs/'+current[0].settings.background.image.blobId]) assert.equal((await request(base+'/v1/groups/'+old.roomId+'/'+op,{headers:{'X-KJ-Token':old.roomToken}})).status,410);
      const page=await(await request(base+'/v1/groups/'+next.roomId+'/journal',{headers:{'X-KJ-Token':next.roomToken}})).json();
      const {openJournal}=await import('../../shared/protocol/src/index.ts');
      const merged=new Set<string>();
      for(const row of page.items){const p=await openJournal(next.encKey,next.roomId,row.id,row.env);if(p.t==='hv')for(const v of p.v)merged.add(await historyEntryId(p.dev,v.u,v.at));}
      assert.equal(merged.size,500);
      assert.deepEqual(await devices[1].getBlob(current[0].settings.background.image.blobId),image);
      await wait(()=>slots.some(s=>s.payload.last?.u===visits[1].u));
      summary.newJournalEntries=page.items.length;
    });
    await step('actual stored journal/slot/blob bytes contain no plaintext',async()=>{
      const needles=[new TextEncoder().encode(visits[0].u),new TextEncoder().encode(visits[0].ti),image];
      for(const [room,token]of rooms) for(const op of ['journal','slots']){
        const r=await request(base+'/v1/groups/'+room+'/'+op,{headers:{'X-KJ-Token':token}});
        if(r.ok){const raw=Buffer.from(await r.arrayBuffer());for(const n of needles)assert.equal(raw.includes(Buffer.from(n)),false);}
      }
      if(inspect)summary.storage=await inspect(rooms,needles);
    });
    summary.result='passed';
  } catch(e) {summary.result='failed';summary.error=e instanceof Error?e.message:String(e);throw e;}
  finally {
    for(const d of devices)d.dispose();
    for(const[room,token]of rooms){try{const r=await request(base+'/v1/groups/'+room,{method:'DELETE',headers:{'X-KJ-Token':token}});await r.text();if(![204,404].includes(r.status))summary.residualRooms.push(room);}catch{summary.residualRooms.push(room);}}
    if(base==='https://kongjing.inc.re'&&rooms.size){const {cleanR2}=await import('../scripts/r2.mjs');await cleanR2([...rooms.keys()]);}
    await net.close();
    if(summary.residualRooms.length)summary.result='failed';
    await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
    await writeFile(new URL('../artifacts/continuity-e2e-'+(artifactName??(base.includes('kongjing.inc.re')?'online':base.includes('8791')?'worker':'local'))+'.json',import.meta.url),JSON.stringify(summary,null,2));
    console.log(summary.result+'; checks='+checks.length+'; residualRooms='+summary.residualRooms.length);
    assert.deepEqual(summary.residualRooms,[], 'Test room cleanup failed');
  }
  return summary;
}
if(process.argv[1]?.endsWith('continuity-e2e.ts'))await continuityE2E(process.argv[2]??'http://127.0.0.1:8793',process.argv.includes('--proxy')?process.argv[process.argv.indexOf('--proxy')+1]:undefined);
