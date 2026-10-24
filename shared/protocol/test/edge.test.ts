import {test,expect} from 'vitest';
import {EdgeKongjingSync,MemorySecretStore,MemoryQueueStore,deriveGroup,unb64,deriveSlotId,TransportEdge,PeerMesh,ICE_SERVERS,createSync,CloudflareSync,utf8,encrypt,decrypt,hmac,b64url,identity,sealSnapshot} from '../src/index.ts';
// @ts-ignore Node-only server harness is outside the browser library.
import {createRouter,hash} from '../../../edge/lib/router.mjs';
// @ts-ignore
import {MemoryStorage} from '../../../edge/lib/storage.mjs';
import vectors from './vectors.json';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean,timeout=4000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('Timed out');await delay(10);}}
async function pair(a:EdgeKongjingSync<any>,b:EdgeKongjingSync<any>,name:string,expected:string){const invite=await a.invite();let peer:any;invite.onPeer(p=>{peer=p;});const join=await b.join(invite.code,name,'Chrome');const sas=await join.sas;await until(()=>!!peer);expect(sas.inviterName).toBe(expected);expect(sas.sas).toBe(peer.sas);await Promise.all([invite.confirm(),join.confirm()]);await Promise.all([invite.done,join.done]);}
function harness(directOnly=false){const storage=new MemoryStorage();const router=createRouter({storage,secret:'test',difficulty:0,watchMs:25000,intervalMs:20});let offline=false,blockedGroups=false;const fetcher=(async(input:any,init:any)=>{if(offline)throw new Error('offline');if(blockedGroups&&new URL(String(input)).pathname==='/v2/groups')return Response.json({error:{code:'RATE_LIMITED',message:'RATE_LIMITED'},retryAfter:3600},{status:429,headers:{'Retry-After':'3600'}});return router(new Request(String(input),init));})as typeof fetch;const stores=[0,1,2].map(()=>new MemorySecretStore()),queues=stores.map(()=>new MemoryQueueStore()),data=stores.map(()=>({at:0,value:''}));
  const make=(i:number)=>new EdgeKongjingSync({relayUrl:'https://edge.example',secrets:stores[i],queueStore:queues[i],fetch:fetcher,disablePeer:true,directOnly,legacyMigration:false,loadLocal:async()=>structuredClone(data[i]),saveMerged:async d=>{data[i]=d;},merge:(a,b)=>a.at>=b.at?a:b});
  return{storage,stores,queues,data,make,blockGroups:(value:boolean)=>blockedGroups=value,offline:(value:boolean)=>offline=value};}
