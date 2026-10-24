import {it,expect,vi} from 'vitest';
import {KongjingSync,MemorySecretStore,identity,deriveGroup,b64url,sealSnapshot,openSnapshot} from '../src/index.ts';

it('a concurrent WS pull cannot advance If-Match for an older pending snapshot',async()=>{
 const secrets=new MemorySecretStore(),self=await identity(),gk=new Uint8Array(32),keys=await deriveGroup(gk,1);
 const member={deviceId:self.deviceId,pub:self.pub,name:'A',platform:'test',joinedAt:1,addedBy:self.deviceId};
 await secrets.set('identity',self);await secrets.set('group',{gk:b64url(gk),epoch:1,members:[member],rev:0,name:'A',platform:'test'});
 let socket:FakeSocket,rev=1,local={at:1,value:'old'},loads=0;
 const attempts:number[]=[];
 class FakeSocket extends EventTarget {readyState=1;constructor(){super();socket=this;}send(){}close(){this.readyState=3;} }
 const client=new KongjingSync({relayUrl:'https://relay.example',secrets,
  loadLocal:async()=>{loads++;const captured=structuredClone(local);if(loads===3){rev=2;socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'snapshot',rev:2})}));await new Promise(r=>setTimeout(r,30));}return captured;},
  saveMerged:async data=>{local=data;},merge:(a,b)=>a.at>=b.at?a:b,WebSocket:FakeSocket as any,
  fetch:(async(_url:any,init:any={})=>{if(init.method==='PUT'){const match=Number(new Headers(init.headers).get('If-Match')!.replaceAll('"',''));attempts.push(match);if(match!==rev)return new Response(JSON.stringify({rev}),{status:412});const body=await openSnapshot<{at:number;value:string}>(keys.encKey,keys.roomId,new Uint8Array(init.body));expect(body.data.value).toBe('remote-new');return new Response(JSON.stringify({rev:++rev}));}const plain={v:1 as const,writer:self.deviceId,at:rev,group:{epoch:1,members:[member]},data:{at:rev,value:rev>=2?'remote-new':'old'}};return new Response((await sealSnapshot(keys.encKey,keys.roomId,plain)).slice().buffer as ArrayBuffer,{headers:{ETag:'"'+rev+'"'}});}) as typeof fetch,
 });
 try{await client.init();await client.syncNow();expect(attempts).toEqual([1,2]);expect(local.value).toBe('remote-new');}finally{client.dispose();}
});

it('a lost committed Cloudflare snapshot response recovers without another encrypted revision',async()=>{
 const secrets=new MemorySecretStore(),self=await identity(),gk=new Uint8Array(32),keys=await deriveGroup(gk,1),member={deviceId:self.deviceId,pub:self.pub,name:'A',platform:'test',joinedAt:1,addedBy:self.deviceId};
 await secrets.set('identity',self);await secrets.set('group',{gk:b64url(gk),epoch:1,members:[member],rev:0,name:'A',platform:'test'});
 let rev=1,writes=0;let stored=await sealSnapshot(keys.encKey,keys.roomId,{v:1,writer:self.deviceId,at:1,group:{epoch:1,members:[member]},data:{at:1,value:'old'}});const bodies:Uint8Array[]=[];
 class Socket extends EventTarget{readyState=1;send(){}close(){this.readyState=3;}}
 const client=new KongjingSync({relayUrl:'https://relay.example',secrets,loadLocal:async()=>({at:2,value:'new'}),saveMerged:async()=>{},merge:a=>a,WebSocket:Socket as any,
  fetch:(async(url:any,init:any={})=>{if(!String(url).endsWith('/snapshot'))return new Response(null,{status:204});if(init.method==='PUT'){bodies.push(new Uint8Array(init.body).slice());if(new Headers(init.headers).get('If-Match')!=='"'+rev+'"')return Response.json({rev},{status:412});stored=new Uint8Array(init.body).slice();writes++;rev++;throw new TypeError('connection reset after commit');}return new Response(stored.slice().buffer as ArrayBuffer,{headers:{ETag:'"'+rev+'"'}});})as typeof fetch});
 const random=vi.spyOn(Math,'random').mockReturnValue(0);try{await client.init();await client.syncNow();expect(writes).toBe(1);expect(bodies).toHaveLength(2);expect(bodies[0]).toEqual(bodies[1]);expect((await secrets.get<any>('group')).rev).toBe(2);}finally{random.mockRestore();client.dispose();}
});

it('refreshes an expired PoW challenge without weakening difficulty or bypassing creation',async()=>{
 let challenges=0,creates=0;
 class FakeSocket extends EventTarget {readyState=1;send(){}close(){this.readyState=3;} }
 const client=new KongjingSync({relayUrl:'https://relay.example',secrets:new MemorySecretStore(),
  loadLocal:async()=>({value:1}),saveMerged:async()=>{},merge:(a)=>a,WebSocket:FakeSocket as any,
  fetch:(async(url:any,init:any={})=>{
   if(String(url).includes('/pow?')){challenges++;return new Response(JSON.stringify({challenge:b64url(new Uint8Array(16)),difficulty:0,expiresAt:Date.now()+(challenges===1?-1:120000),purpose:'group',sig:'test'}));}
   if(init.method==='POST'){creates++;const body=JSON.parse(init.body);expect(body.pow.expiresAt).toBeGreaterThan(Date.now());return new Response(JSON.stringify({room:body.room,createdAt:Date.now()}),{status:201});}
   if(init.method==='PUT')return new Response(JSON.stringify({rev:1}));
   return new Response(null,{status:204});
  }) as typeof fetch,
 });
 try{await client.createGroup('A','test');expect(challenges).toBe(2);expect(creates).toBe(1);expect(client.status().paired).toBe(true);}finally{client.dispose();}
});

it('only polls the fallback snapshot when the WebSocket is disconnected',async()=>{
 const {vi}=await import('vitest');vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 class Socket extends EventTarget{readyState=1;send(){}close(){this.readyState=3;}}
 const secrets=new MemorySecretStore(),self=await identity();await secrets.set('identity',self);
 await secrets.set('group',{gk:b64url(new Uint8Array(32)),epoch:1,members:[{deviceId:self.deviceId,pub:self.pub,name:'A',platform:'test',joinedAt:1,addedBy:self.deviceId}],rev:0,name:'A',platform:'test'});
 let reads=0;const c=new KongjingSync({relayUrl:'https://relay.example',secrets,loadLocal:async()=>({}),saveMerged:async()=>{},merge:a=>a,WebSocket:Socket as any,fetch:(async()=>{reads++;return new Response(null,{status:204});})as any});
 try{await c.init();const initial=reads;await vi.advanceTimersByTimeAsync(300000);expect(reads).toBe(initial);(c as any).ws.readyState=3;await vi.advanceTimersByTimeAsync(300000);expect(reads).toBeGreaterThan(initial);}finally{c.dispose();vi.useRealTimers();}
});
