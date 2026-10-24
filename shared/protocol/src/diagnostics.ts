export type RequestKind='put'|'get'|'list'|'watch'|'signal';
export type RequestDiagnostic={type:RequestKind;startedAt:number;durationMs:number;status:number;serverTiming:string;pollMode:string;foreground:boolean;peers:Array<{connected:boolean;pc:string;ice:string;dc:string;lastReceivedAgoMs:number}>};
type Context=Pick<RequestDiagnostic,'pollMode'|'foreground'|'peers'>;
export type HttpObservation=Pick<RequestDiagnostic,'type'|'startedAt'|'durationMs'|'status'|'serverTiming'>&{context?:Context};
export type RequestObserver=((observation:HttpObservation)=>void)&{capture?:()=>Context};
export function requestKind(path:string,method='GET'):RequestKind{return path.includes('/sig/')||path.startsWith('/pair')?'signal':path.includes('/watch?')?'watch':path.includes('/list?')?'list':method==='GET'?'get':'put';}
/** Keep only known numeric timings, even when talking to a custom endpoint. */
export function safeServerTiming(value:string|null){return(value??'').split(',').map(s=>s.trim()).filter(s=>/^(total|blob_read|blob_write|blob_list);dur=\d+(?:\.\d+)?$/.test(s)).join(', ');}