test('v3: 3-device mailbox pairing, 500 history records, slots, send/ack, rotation and offline forward',async()=>{
  const h=harness(),clients=[0,1,2].map(h.make);try{
    await clients[0].createGroup('A','Chrome');await pair(clients[0],clients[1],'B','A');await pair(clients[1],clients[2],'C','B');await until(()=>clients[0].status().devices.length===3);
    h.data[0]={at:1,value:'private-title https://private.example/path'};await clients[0].syncNow();await until(()=>h.data[1].at===1&&h.data[2].at===1);
    const records:any[][]=[[],[],[]];clients.forEach((c,i)=>c.onJournal(rows=>records[i].push(...rows)));
    for(let i=0;i<500;i++)clients[0].journalAppend('hv',{u:'https://private.example/'+i,ti:'private-title',at:Date.now()+i});await clients[0].syncNow();await until(()=>records[1].filter(r=>r.t==='hv').length===500&&records[2].filter(r=>r.t==='hv').length===500);
    expect(new Set(records[1].map(r=>r.id)).size).toBe(500);expect(records[1].map(r=>r.seq)).toEqual(Array.from({length:500},(_,i)=>i+1));
    await clients[1].putSlot({tabs:[{u:'https://private.example/tab'}]});await until(()=>h.storage.objects.size>0);await clients[0].syncNow();expect((await clients[0].getSlots()).some(s=>s.payload.tabs)).toBe(true);
    let incoming:any;clients[0].onIncoming(item=>{incoming=item;});const id=clients[2].sendTo(clients[0].status().devices.find(d=>d.self)!.deviceId,{k:'url',u:'https://private.example/send'});await clients[2].syncNow();await until(()=>!!incoming);expect(incoming.id).toBe(id);clients[0].ack(id);await clients[0].syncNow();
    const blob=await clients[0].putBlob(new TextEncoder().encode('private-image-pixels'),'image/png');expect(new TextDecoder().decode((await clients[1].getBlob(blob)).bytes)).toBe('private-image-pixels');
    clients[1].dispose();let removed=false;clients[2].on('removed',()=>removed=true);const removedId=clients[2].status().devices.find(d=>d.self)!.deviceId;await clients[0].removeDevice(removedId);await until(()=>removed);
    clients[1]=h.make(1);await clients[1].init();expect(clients[1].status().epoch).toBe(2);expect(clients[1].status().devices.length).toBe(2);expect(h.data[1].at).toBe(1);expect(new TextDecoder().decode((await clients[1].getBlob(blob)).bytes)).toBe('private-image-pixels');
    for(const o of h.storage.objects.values()){const body=new TextDecoder().decode(o.bytes);expect(body).not.toContain('private.example');expect(body).not.toContain('private-title');expect(body).not.toContain('private-image-pixels');}
  }finally{clients.forEach(c=>c.dispose());}
},90000);
test('v3: direct-only leaves no data objects and offline encrypted queue resumes',async()=>{
  const h=harness(true);let a=h.make(0);try{await a.createGroup('A','Chrome');h.data[0]={at:3,value:'offline-secret'};await a.syncNow();a.journalAppend('hv',{u:'https://private.example'});await a.syncNow();expect([...h.storage.objects.keys()].filter(k=>/\/(state|tabs|presence|h|ev|b)(\/|$)/.test(k))).toEqual([]);
    await a.setDirectOnly(false);await a.syncNow();expect([...h.storage.objects.keys()].some(k=>k.endsWith('/state'))).toBe(true);
    h.offline(true);h.data[0]={at:4,value:'offline-secret-latest'};await expect(a.syncNow()).rejects.toThrow();a.journalAppend('hv',{u:'https://queued.example'});await delay(20);a.dispose();h.offline(false);a=h.make(0);await a.init();await a.syncNow();expect(h.data[0].at).toBe(4);
    for(const value of (h.queues[0] as any).data.values()){const raw=JSON.stringify(value);expect(raw).not.toContain('offline-secret');expect(raw).not.toContain('queued.example');}
  }finally{a.dispose();}
});
test('v3 factory defaults Edge and preserves explicit Cloudflare choice; STUN list exact',()=>{const o={secrets:new MemorySecretStore(),loadLocal:async()=>({}),saveMerged:async()=>{},merge:(a:any)=>a};const edge=createSync(o),old=createSync({...o,transport:'cloudflare'});expect(edge).toBeInstanceOf(EdgeKongjingSync);expect(old).toBeInstanceOf(CloudflareSync);expect(ICE_SERVERS.map(s=>s.urls)).toEqual(['stun:stun.miwifi.com:3478','stun:stun.chat.bilibili.com:3478','stun:stun.qq.com:3478','stun:stun.cloudflare.com:3478','stun:stun.l.google.com:19302']);edge.dispose();old.dispose();});
test('v3 peer frame fragments <=64KB, reorders, authenticates AAD, bounds memory',async()=>{
  const keys=await deriveGroup(new Uint8Array(32),1),a='A'.repeat(22),b='B'.repeat(22),frames:string[]=[],received:Uint8Array[]=[];
  const pc=()=>({close(){},connectionState:'new'})as any;
  const sender=new PeerMesh({...keys,slot:a,signal:async()=>{},receive:async()=>{},rtc:pc}),receiver=new PeerMesh({...keys,slot:b,signal:async()=>{},receive:async(_,bytes)=>{received.push(bytes);},rtc:pc});
  try{const out=(sender as any).create(b),input=(receiver as any).create(a);out.dc={readyState:'open',bufferedAmount:0,send:(s:string)=>frames.push(s)};
    const plain=crypto.getRandomValues(new Uint8Array(65536)),payload=new Uint8Array(150000);payload.set(plain);payload.set(plain,65536);await sender.send(b,payload);expect(frames.length).toBeGreaterThan(2);expect(frames.every(s=>new TextEncoder().encode(s).length<=65536)).toBe(true);
    for(const frame of [...frames].reverse())await(receiver as any).message(a,input,frame);expect(received).toEqual([payload]);
    const bad=JSON.parse(frames[0]);const bytes=unb64(bad.b);bytes[20]^=1;bad.b=b64url(bytes);await(receiver as any).message(a,input,JSON.stringify(bad));for(const frame of frames.slice(1,-1))await(receiver as any).message(a,input,frame);await expect((receiver as any).message(a,input,frames.at(-1))).rejects.toThrow();expect(received.length).toBe(1);
    await expect((receiver as any).message(a,input,JSON.stringify({...bad,total:99999}))).rejects.toThrow();
    const encrypted=await encrypt(keys.encKey,utf8('p2p-only'),utf8('kj/p2p/'+keys.roomId),new Uint8Array(12));await expect(decrypt(keys.encKey,encrypted.iv,encrypted.ct,utf8('kj/env/'+keys.roomId))).rejects.toThrow();
  }finally{sender.dispose();receiver.dispose();}
});
test('v3 deterministic slot proof and P2P vector',async()=>{const keys=await deriveGroup(unb64(vectors.group.gk),1),p=vectors.edge.p2p;expect(await hmac(utf8(keys.roomToken),vectors.edge.slot)).toBe(vectors.edge.slotProof);const e=await encrypt(keys.encKey,utf8(p.plain),utf8(p.aad),unb64(p.iv));expect(b64url(e.ct)).toBe(p.ct);expect(new TextDecoder().decode(await decrypt(keys.encKey,e.iv,e.ct,utf8(p.aad)))).toBe(p.plain);});

