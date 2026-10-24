import {ProtocolError} from './types.ts';

/** Equal jitter keeps even an immediately failing/offline request from spinning. */
export function retryDelay(failures:number, minimumMs=0, baseMs=500, capMs=60000) {
  const ceiling=Math.min(capMs,baseMs*2**Math.min(Math.max(0,failures-1),16));
  return Math.max(minimumMs,ceiling*(0.5+Math.random()*0.5));
}

export function retryAfter(response:Response, body:any) {
  const header=response.headers.get('Retry-After');
  const seconds=header===null?NaN:Number(header),date=header===null?NaN:Date.parse(header);
  const values=[Number(body?.retryAfter??NaN),Number.isFinite(seconds)?seconds:Number.isFinite(date)?(date-Date.now())/1000:NaN].filter(n=>Number.isFinite(n)&&n>=0);
  return values.length?Math.max(...values):undefined;
}

function pause(ms:number,signal?:AbortSignal|null) {
  return new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new ProtocolError('CANCELLED'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  });
}

type RetryOptions={
  timeoutMs?:number;budgetMs?:number;maxAttempts?:number;acceptedStatuses?:number[];
  observe?:(sample:{startedAt:number;durationMs:number;status:number;headers?:Headers})=>void;
};

/** Retries only reproducible reads and idempotent writes. The deadline covers
 * fetch AND consuming the response body, even when a caller supplies a signal.
 * POST/create/pair and stream bodies are always attempted once. */
export async function requestWithRetry(fetcher:typeof fetch,url:string,init:RequestInit={},options:RetryOptions={}) {
  const method=(init.method??'GET').toUpperCase(),signal=init.signal;
  let body=init.body;
  // Freeze bytes before the first send; never rerun encryption to retry a write.
  if(body instanceof ArrayBuffer)body=body.slice(0);
  else if(ArrayBuffer.isView(body))body=new Uint8Array(body.buffer,body.byteOffset,body.byteLength).slice().buffer;
  else if(body instanceof URLSearchParams)body=body.toString();
  const reusable=body==null||typeof body==='string'||body instanceof ArrayBuffer||typeof Blob!=='undefined'&&body instanceof Blob;
  const attempts=['GET','HEAD','PUT','DELETE'].includes(method)&&reusable?Math.max(1,Math.min(options.maxAttempts??3,3)):1;
  const deadline=Date.now()+(options.budgetMs??30000),timeout=options.timeoutMs??10000;
  let last:ProtocolError=new ProtocolError('NETWORK','Network request failed',undefined,0);
  for(let attempt=0;attempt<attempts;attempt++){
    if(signal?.aborted)throw new ProtocolError('CANCELLED');
    if(typeof navigator!=='undefined'&&navigator.onLine===false)throw last;
    const remaining=deadline-Date.now();if(remaining<=0)throw last;
    const controller=new AbortController(),cancel=()=>controller.abort(),startedAt=Date.now(),start=performance.now();
    const timer=setTimeout(cancel,Math.min(timeout,remaining));
    signal?.addEventListener('abort',cancel,{once:true});
    let status=0,headers:Headers|undefined,response:Response|undefined;
    let rejectAbort!:()=>void;
    const aborted=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(new ProtocolError(signal?.aborted?'CANCELLED':'NETWORK','Network request aborted',undefined,0));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
    try{
      response=await Promise.race([aborted,(async()=>{
        const raw=await fetcher.call(globalThis,url,{credentials:'omit',...init,body,signal:controller.signal});
        status=raw.status;headers=raw.headers;
        const bytes=await raw.arrayBuffer();
        return new Response([204,205,304].includes(raw.status)?null:bytes,{status:raw.status,statusText:raw.statusText,headers:raw.headers});
      })()]);
    }catch(error){
      if(signal?.aborted)throw new ProtocolError('CANCELLED');
      last=error instanceof ProtocolError?error:new ProtocolError('NETWORK','Network request failed',undefined,0);
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',rejectAbort);
      options.observe?.({startedAt,durationMs:Math.round((performance.now()-start)*100)/100,status,headers});
    }
    if(response){
      if(response.ok||options.acceptedStatuses?.includes(response.status))return response;
      let payload:any;try{payload=await response.json();}catch{}
      last=new ProtocolError(payload?.error?.code??'NETWORK',payload?.error?.message??`HTTP ${response.status}`,retryAfter(response,payload),response.status);
      if(![408,425,429].includes(response.status)&&!(response.status>=500&&response.status<=599))throw last;
    }
    if(attempt+1>=attempts)throw last;
    const delay=retryDelay(attempt+1,(last.retryAfter??0)*1000);
    // Never sleep past the total budget or retry sooner than Retry-After.
    if(delay>=deadline-Date.now())throw last;
    await pause(delay,signal);
  }
  throw last;
}
