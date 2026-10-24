import {test,expect,vi,afterEach} from 'vitest';
import {EdgeKongjingSync,KongjingSync,MemorySecretStore,identity,deriveGroup,deriveSlotId,sealSnapshot,b64url,PeerMesh,EdgeHttp} from '../src/index.ts';
afterEach(()=>vi.useRealTimers());
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
test.each(['edge','cloudflare'] as const)('v3.3 %s merge shares app lock, or fallback queue, with delayed local writes',async transport=>{
 for(const appLock of [true,false]){
  const self=await identity(),keys=await deriveGroup(new Uint8Array(32),1),member={deviceId:self.deviceId,pub:self.pub,name:'A',platform:'test',joinedAt:1,addedBy:self.deviceId},group={gk:b64url(new Uint8Array(32)),epoch:1,members:[member],rev:0,name:'A',platform:'test'};
  let local={items:['old']},chain:Promise<unknown>=Promise.resolve(),inside=false,loads=0,locks=0;
  const lock=<T>(task:()=>Promise<T>)=>{const p=chain.then(async()=>{inside=true;locks++;try{return await task();}finally{inside=false;}});chain=p.catch(()=>{});return p;};
  const options={relayUrl:'https://test.example',secrets:new MemorySecretStore(),withLocalLock:appLock?lock:undefined,loadLocal:async()=>{if(appLock)expect(inside).toBe(true);loads++;return structuredClone(local);},saveMerged:async(v:typeof local)=>{if(appLock)expect(inside).toBe(true);await Promise.resolve();local=v;},merge:(a:typeof local,b:typeof local)=>({items:[...new Set([...a.items,...b.items])]})};
  const c:any=transport==='edge'?new EdgeKongjingSync({...options,legacyMigration:false}):new KongjingSync(options);c.ident=self;c.group=group;c.keys=keys;
  const envelope=await sealSnapshot(keys.encKey,keys.roomId,{v:1,writer:self.deviceId,at:1,group:{epoch:1,members:[member]},data:{items:['remote']}});
  if(transport==='cloudflare'){c.request=async()=>new Response(envelope.slice().buffer,{headers:{ETag:'"1"'}});c.continuity={catchUp:async()=>{},dispose(){}};}
  const entered=deferred(),release=deferred();
  try{const localWrite=(appLock?lock:(task:()=>Promise<void>)=>c.runExclusive(task))(async()=>{const value=structuredClone(local);entered.resolve();await release.promise;local={items:[...value.items,'local']};});await entered.promise;
   const remote=transport==='edge'?c.consume('d/'+await deriveSlotId(new Uint8Array(32),1,self.deviceId)+'/state',envelope):c.pull();await new Promise(r=>setTimeout(r,15));expect(loads).toBe(0);release.resolve();await Promise.all([localWrite,remote]);expect(local.items).toEqual(['old','local','remote']);if(appLock)expect(locks).toBe(2);
  }finally{release.resolve();c.dispose();}
 }
});
async function peerHarness(){const keys=await deriveGroup(new Uint8Array(32),1),a='A'.repeat(22),b='B'.repeat(22),events:boolean[]=[],frames:string[]=[];
 const rtc=()=>({connectionState:'connected',iceConnectionState:'connected',close(){this.connectionState='closed';}})as any;
 const sender=new PeerMesh({...keys,slot:a,rtc,signal:async()=>{},receive:async()=>{}}),mesh=new PeerMesh({...keys,slot:b,rtc,signal:async()=>{},receive:async()=>{},status:(_,live)=>events.push(live)});
 const out=(sender as any).create(b),p=(mesh as any).create(a);out.dc={readyState:'open',bufferedAmount:0,send:(s:string)=>frames.push(s)};p.dc={readyState:'open',bufferedAmount:0,send(){}};await sender.send(b,new Uint8Array());sender.dispose();await(mesh as any).message(a,p,frames[0]);return{mesh,p,events,a,frame:frames[0]};}