test('upgrades large persisted map cursors locally and keeps watch URLs bounded',async()=>{
  const storage=new MemoryStorage(),router=createRouter({storage,secret:'cursor',watchMs:0}),room='C'.repeat(32),slot='S'.repeat(22),token='cursor-token',urls:string[]=[];
  await storage.set('g/'+room+'/meta',utf8(JSON.stringify({tokenHash:hash(token),createdAt:Date.now()})));
  for(let device=0;device<3;device++)for(let day=0;day<80;day++){const stamp=new Date(Date.now()-day*86400000).toISOString().slice(0,10).replaceAll('-','');await storage.set('g/'+room+'/d/'+String(device).repeat(22)+'/h/'+stamp,new Uint8Array(29));}
  const fetcher=(async(url:any,init:any)=>{urls.push(String(url));return router(new Request(url,init));})as typeof fetch,transport=new TransportEdge(room,token,slot,{url:'https://edge.example',fetch:fetcher});
  const legacy=await(await router(new Request('https://edge.example/v2/rooms/'+room+'/list',{headers:{'X-KJ-Token':token}}))).json();expect(legacy.cursor.length).toBeGreaterThan(32768);
  const unchanged=await transport.watch(legacy.cursor);expect(unchanged.changed).toEqual([]);expect(unchanged.cursor).toMatch(/^h1\.[a-f0-9]{64}$/);
  await storage.delete('g/'+room+'/'+legacy.objects[0].key);const removed=await transport.watch(unchanged.cursor);expect(removed.reset).toBe(true);expect(removed.tags?.[legacy.objects[0].key]).toBeUndefined();expect(Object.keys(removed.tags!)).toHaveLength(239);expect(urls.every(url=>url.length<200)).toBe(true);
});

