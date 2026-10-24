import {ProtocolError, type PowProof} from './types.ts';
import {buf,hmac,utf8,hex,sha256,unb64,text} from './crypto.ts';
import {requestKind,safeServerTiming,type RequestObserver} from './diagnostics.ts';
import {requestWithRetry} from './network-retry.ts';
export const DEFAULT_EDGE_URL='https://sync.example.com';
export type ObjectInfo={key:string;etag:string;size:number;modified?:number};
export type WatchResult={changed:string[];cursor:string;tags?:Record<string,string>;reset?:boolean};
export interface Transport {
  get(path:string,signal?:AbortSignal):Promise<Uint8Array|null>;
  put(path:string,bytes:Uint8Array):Promise<void>;
  delete(path:string):Promise<void>;
  list(prefix?:string,signal?:AbortSignal):Promise<{objects:ObjectInfo[];cursor:string}>;
  watch(cursor:string,signal?:AbortSignal):Promise<WatchResult>;
}
export function edgeOrigin(input:string){
  const u=new URL(input);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||u.protocol==='http:'&&(['localhost','127.0.0.1','[::1]'].includes(u.hostname)||/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname))))throw new ProtocolError('BAD_REQUEST','HTTPS origin required');
  return u.origin;
}
export class EdgeHttp {
  readonly origin:string;
  constructor(origin=DEFAULT_EDGE_URL,readonly fetcher:typeof fetch=globalThis.fetch,private observer?:RequestObserver){this.origin=edgeOrigin(origin);}
  async request(path:string,init:RequestInit={}){
    const context=this.observer?.capture?.(),watch=path.includes('/watch?');
    return requestWithRetry(this.fetcher,this.origin+'/v2'+path,init,{...(watch?{timeoutMs:35000,budgetMs:40000}:{}),observe:sample=>{
      const {headers,...timing}=sample;this.observer?.({...timing,type:requestKind(path,init.method),serverTiming:safeServerTiming(headers?.get('Server-Timing')??null),context});
    }});
  }
  async create(room:string,token:string,pow?:PowProof){return this.request('/groups',{method:'POST',headers:{'X-KJ-Token':token,'Content-Type':'application/json'},body:JSON.stringify({room,tokenHash:hex(await sha256(utf8(token))),pow})});}
}
export class TransportEdge implements Transport {
  private headers?:Promise<Record<string,string>>;
  readonly http:EdgeHttp;
  constructor(readonly roomId:string,readonly roomToken:string,readonly slot:string,{url=DEFAULT_EDGE_URL,fetch:fetcher=globalThis.fetch,observer}:{url?:string;fetch?:typeof fetch;observer?:RequestObserver}={}){
    if(!/^[\w-]{32}$/.test(roomId)||!/^[\w-]{22}$/.test(slot))throw new ProtocolError('BAD_REQUEST');this.http=new EdgeHttp(url,fetcher,observer);
  }
  private auth(){return this.headers??=hmac(utf8(this.roomToken),this.slot).then(proof=>({'X-KJ-Token':this.roomToken,'X-KJ-Slot':this.slot,'X-KJ-Slot-Proof':proof}));}
  private path(path:string){if(path.includes('..')||path.startsWith('/')||path.includes('\\'))throw new ProtocolError('BAD_REQUEST');return '/rooms/'+this.roomId+'/obj/'+path.split('/').map(encodeURIComponent).join('/');}
  async get(path:string,signal?:AbortSignal){try{return new Uint8Array(await(await this.http.request(this.path(path),{headers:await this.auth(),signal})).arrayBuffer());}catch(e){if(e instanceof ProtocolError&&e.code==='NOT_FOUND')return null;throw e;}}
  async put(path:string,bytes:Uint8Array){await this.http.request(this.path(path),{method:'PUT',headers:{...await this.auth(),'Content-Type':'application/octet-stream'},body:buf(bytes)});}
  async delete(path:string){await this.http.request(this.path(path),{method:'DELETE',headers:await this.auth()});}
  async list(prefix='',signal?:AbortSignal):Promise<{objects:ObjectInfo[];cursor:string}>{return(await this.http.request('/rooms/'+this.roomId+'/list?cursor=hash&prefix='+encodeURIComponent(prefix),{headers:await this.auth(),signal})).json();}
  async watch(cursor:string,signal?:AbortSignal):Promise<WatchResult>{
    if(cursor&&!/^h1\.[a-f0-9]{64}$/.test(cursor)){
      // Upgrade persisted legacy cursors locally; the full map never enters a URL.
      const tags=JSON.parse(text(unb64(cursor)));
      cursor='h1.'+hex(await sha256(utf8(JSON.stringify(Object.entries(tags).sort(([a],[b])=>a<b?-1:a>b?1:0)))));
    }
    return(await this.http.request('/rooms/'+this.roomId+'/watch?cursor=hash&since='+encodeURIComponent(cursor),{headers:await this.auth(),signal})).json();
  }
}