test('v3.3 authenticated heartbeat: silent open PC declared down exactly at 5s; ICE failure immediate',async()=>{
 const {mesh,p,events,a}=await peerHarness();vi.useFakeTimers();vi.setSystemTime(p.lastSeen);try{mesh.setForeground(true);await vi.advanceTimersByTimeAsync(4999);expect(mesh.connected(a)).toBe(true);await vi.advanceTimersByTimeAsync(1);expect(mesh.connected(a)).toBe(false);expect(events).toEqual([true,false]);expect(p.pc.connectionState).toBe('connected');}finally{mesh.dispose();}
 const h=await peerHarness();try{h.p.pc.iceConnectionState='disconnected';h.p.pc.oniceconnectionstatechange();expect(h.mesh.connected(h.a)).toBe(false);expect(h.events).toEqual([true,false]);}finally{h.mesh.dispose();}
});
test('v3.3 desktop background 35s deadline, hidden Android sends nothing; resume checks old lastSeen',async()=>{
 const {mesh,p,events,a}=await peerHarness();vi.useFakeTimers();try{mesh.setForeground(false);await vi.advanceTimersByTimeAsync(34999);expect(mesh.connected(a)).toBe(true);await vi.advanceTimersByTimeAsync(1);expect(mesh.connected(a)).toBe(false);}finally{mesh.dispose();}
 const h=await peerHarness();try{let sent=0;h.p.dc.send=()=>sent++;h.mesh.setForeground(false,true);await vi.advanceTimersByTimeAsync(60000);expect(sent).toBe(0);expect(h.events).toEqual([true]);h.mesh.setForeground(true,true);expect(h.mesh.connected(h.a)).toBe(false);expect(h.events).toEqual([true,false]);}finally{h.mesh.dispose();}
});
test('v3.3 invalid authentication cannot revive a peer; new DC must receive an authenticated frame',async()=>{
 const {mesh,p,a,frame}=await peerHarness();try{p.live=false;expect(mesh.connected(a)).toBe(false);const bad=JSON.parse(frame);bad.b=bad.b.slice(0,-4)+'AAAA';await expect((mesh as any).message(a,p,JSON.stringify(bad))).rejects.toThrow();expect(mesh.connected(a)).toBe(false);await(mesh as any).message(a,p,frame);expect(mesh.connected(a)).toBe(true);}finally{mesh.dispose();}
});
test('v3.3 slow application delivery does not block authenticated heartbeat processing',async()=>{
 const h=await peerHarness(),gate=deferred();const keys=await deriveGroup(new Uint8Array(32),1),frames:string[]=[];
 const sender=new PeerMesh({...keys,slot:h.a,rtc:()=>({close(){}})as any,signal:async()=>{},receive:async()=>{}});
 try{const out=(sender as any).create('B'.repeat(22));out.dc={readyState:'open',bufferedAmount:0,send:(s:string)=>frames.push(s)};await sender.send('B'.repeat(22),new TextEncoder().encode('business'));(h.mesh as any).options.receive=()=>gate.promise;
  await(h.mesh as any).message(h.a,h.p,frames[0]);vi.useFakeTimers();vi.setSystemTime(h.p.lastSeen);h.mesh.setForeground(true);await vi.advanceTimersByTimeAsync(4000);await(h.mesh as any).message(h.a,h.p,h.frame);await vi.advanceTimersByTimeAsync(4000);expect(h.mesh.connected(h.a)).toBe(true);gate.resolve();await h.p.deliveries;
 }finally{gate.resolve();sender.dispose();h.mesh.dispose();}
});
test('v3.3 HTTP diagnostics classify/redact failures, retries, bodies and the 100-entry ring',async()=>{
 const c:any=new EdgeKongjingSync({secrets:new MemorySecretStore(),loadLocal:async()=>({}),saveMerged:async()=>{},merge:a=>a});
 const http=new EdgeHttp('https://test.example',async()=>new Response('secret-body',{status:200,headers:{'Server-Timing':'total;dur=5, blob_read;dur=2, private-room;desc="secret"'}}),c.observe);
 try{for(let n=0;n<105;n++)await http.request('/rooms/private-room/obj/sig/private-slot/private-record',{method:'PUT',body:'private-token'});const rows=c.diagnostics();expect(rows).toHaveLength(100);expect(rows[0].type).toBe('signal');expect(rows[0].serverTiming).toBe('total;dur=5, blob_read;dur=2');expect(JSON.stringify(rows)).not.toMatch(/secret|private/);rows[0].status=123;expect(c.diagnostics()[0].status).toBe(200);const fail=new EdgeHttp('https://test.example',async()=>{throw new Error('secret');},c.observe);await expect(fail.request('/list?prefix=')).rejects.toThrow();expect(c.diagnostics().at(-1).status).toBe(0);}finally{c.dispose();}
});
test('v3.3 downloaded state is delivered before a slow unrelated ICE GET completes',async()=>{
 const c:any=new EdgeKongjingSync({secrets:new MemorySecretStore(),loadLocal:async()=>({}),saveMerged:async()=>{},merge:a=>a}),held=deferred(),applied=deferred();
 const own='A'.repeat(22),state='d/'+'B'.repeat(22)+'/state',signal='sig/'+own+'/1234567890123-AAAAAAAA';let finished=false;
 c.slot=own;c.transport={get:async(key:string)=>{if(key===signal){await held.promise;return null;}return new Uint8Array(29);}};c.consume=async(key:string)=>{if(key===state)applied.resolve();};
 try{const read=c.readObjects([{key:signal,etag:'ice',size:29},{key:state,etag:'state',size:29}]).then(()=>{finished=true;});await applied.promise;expect(finished).toBe(false);expect(c.etags.get(signal)).toBeUndefined();held.resolve();await read;expect(c.etags.get(state)).toBe('state');}finally{held.resolve();c.dispose();}
});