test('hashed watch reconciliation skips unchanged objects and removes deleted remote tabs',async()=>{
  const h=harness(),a=h.make(0),b=h.make(1);try{
    await a.createGroup('A','Chrome');await pair(a,b,'B','A');(a as any).poller.dispose();(b as any).poller.dispose();await a.putSlot({tabs:[{u:'https://example.com/tab'}]});await b.syncNow();
    const internal=b as any,path='d/'+(a as any).slot+'/tabs';expect((await b.getSlots()).some(s=>s.dev===(a as any).ident.deviceId)).toBe(true);
    const reads:string[]=[],get=internal.transport.get.bind(internal.transport);internal.transport.get=async(key:string,signal:AbortSignal)=>{reads.push(key);return get(key,signal);};
    await a.deleteSlot();await internal.watchOnce(internal.generation,new AbortController().signal);
    expect(reads).toEqual([path]);expect(internal.cache.has(path)).toBe(false);expect((await b.getSlots()).some(s=>s.dev===(a as any).ident.deviceId)).toBe(false);expect(internal.cursor).toMatch(/^h1\.[a-f0-9]{64}$/);
  }finally{a.dispose();b.dispose();}
},12000);
test('v3 migration keeps derived room, dual writes, stops when all members appear; deadline stops old HTTP',async()=>{
  const storage=new MemoryStorage(),router=createRouter({storage,secret:'migration',difficulty:0,watchMs:25000,intervalMs:20}),ids=await Promise.all([identity(),identity()]),gk=b64url(new Uint8Array(32)),keys=await deriveGroup(unb64(gk),1),members=ids.map((id,i)=>({deviceId:id.deviceId,pub:id.pub,name:'Device '+i,platform:'Chrome',joinedAt:1,addedBy:ids[0].deviceId}));
  const stores=[new MemorySecretStore(),new MemorySecretStore()];for(let i=0;i<2;i++){await stores[i].set('identity',ids[i]);await stores[i].set('group',{gk,epoch:1,members,rev:0,name:'Device '+i,platform:'Chrome'});await stores[i].set('relayUrl','https://kongjing.inc.re');}
  let oldPuts=0,oldCalls=0,rev=1,raw=await sealSnapshot(keys.encKey,keys.roomId,{v:1,writer:ids[0].deviceId,at:1,group:{epoch:1,members},data:{at:0,value:'old'}});
  class Socket extends EventTarget{readyState=1;send(){}close(){this.readyState=3;}}
  const fetcher=(async(input:any,init:any={})=>{const u=new URL(input);if(u.pathname.startsWith('/v2/'))return router(new Request(input,init));oldCalls++;if(u.pathname.endsWith('/snapshot')){if(init.method==='PUT'){oldPuts++;raw=new Uint8Array(init.body);return Response.json({rev:++rev});}return new Response(raw.slice().buffer,{headers:{ETag:'"'+rev+'"'}});}if(u.pathname.endsWith('/slots'))return Response.json({slots:[]});if(u.pathname.endsWith('/journal'))return Response.json({items:[],head:0,floor:0});return new Response(null,{status:204});})as typeof fetch;
  let local={at:0,value:'old'};const a=new EdgeKongjingSync({secrets:stores[0],queueStore:new MemoryQueueStore(),fetch:fetcher,WebSocket:Socket as any,disablePeer:true,loadLocal:async()=>local,saveMerged:async d=>{local=d;},merge:(a,b)=>a.at>=b.at?a:b});
  const b=new EdgeKongjingSync({secrets:stores[1],queueStore:new MemoryQueueStore(),fetch:fetcher,legacyMigration:false,disablePeer:true,loadLocal:async()=>local,saveMerged:async()=>{},merge:(a,b)=>a.at>=b.at?a:b});
  try{await a.init();expect((a as any).keys.roomId).toBe(keys.roomId);expect((a as any).legacy).toBeDefined();local={at:2,value:'new'};await a.syncNow();expect(oldPuts).toBeGreaterThan(0);await b.init();await until(()=>!(a as any).legacy,23000);expect((await stores[0].get<any>('edge.migration')).done).toBe(true);const before=oldPuts;local={at:3,value:'latest'};await a.syncNow();expect(oldPuts).toBe(before);}
  finally{a.dispose();b.dispose();}
  await stores[0].set('edge.migration',{origin:'https://sync.example.com',started:Date.now()-8*86400000,done:false});const expired=new EdgeKongjingSync({secrets:stores[0],queueStore:new MemoryQueueStore(),fetch:fetcher,WebSocket:Socket as any,disablePeer:true,loadLocal:async()=>local,saveMerged:async()=>{},merge:a=>a});try{const before=oldCalls;await expired.init();expect((expired as any).legacy).toBeUndefined();expect(oldCalls).toBe(before);}finally{expired.dispose();}
},30000);
test('v3 leave event elects a remaining member and rotates after five seconds',async()=>{const h=harness(),a=h.make(0),b=h.make(1);try{await a.createGroup('A','Chrome');await pair(a,b,'B','A');await b.leave();expect(b.status().paired).toBe(false);await until(()=>a.status().epoch===2,12000);expect(a.status().devices.length).toBe(1);}finally{a.dispose();b.dispose();}},15000);
test('v3 retries a rejected asynchronous application delivery before committing the watch cursor',async()=>{
  const h=harness(),a=h.make(0),b=h.make(1);let attempts=0,release!:()=>void;const held=new Promise<void>(resolve=>release=resolve),applied=new Set<string>();
  try{
    await a.createGroup('A','Chrome');await pair(a,b,'B','A');
    b.onJournal(async records=>{attempts++;if(attempts===1){await held;throw new Error('application transaction rolled back');}for(const row of records)applied.add(row.id);});
    const id=a.journalAppend('hv',{u:'https://private.example/retry',ti:'private-title'});await a.syncNow();await until(()=>attempts===1);
    expect(applied.size).toBe(0);release();await until(()=>applied.has(id),6000);expect(attempts).toBeGreaterThanOrEqual(2);
    await b.syncNow();expect(applied.size).toBe(1);
  }finally{release?.();a.dispose();b.dispose();}
},12000);

