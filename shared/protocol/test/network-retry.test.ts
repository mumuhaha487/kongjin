import {test,expect,vi,afterEach} from 'vitest';
import {requestWithRetry} from '../src/network-retry.ts';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
const setup=()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));vi.spyOn(Math,'random').mockReturnValue(0);};

test('retries dropped connections and transient HTTP failures with exponential jitter and Retry-After',async()=>{
  setup();const starts:number[]=[];const fetcher=vi.fn(async()=>{starts.push(Date.now());if(starts.length===1)throw new TypeError('connection reset');if(starts.length===2)return Response.json({error:{code:'SERVER_ERROR'},retryAfter:1},{status:503,headers:{'Retry-After':'2'}});return Response.json({ok:true});});
  const result=requestWithRetry(fetcher as typeof fetch,'https://test.example/list');await vi.advanceTimersByTimeAsync(2249);expect(fetcher).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(1);expect(await(await result).json()).toEqual({ok:true});expect(starts.map(n=>n-starts[0])).toEqual([0,250,2250]);expect(vi.getTimerCount()).toBe(0);
});

test('idempotent PUT retries reuse frozen ciphertext after a lost response',async()=>{
  setup();const ciphertext=new Uint8Array([1,2,3]),bodies:number[][]=[];const fetcher=vi.fn(async(_url:any,init:any)=>{bodies.push([...new Uint8Array(init.body)]);if(bodies.length===1){ciphertext.fill(9);throw new TypeError('response lost after commit');}return new Response(null,{status:204});});
  const result=requestWithRetry(fetcher as typeof fetch,'https://test.example/object',{method:'PUT',body:ciphertext.buffer});await vi.advanceTimersByTimeAsync(250);expect((await result).status).toBe(204);expect(bodies).toEqual([[1,2,3],[1,2,3]]);
});

test.each([429,503])('POST creation and pairing are not replayed on HTTP %s',async status=>{
  setup();const fetcher=vi.fn(async()=>Response.json({error:{code:'SERVER_ERROR'},retryAfter:1},{status}));
  await expect(requestWithRetry(fetcher as typeof fetch,'https://test.example/pair',{method:'POST',body:'{}'})).rejects.toMatchObject({status});expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});

test.each([401,403,400,409,413])('permanent HTTP %s errors are returned once',async status=>{
  setup();const fetcher=vi.fn(async()=>new Response(null,{status}));await expect(requestWithRetry(fetcher as typeof fetch,'https://test.example/obj')).rejects.toMatchObject({status});expect(fetcher).toHaveBeenCalledTimes(1);
});

test('attempt count and total timeout bound a fetch that ignores caller cancellation',async()=>{
  setup();const external=new AbortController(),signals:AbortSignal[]=[];const fetcher=vi.fn(async(_url:any,init:any)=>{signals.push(init.signal);return new Promise<Response>(()=>{});});
  const result=expect(requestWithRetry(fetcher as typeof fetch,'https://test.example/read',{signal:external.signal},{timeoutMs:1000,budgetMs:3000})).rejects.toMatchObject({code:'NETWORK',status:0});
  await vi.advanceTimersByTimeAsync(3000);await result;expect(fetcher).toHaveBeenCalledTimes(3);expect(signals.every(s=>s.aborted)).toBe(true);expect(external.signal.aborted).toBe(false);expect(vi.getTimerCount()).toBe(0);
});

test('the timeout also covers a hanging response body with an external signal',async()=>{
  setup();const external=new AbortController();const fetcher=vi.fn(async()=>new Response(new ReadableStream({start(){}})));
  const result=expect(requestWithRetry(fetcher as typeof fetch,'https://test.example/body',{signal:external.signal},{timeoutMs:50,budgetMs:60})).rejects.toMatchObject({code:'NETWORK'});await vi.advanceTimersByTimeAsync(50);await result;expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});

test('an HTTP-date Retry-After beyond the budget fails promptly without an early retry',async()=>{
  setup();const fetcher=vi.fn(async()=>new Response(null,{status:503,headers:{'Retry-After':new Date(Date.now()+60000).toUTCString()}}));
  await expect(requestWithRetry(fetcher as typeof fetch,'https://test.example/list')).rejects.toMatchObject({status:503,retryAfter:60});expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});

test('abort interrupts an in-flight request and a retry wait without further requests',async()=>{
  setup();for(const hanging of [true,false]){const controller=new AbortController(),fetcher=vi.fn(async()=>{if(hanging)return new Promise<Response>(()=>{});throw new TypeError('offline');});
    const result=expect(requestWithRetry(fetcher as typeof fetch,'https://test.example/list',{signal:controller.signal})).rejects.toMatchObject({code:'CANCELLED'});await vi.advanceTimersByTimeAsync(1);controller.abort();await result;await vi.advanceTimersByTimeAsync(10000);expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  }
});

test('known offline state performs no network requests and pre-aborted callers stay cancelled',async()=>{
  setup();vi.stubGlobal('navigator',{onLine:false});const fetcher=vi.fn(),controller=new AbortController();await expect(requestWithRetry(fetcher,'https://test.example/list')).rejects.toMatchObject({code:'NETWORK'});controller.abort();await expect(requestWithRetry(fetcher,'https://test.example/list',{signal:controller.signal})).rejects.toMatchObject({code:'CANCELLED'});expect(fetcher).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
