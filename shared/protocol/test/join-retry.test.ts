import {test,expect,vi} from 'vitest';
import {joinRetrier,JOIN_RETRY_MS} from '../src/join-retry.ts';
import {ProtocolError,EdgeHttp,EdgeKongjingSync,MemorySecretStore,MemoryQueueStore} from '../src/index.ts';
// @ts-ignore Node-only server harness is outside the browser library.
import {createRouter} from '../../../edge/lib/router.mjs';
// @ts-ignore Node-only server harness is outside the browser library.
import {MemoryStorage} from '../../../edge/lib/storage.mjs';

test('join transient failures use backoff for the full two minutes before rejecting',async()=>{
  vi.useFakeTimers();
  try{
    let calls=0,settled=false;const retry=joinRetrier();
    // Slow credential adoption before the first failure must not consume its retry window.
    await vi.advanceTimersByTimeAsync(90000);
    const done=retry(async()=>{calls++;throw new ProtocolError('SERVER_ERROR','temporary',undefined,500);});
    void done.catch(()=>{settled=true;});const rejected=expect(done).rejects.toMatchObject({status:500});
    await vi.advanceTimersByTimeAsync(JOIN_RETRY_MS-1);expect(settled).toBe(false);expect(calls).toBeGreaterThan(5);
    await vi.advanceTimersByTimeAsync(1);await rejected;expect(settled).toBe(true);expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
});
test.each([500,0,429])('join retries HTTP/network status %s and honors Retry-After beyond two minutes',async status=>{
  vi.useFakeTimers();
  try{let calls=0;const done=joinRetrier()(async()=>{if(++calls===1)throw new ProtocolError('NETWORK','temporary',180,status);return 'ok';});
    await vi.advanceTimersByTimeAsync(179999);expect(calls).toBe(1);await vi.advanceTimersByTimeAsync(1);await expect(done).resolves.toBe('ok');expect(calls).toBe(2);
  }finally{vi.useRealTimers();}
});
test('cancel aborts join backoff; auth, crypto and storage failures are never retried',async()=>{
  vi.useFakeTimers();
  try{const controller=new AbortController();let calls=0;const done=joinRetrier(controller.signal)(async()=>{calls++;throw new ProtocolError('NETWORK','offline',undefined,0);});
    const rejected=expect(done).rejects.toMatchObject({code:'CANCELLED'});await vi.advanceTimersByTimeAsync(0);controller.abort();await rejected;expect(calls).toBe(1);expect(vi.getTimerCount()).toBe(0);
    for(const error of [new ProtocolError('UNAUTHORIZED','invalid',undefined,401),new ProtocolError('BAD_CODE'),new Error('persistence failed')]){
      let attempts=0;await expect(joinRetrier()(async()=>{attempts++;throw error;})).rejects.toBe(error);expect(attempts).toBe(1);
    }
  }finally{vi.useRealTimers();}
});
test('Edge HTTP preserves status and HTTP-date Retry-After, and classifies fetch failures',async()=>{
  const when=Math.ceil(Date.now()/1000)*1000+60000;
  const http=new EdgeHttp('https://edge.example',(async()=>Response.json({error:{code:'SERVER_ERROR'}},{status:503,headers:{'Retry-After':new Date(when).toUTCString()}}))as typeof fetch);
  let caught:any;try{await http.request('/rooms/test');}catch(e){caught=e;}expect(caught.status).toBe(503);expect(caught.retryAfter).toBeGreaterThan(59);expect(caught.retryAfter).toBeLessThanOrEqual(61);
  await expect(new EdgeHttp('https://edge.example',(async()=>{throw new TypeError('fetch failed');})as typeof fetch).request('/health')).rejects.toMatchObject({code:'NETWORK',status:0});
  await expect(new EdgeHttp('https://edge.example',(async()=>Response.json({retryAfter:1},{status:503,headers:{'Retry-After':'60'}}))as typeof fetch).request('/health')).rejects.toMatchObject({status:503,retryAfter:60});
});

function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
async function fixture(fault:'state'|'presence'|'network'|'auth'){
  const storage=new MemoryStorage(),router=createRouter({storage,secret:'join-test',difficulty:0,watchMs:25000,intervalMs:1000});
  const stores=[new MemorySecretStore(),new MemorySecretStore()],data=[{value:1},{value:0}],failed=gate(),blocked=gate(),release=gate();
  let attempts=0,healthy=false,welcome=false;
  const make=(i:number)=>new EdgeKongjingSync({relayUrl:'https://edge.example',secrets:stores[i],queueStore:new MemoryQueueStore(),disablePeer:true,legacyMigration:false,
    loadLocal:async()=>structuredClone(data[i]),saveMerged:async d=>{data[i]=d;},merge:(a,b)=>a.value>=b.value?a:b,
    fetch:(async(input:any,init:any={})=>{
      const u=new URL(String(input));
      if(i===0&&init.method==='PUT'&&u.pathname.includes('/pair/')&&JSON.parse(init.body).t==='welcome')welcome=true;
      const suffix=fault==='presence'?'/presence':'/state';
      if(i===1&&welcome&&init.method==='PUT'&&u.pathname.includes('/obj/d/')&&u.pathname.endsWith(suffix)&&!healthy){
        attempts++;
        if(attempts===1){failed.resolve();if(fault==='network')throw new TypeError('offline');return Response.json({error:{code:fault==='auth'?'UNAUTHORIZED':'SERVER_ERROR'}},{status:fault==='auth'?401:500});}
        blocked.resolve();await release.promise;
      }
      return router(new Request(String(input),init));
    })as typeof fetch});
  let a=make(0),b=make(1);await a.createGroup('真实邀请方','Chrome');
  const invite=await a.invite(),join=await b.join(invite.code,'真实加入方','Chrome');await join.sas;
  await Promise.all([invite.confirm(),join.confirm()]);await invite.done;
  return{a,b,invite,join,stores,failed,blocked,release,attempts:()=>attempts,healthy:()=>{healthy=true;release.resolve();},
    async restartHost(){a.dispose();a=make(0);await a.init();return a;},
    async restartGuest(){b.dispose();b=make(1);await b.init();return b;},
    dispose(){release.resolve();a.dispose();b.dispose();}};
}
for(const fault of ['state','presence','network']as const)test('welcome followed by first '+fault+' failure eventually joins without another code',async()=>{
  const f=await fixture(fault);
  try{
    await f.failed.promise;expect(f.b.status()).toMatchObject({paired:false,joinPhase:'completing'});
    await f.blocked.promise;
    if(fault!=='presence'){
      expect(f.a.status().devices.find(d=>!d.self)).toMatchObject({joining:true,online:false});
      const restarted=await f.restartHost();expect(restarted.status().devices.find(d=>!d.self)).toMatchObject({joining:true,online:false});
    }
    f.healthy();await f.join.done;expect(f.attempts()).toBe(2);expect(f.b.status()).toMatchObject({paired:true,connection:'online'});expect(f.b.status().joinPhase).toBeUndefined();
    const host=await f.restartHost();await host.syncNow();expect(host.status().devices.find(d=>!d.self)).toMatchObject({joining:false,online:true});
    expect((await f.stores[0].get<any>('group')).members).toEqual((await f.stores[1].get<any>('group')).members);
    expect(await f.stores[1].get('edge.joinPending')).toBeUndefined();
  }finally{f.dispose();}
},15000);
test.each([false,true])('a final join failure is explicit, retains credentials, and can resume without re-pairing; restart=%s',async restart=>{
  const f=await fixture('auth');
  try{
    await expect(f.join.done).rejects.toMatchObject({code:'UNAUTHORIZED'});expect(f.b.status()).toMatchObject({paired:false,joinPhase:'failed',error:'UNAUTHORIZED'});
    const previous=await f.stores[1].get<any>('group');expect(previous).toBeDefined();expect(await f.stores[1].get('edge.joinPending')).toBe(true);
    f.healthy();let joined=f.b;if(restart)joined=await f.restartGuest();else await f.join.retry!();expect(joined.status()).toMatchObject({paired:true,connection:'online'});expect(joined.status().joinPhase).toBeUndefined();expect((await f.stores[1].get<any>('group')).gk).toBe(previous.gk);
  }finally{f.dispose();}
},15000);