test('v3 rejected rotation room creation leaves the old paired group operational',async()=>{
  const h=harness(),a=h.make(0),b=h.make(1);try{await a.createGroup('A','Chrome');await pair(a,b,'B','A');const prior=await h.stores[0].get<any>('group');h.blockGroups(true);await expect(a.removeDevice(b.status().devices.find(d=>d.self)!.deviceId)).rejects.toMatchObject({code:'RATE_LIMITED'});expect(await h.stores[0].get('group')).toEqual(prior);expect(a.status().epoch).toBe(1);expect(b.status().paired).toBe(true);h.data[0]={at:5,value:'old-room-still-works'};await a.syncNow();await until(()=>h.data[1].value==='old-room-still-works');}finally{a.dispose();b.dispose();}
},12000);

test('v3.1 pairing discovery, direct disconnect and Android foreground integration',async()=>{
  const h=harness(),a=h.make(0),b=h.make(1);
  try{
    await a.createGroup('A','Android');expect((a as any).poller.current().mode).toBe('solo');
    await pair(a,b,'B','A');await until(()=>a.status().devices.some(d=>!d.self&&d.online));
    expect((a as any).poller.current().mode).toBe('relay');
    const remote=[...(a as any).memberSlots].find(([,id]:any)=>id!==a.status().devices.find(d=>d.self)!.deviceId)[0];
    const mesh={connectedSlots:()=>[remote],dispose(){}};(a as any).mesh=mesh;(a as any).update();
    expect((a as any).poller.current().mode).toBe('direct');
    mesh.connectedSlots=()=>[];(a as any).update();expect((a as any).poller.current().watch).toBe(true);
    a.setForeground(false);expect((a as any).poller.current().mode).toBe('suspended');
    a.setForeground(true);expect((a as any).poller.current().watch).toBe(true);
    (a as any).mesh=undefined;
  }finally{a.dispose();b.dispose();}
},12000);

test('v3.1 visibility cancellation stops queued object reads as well as watch',async()=>{
  const h=harness(),a=h.make(0),controller=new AbortController();
  try{await a.createGroup('A','Android');let calls=0;(a as any).transport.get=async(_path:string,signal:AbortSignal)=>{expect(signal).toBe(controller.signal);calls++;controller.abort();return null;};
    const objects=Array.from({length:12},(_,i)=>({key:'d/'+'Z'.repeat(22)+'/ev/'+Date.now()+'-'+String(i).padStart(8,'0'),etag:'test',size:29}));
    (a as any).cursor='before';(a as any).transport.list=async()=>({objects,cursor:'unread'});
    await(a as any).pullAll(controller.signal);expect(calls).toBe(1);expect((a as any).cursor).toBe('before');
  }finally{a.dispose();}
});

async function discoveryHarness(){
  const h=harness(),a=h.make(0);await a.createGroup('A','Chrome');const internal=a as any,remotes=await Promise.all([identity(),identity()]);
  const ids=await Promise.all(remotes.map(async(id,i)=>{const slot=await deriveSlotId(unb64(internal.group.gk),1,id.deviceId);internal.group.members.push({deviceId:id.deviceId,pub:id.pub,name:'Remote '+i,platform:'Chrome',joinedAt:1,addedBy:internal.ident.deviceId});internal.memberSlots.set(slot,id.deviceId);return{id,slot};}));
  let connected=[ids[0].slot];internal.presenceSeen.set(ids[0].id.deviceId,Date.now());
  // Model PeerMesh's status callback as well as its connectedSlots snapshot.
  internal.mesh={connectedSlots:()=>connected,ensure(){},dispose(){},discover:async(slot:string)=>{connected=[...new Set([...connected,slot])];internal.update();},acceptSignal:async()=>{connected=ids.map(v=>v.slot);internal.update();}};internal.update();
  return{h,a,internal,ids};
}
test('v3.2 direct discovery uses one list, skips connected presence/history, preserves cursor until 5-minute repair',async()=>{
  const {h,a,internal,ids}=await discoveryHarness();
  try{const path='d/'+ids[0].slot+'/state',presence='d/'+ids[0].slot+'/presence',bytes=await sealSnapshot(internal.keys.encKey,internal.keys.roomId,{v:1,writer:ids[0].id.deviceId,at:1,group:{epoch:1,members:internal.group.members},data:{at:7,value:'repair'}});let lists=0;const reads:string[]=[];
    internal.transport.list=async()=>{lists++;return{objects:[{key:path,etag:'new-state'},{key:presence,etag:'new-presence'}],cursor:'full-cursor'};};internal.transport.get=async(p:string)=>{reads.push(p);return p===path?bytes:await internal.seal(p,{dev:ids[0].id.deviceId,at:Date.now()});};internal.cursor='old-cursor';
    await internal.checkRoom(new AbortController().signal);expect(lists).toBe(1);expect(reads).toEqual([]);expect(internal.cursor).toBe('old-cursor');expect(h.data[0].at).toBe(0);
    internal.lastFullPullAt-=300000;await internal.checkRoom(new AbortController().signal);expect(lists).toBe(2);expect(new Set(reads)).toEqual(new Set([path,presence]));expect(internal.cursor).toBe('full-cursor');expect(h.data[0].at).toBe(7);
  }finally{a.dispose();}
});
test.each([['presence',false],['offer',false],['presence',true]] as const)('v3.2 %s discovery connects and repairs from one list (full repair due=%s)',async(trigger,full)=>{
  const {h,a,internal,ids}=await discoveryHarness();
  try{const newcomer=ids[1],state='d/'+newcomer.slot+'/state',signal='sig/'+internal.slot+'/123-test',presence='d/'+newcomer.slot+'/presence';let lists=0;const reads:string[]=[];
    const bytes=await sealSnapshot(internal.keys.encKey,internal.keys.roomId,{v:1,writer:newcomer.id.deviceId,at:1,group:{epoch:1,members:internal.group.members},data:{at:8,value:'new device'}});
    internal.transport.list=async()=>{lists++;return{objects:[{key:state,etag:'new-state'},{key:trigger==='presence'?presence:signal,etag:'new-trigger'}],cursor:'new-cursor'};};internal.transport.delete=async()=>{};
    internal.transport.get=async(p:string)=>{reads.push(p);return p===state?bytes:await internal.seal(p,trigger==='presence'?{dev:newcomer.id.deviceId,at:Date.now()}:{from:newcomer.slot,signal:{description:{type:'offer',sdp:'test'}}});};
    if(full)internal.lastFullPullAt-=300000;await internal.checkRoom(new AbortController().signal);expect(lists).toBe(1);expect(reads.filter(p=>p===signal)).toHaveLength(trigger==='offer'?1:0);expect(h.data[0].at).toBe(8);expect(internal.cursor).toBe('new-cursor');expect(internal.poller.current().mode).toBe('direct');expect(a.status().devices.filter(d=>!d.self).every(d=>d.transport==='direct')).toBe(true);
  }finally{a.dispose();}
});
test('v3.2 returning presence re-sends only the lower-slot outstanding offer; live peers stay intact',async()=>{
  const keys=await deriveGroup(new Uint8Array(32),1),signals:any[]=[],a='A'.repeat(22),b='B'.repeat(22);
  const rtc=()=>({close(){},connectionState:'new',signalingState:'new'})as any;
  const mesh=new PeerMesh({...keys,slot:b,signal:async(to,s)=>{signals.push({to,s});},receive:async()=>{},rtc});
  try{const low=(mesh as any).create(a),high=(mesh as any).create('Z'.repeat(22));const description={type:'offer',sdp:'gathered-candidates',toJSON(){return{type:this.type,sdp:this.sdp};}};low.pc.signalingState=high.pc.signalingState='have-local-offer';low.pc.localDescription=high.pc.localDescription=description;
    await mesh.discover(a);expect(signals).toHaveLength(0);await mesh.discover('Z'.repeat(22));expect(signals).toHaveLength(1);high.pc.connectionState='connecting';await mesh.discover('Z'.repeat(22));expect(signals).toHaveLength(1);high.dc={readyState:'open'};high.pc.connectionState='connected';await mesh.discover('Z'.repeat(22));expect(signals).toHaveLength(1);
  }finally{mesh.dispose();}
});
test('v3.2 background presence starts only a bounded handshake, hidden Android always suspends it',async()=>{
  const {a,internal,ids}=await discoveryHarness();
  try{a.setForeground(false);internal.mesh.discover=async()=>{};const path='d/'+ids[1].slot+'/presence';internal.transport.list=async()=>({objects:[{key:path,etag:'new'}],cursor:'presence-cursor'});internal.transport.get=async()=>await internal.seal(path,{dev:ids[1].id.deviceId,at:Date.now()});
    await internal.checkRoom(new AbortController().signal);expect(internal.poller.current().watch).toBe(true);expect(internal.negotiationUntil-Date.now()).toBeGreaterThan(9000);expect(internal.negotiationUntil-Date.now()).toBeLessThanOrEqual(10000);
    internal.negotiationUntil=Date.now()-1;internal.refreshPolling();expect(internal.poller.current().checkMs).toBe(60000);expect(internal.poller.current().watch).toBe(false);
    internal.negotiationUntil=Date.now()+10000;internal.opts.clientPlatform='android';internal.refreshPolling();expect(internal.poller.current().mode).toBe('suspended');
  }finally{a.dispose();}
});
