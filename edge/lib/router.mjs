import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetchPublicIcon } from './icon.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
export const hash = s => createHash('sha256').update(s).digest('hex');
export const mac = (key,s) => createHmac('sha256',key).update(s).digest('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const ROOM=/^[\w-]{32}$/, SLOT=/^[\w-]{22}$/, TOKEN=/^[\w-]{16,128}$/;
const DAY=86400000, json=(v,status=200,headers={})=>new Response(status===204?null:JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
class HttpError extends Error { constructor(status,code,message=code,retryAfter){super(message);Object.assign(this,{status,code,retryAfter});} }
const fail=(s,c,m,r)=>{throw new HttpError(s,c,m,r);};
async function bytes(request,max) {
  if(Number(request.headers.get('Content-Length'))>max)fail(413,'PAYLOAD_TOO_LARGE');
  const reader=request.body?.getReader();let n=0;const chunks=[];
  if(reader)for(;;){const{done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();fail(413,'PAYLOAD_TOO_LARGE');}chunks.push(value);}
  return Buffer.concat(chunks,n);
}
async function body(request,max=16384){try{return JSON.parse((await bytes(request,max)).toString());}catch(e){if(e instanceof HttpError)throw e;fail(400,'BAD_REQUEST');}}
const decode=b=>b?JSON.parse(Buffer.from(b).toString()):null;
function allowed(origin,corsOrigins=''){return /^chrome-extension:\/\/[a-p]{32}$/.test(origin??'')||origin==='https://appassets.androidplatform.net'||/^http:\/\/localhost(?::\d+)?$/.test(origin??'')||corsOrigins.split(/[\s,]+/).filter(Boolean).includes(origin);}
export function objectKind(path){
  const d=/^d\/([\w-]{22})\/(state|tabs|presence|h\/(\d{8})|ev\/(\d{13})-[\w-]{8,32})$/.exec(path);
  if(d)return {kind:d[2].split('/')[0],slot:d[1],stamp:d[4]?Number(d[4]):undefined,date:d[3],max:d[2]==='state'?1048576:d[2].startsWith('h/')?262144:65536};
  const s=/^sig\/([\w-]{22})\/(\d{13})-[\w-]{8,32}$/.exec(path);if(s)return{kind:'sig',slot:s[1],stamp:Number(s[2]),max:65536};
  if(/^b\/[\w-]{22}$/.test(path))return{kind:'blob',max:3145728};
  return null;
}
export function createRouter({storage,secret,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),watchMs=25000,intervalMs=1000,difficulty=18,iconFetch,corsOrigins=process.env.KONGJING_CORS_ORIGINS??''}={}) {
  const timing=new AsyncLocalStorage(),backend=storage;
  storage=Object.fromEntries(['get','head','set','delete','list'].map(method=>[method,async(...args)=>{const start=performance.now();try{return await backend[method](...args);}finally{const t=timing.getStore();if(t)t[method==='list'?'list':['get','head'].includes(method)?'read':'write']+=performance.now()-start;}}]));
  const limits=new Map(),locks=new Map(), guestLocks=new Map();let cleanupAfter='';
  function guestHit(ip,weight=1){const t=now(),until=guestLocks.get(ip)??0;if(until>t)fail(429,'RATE_LIMITED',undefined,Math.ceil((until-t)/1000));try{hit(ip,'guest',10,600000,weight);}catch(e){guestLocks.set(ip,t+1800000);fail(429,'RATE_LIMITED',undefined,1800);}}
  const hit=(ip,key,max,period=60000,weight=1)=>{const k=ip+'|'+key,t=now();let v=limits.get(k);if(!v||v.at+period<=t)limits.set(k,v={at:t,n:0});if(v.n+weight>max)fail(429,'RATE_LIMITED',undefined,Math.ceil((v.at+period-t)/1000));v.n+=weight;if(limits.size>10000)for(const[k,v]of limits)if(v.at+DAY<=t)limits.delete(k);return v;};
  const serialize=async(key,fn)=>{const previous=locks.get(key)??Promise.resolve();let unlock;const next=new Promise(r=>unlock=r);locks.set(key,next);await previous;try{return await fn();}finally{unlock();if(locks.get(key)===next)locks.delete(key);}};
  const writeJSON=(key,value)=>storage.set(key,Buffer.from(JSON.stringify(value)));
  const expired=async(item)=>{
    if(item.key.startsWith('pow/')){const p=decode(await storage.get(item.key));return !p||p.expiresAt<=now();}
    if(item.key.startsWith('p/')){const room=item.key.split('/')[1],p=decode(await storage.get('p/'+room+'/meta'));return !p||p.expiresAt<=now();}
    const path=item.key.split('/').slice(2).join('/'),k=objectKind(path);if(!k)return false;
    if(k.stamp)return k.stamp+(k.kind==='sig'?120000:7*DAY)<=now();
    if(k.date){const d=Date.parse(k.date.slice(0,4)+'-'+k.date.slice(4,6)+'-'+k.date.slice(6,8));return !Number.isFinite(d)||d+91*DAY<=now();}
    if(['tabs','presence'].includes(k.kind)){const m=item.modified?item:await storage.head(item.key);return !m||!!m.modified&&m.modified+(k.kind==='tabs'?30*DAY:3*60000)<=now();}
    return false;
  };
  const clean=async(prefix,limit=50)=>{const items=await storage.list(prefix);let n=0;for(const item of items){if(n>=limit)break;if(await expired(item)){await storage.delete(item.key);n++;}}return n;};
  const listing=async(room)=>{return(await storage.list('g/'+room+'/')).filter(i=>i.key!=='g/'+room+'/meta').map(i=>({...i,key:i.key.slice(35)}));};
  const snapshot=async(room)=>{const items=await listing(room);return Object.fromEntries(items.map(i=>[i.key,i.etag]));};
  const cursor=map=>Buffer.from(JSON.stringify(map)).toString('base64url');
  // Negotiated, stateless cursors keep watch URLs constant-sized. Sort keys so
  // a storage backend's enumeration order cannot manufacture a change.
  const watchCursor=map=>'h1.'+hash(JSON.stringify(Object.entries(map).sort(([a],[b])=>a<b?-1:a>b?1:0)));
  async function auth(request,room){
    if(!ROOM.test(room))fail(400,'BAD_REQUEST');const token=request.headers.get('X-KJ-Token')??'';
    if(token.length>128)fail(401,'UNAUTHORIZED');const digest=hash(token);
    // The existing protocol stores only tokenHash in meta: authentication needs
    // exactly one bounded read, admitted by in-memory IP gates before this call.
    // No listing, payload access, lease write or cleanup runs before validation.
    const meta=decode(await storage.get('g/'+room+'/meta'));
    if(!meta)fail(404,'NOT_FOUND');if(!equal(digest,meta.tokenHash))fail(401,'UNAUTHORIZED');
    return {token,meta};
  }
  async function touchLease(room,meta){
    // After authentication AND admission; rejected requests cannot write a lease.
    if((meta.lastAccess??meta.createdAt)+3600000<now())await writeJSON('g/'+room+'/meta',{...meta,lastAccess:now()});
  }
  function proofSlot(request,token){const slot=request.headers.get('X-KJ-Slot')??'',proof=request.headers.get('X-KJ-Slot-Proof')??'';if(!SLOT.test(slot)||!equal(mac(token,slot),proof))fail(403,'UNAUTHORIZED');return slot;}
  async function pow(request,purpose,p){
    if(!p)fail(428,'POW_REQUIRED');
    if(p.purpose!==purpose||!/^[-\w]{22}$/.test(p.challenge??'')||!Number.isInteger(p.difficulty)||p.difficulty<difficulty||p.difficulty>24||!Number.isFinite(p.expiresAt)||p.expiresAt<=now()||p.expiresAt>now()+120000||!equal(mac(secret,p.challenge+String(p.difficulty)+String(p.expiresAt)+purpose),p.sig)||!/^[-\w]{11}$/.test(p.nonce??''))fail(400,'POW_INVALID');
    const digest=createHash('sha256').update(Buffer.from(p.challenge,'base64url')).update(Buffer.from(p.nonce,'base64url')).digest();let bits=0;for(const n of digest){if(!n){bits+=8;continue;}bits+=Math.clz32(n)-24;break;}if(bits<p.difficulty)fail(400,'POW_INVALID');
    await serialize('pow/'+p.challenge,async()=>{if(await storage.get('pow/'+p.challenge))fail(400,'POW_INVALID');await writeJSON('pow/'+p.challenge,{expiresAt:p.expiresAt});});
  }
  async function dispatch(request){
    const url=new URL(request.url),path=url.pathname,method=request.method,ip=hash((request.headers.get('CF-Connecting-IP')??request.headers.get('x-forwarded-for')??'unknown')+'|'+secret);
    if(method==='OPTIONS')return json(null,204);
    if(path==='/v2/health'&&method==='GET')return json({ok:true,service:'kongjing-edge',version:'3.0.2'});
    if(!secret)fail(503,'SERVER_ERROR');
    const group=/^\/v2\/rooms\/([\w-]{32})\/(obj\/(.+)|list|watch)$/.exec(path);
    hit(ip,'total',600);
    if(!group)hit(ip,'all',300);
    if(path==='/v2/pow'&&method==='GET'){
      const purpose=url.searchParams.get('purpose');if(!['group','pair'].includes(purpose))fail(400,'BAD_REQUEST');hit(ip,'pow',30);
      const challenge=randomBytes(16).toString('base64url'),expiresAt=now()+120000;
      return json({challenge,difficulty,expiresAt,purpose,sig:mac(secret,challenge+String(difficulty)+String(expiresAt)+purpose)});
    }
    if(path==='/v2/groups'&&method==='POST'){
      const b=await body(request);if(!ROOM.test(b.room??'')||!/^[a-f0-9]{64}$/.test(b.tokenHash??''))fail(400,'BAD_REQUEST');
      const key='g/'+b.room+'/meta',existing=decode(await storage.get(key));
      // Existing paired members can initialize the same derived room independently.
      if(existing){if(!equal(existing.tokenHash,b.tokenHash)||!equal(hash(request.headers.get('X-KJ-Token')??''),b.tokenHash))fail(409,'CONFLICT');return json({room:b.room},200);}
      await pow(request,'group',b.pow);hit(ip,'groupHour',5,3600000);hit(ip,'groupDay',20,DAY);
      await writeJSON(key,{tokenHash:b.tokenHash,createdAt:now()});let budget=50;budget-=await clean('pow/',Math.min(15,budget));budget-=await clean('p/',Math.min(15,budget));
      // Bound global idle-room garbage collection work per creation.
      const allMetas=(await storage.list('g/')).filter(x=>x.key.endsWith('/meta')).sort((a,b)=>a.key.localeCompare(b.key));let start=allMetas.findIndex(m=>m.key>cleanupAfter);if(start<0)start=0;
      const metas=[...allMetas.slice(start),...allMetas.slice(0,start)].slice(0,50);
      for(const m of metas){if(!budget)break;cleanupAfter=m.key;const meta=decode(await storage.get(m.key));if(meta&&(meta.lastAccess??meta.createdAt)+180*DAY<now()){const children=(await storage.list(m.key.slice(0,-4))).filter(x=>x.key!==m.key),take=Math.min(children.length,budget);for(const o of children.slice(0,take)){await storage.delete(o.key);budget--;}if(budget&&take===children.length){await storage.delete(m.key);budget--;}}}
      return json({room:b.room},201);
    }
    if(group){
      // Reserve BEFORE the async metadata read: concurrent token guesses cannot
      // all slip through a check-then-charge gate. Refund only validated tokens.
      const reservation=hit(ip,'all',300);
      const room=group[1],{token,meta}=await auth(request,room),base='g/'+room+'/';reservation.n--;
      if(group[2]==='watch'&&method==='GET'){
        hit('room:'+room,'watch',240);let old;const since=url.searchParams.get('since'),compact=url.searchParams.get('cursor')==='hash';
        if(compact){if(since&&!/^h1\.[a-f0-9]{64}$/.test(since))fail(400,'BAD_REQUEST');}
        else{if((since?.length??0)>32768)fail(400,'BAD_REQUEST');try{old=since?JSON.parse(Buffer.from(since,'base64url').toString()):{};}catch{fail(400,'BAD_REQUEST');}if(!old||Array.isArray(old)||typeof old!=='object')fail(400,'BAD_REQUEST');}
        await touchLease(room,meta);
        const deadline=now()+watchMs;let current;
        do{current=await snapshot(room);if(compact){const next=watchCursor(current);if(next!==since)return json({changed:Object.keys(current),cursor:next,tags:current,reset:true});}
          else{const changed=[...new Set([...Object.keys(old),...Object.keys(current)])].filter(k=>old[k]!==current[k]);if(changed.length)return json({changed,cursor:cursor(current)});}
          if(now()>=deadline)break;await sleep(Math.min(intervalMs,deadline-now()));}while(!request.signal?.aborted);
        return json({changed:[],cursor:compact?watchCursor(current):cursor(current??old)});
      }
      if(group[2]==='list'&&method==='GET'){
        const prefix=url.searchParams.get('prefix')??'';if(prefix.includes('..')||prefix.startsWith('/')||prefix.includes('\\'))fail(400,'BAD_REQUEST');
        await touchLease(room,meta);
        await clean(base,50);const all=await listing(room),items=all.filter(i=>i.key.startsWith(prefix));
        const tags=Object.fromEntries(all.map(i=>[i.key,i.etag]));
        return json({objects:await Promise.all(items.map(async i=>({...i,...await storage.head(base+i.key),key:i.key}))),cursor:url.searchParams.get('cursor')==='hash'?watchCursor(tags):cursor(tags)});
      }
      if(group[3]){
        let p;try{p=decodeURIComponent(group[3]);}catch{fail(400,'BAD_REQUEST');}const kind=objectKind(p);if(!kind)fail(400,'BAD_REQUEST');const key=base+p;
        if(method==='GET'){await touchLease(room,meta);if(await expired({key})){await storage.delete(key);fail(404,'NOT_FOUND');}const data=await storage.get(key);if(!data)fail(404,'NOT_FOUND');return new Response(data,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(data.length),'Cache-Control':'no-store',ETag:'"'+hash(data)+'"'}});}
        if(!['PUT','DELETE'].includes(method))fail(405,'BAD_REQUEST');const slot=proofSlot(request,token);
        if(kind.kind!=='blob'&&kind.kind!=='sig'&&kind.slot!==slot)fail(403,'UNAUTHORIZED');
        if(method==='DELETE'&&kind.kind==='sig'&&kind.slot!==slot)fail(403,'UNAUTHORIZED');
        hit('room:'+room,'write',240);await touchLease(room,meta);
        if(method==='DELETE'){await storage.delete(key);return json(null,204);}
        if(kind.stamp&&(kind.stamp>now()+60000||kind.stamp<(now()-(kind.kind==='sig'?120000:7*DAY))))fail(400,'BAD_REQUEST');
        if(kind.date){const at=Date.parse(kind.date.slice(0,4)+'-'+kind.date.slice(4,6)+'-'+kind.date.slice(6,8));if(!Number.isFinite(at)||at<now()-91*DAY||at>now()+DAY)fail(400,'BAD_REQUEST');}
        const data=await bytes(request,kind.max);if(data.length<29)fail(400,'BAD_REQUEST','Encrypted object required');
        const etag=hash(data),prior=await storage.head(key);
        // Blob providers can expose opaque etags. Compare bounded object bytes
        // for same-size replacements instead of assuming a provider hash format.
        if(prior&&(prior.etag===etag||(!prior.size||prior.size===data.length)&&Buffer.from(await storage.get(key)??[]).equals(data)))return json({etag});
        if(kind.kind==='blob'){
          const items=await storage.list(base+'b/');let total=0;for(const i of items)if(i.key!==key)total+=(await storage.head(i.key))?.size??0;if(total+data.length>10*1024*1024)fail(413,'PAYLOAD_TOO_LARGE','Room blob quota');
        }else if(kind.kind!=='sig'){
          const slots=new Set((await storage.list(base+'d/')).map(i=>i.key.split('/')[3]));if(!slots.has(slot)&&slots.size>=10)fail(429,'ROOM_FULL');
        }
        await storage.set(key,data);return json({etag});
      }
    }
    if(path==='/v2/pair'&&method==='POST'){
      const b=await body(request);if(!ROOM.test(b.room??''))fail(400,'BAD_REQUEST');await pow(request,'pair',b.pow);hit(ip,'pairHour',10,3600000);
      const existing=decode(await storage.get('p/'+b.room+'/meta'));if(existing&&existing.expiresAt>now())fail(409,'CONFLICT');
      const hostKey=randomBytes(32).toString('base64url'),expiresAt=now()+600000;
      await writeJSON('p/'+b.room+'/meta',{hostHash:hash(hostKey),expiresAt});return json({hostKey,expiresAt},201);
    }
    const pair=/^\/v2\/pair\/([\w-]{32})\/(host|guest)\/(messages|\d{1,4})$/.exec(path);
    if(pair&&['GET','PUT'].includes(method))return serialize('pair/'+pair[1],async()=>{
      const root='p/'+pair[1]+'/',meta=decode(await storage.get(root+'meta'));
      const host=request.headers.get('X-KJ-Host'),guest=request.headers.get('X-KJ-Guest');
      if(!meta||meta.expiresAt<=now()){guestHit(ip,2);fail(404,'NOT_FOUND');}
      if(host){if(!equal(hash(host),meta.hostHash))fail(401,'UNAUTHORIZED');}
      else{if((guestLocks.get(ip)??0)>now())guestHit(ip);if(!TOKEN.test(guest??'')){guestHit(ip);fail(401,'UNAUTHORIZED');}if(!meta.guestHash){guestHit(ip);meta.guestHash=hash(guest);await writeJSON(root+'meta',meta);}else if(!equal(meta.guestHash,hash(guest))){guestHit(ip);fail(429,'ROOM_FULL');}}
      const side=pair[2],id=pair[3];if(method==='PUT'){
        if((host?'host':'guest')!==side||id==='messages')fail(403,'UNAUTHORIZED');const data=await bytes(request,16384);try{JSON.parse(data.toString());}catch{fail(400,'BAD_REQUEST');}
        const key=root+side+'/'+id,prior=await storage.get(key);if(prior&&!Buffer.from(prior).equals(data))fail(409,'CONFLICT');if(!prior)await storage.set(key,data);return json(null,204);
      }
      if(id==='messages'){const after=Number(url.searchParams.get('after')??'-1');if(!Number.isInteger(after))fail(400,'BAD_REQUEST');const items=(await storage.list(root+side+'/')).filter(i=>/^\d+$/.test(i.key.split('/').at(-1))&&Number(i.key.split('/').at(-1))>after).sort((a,b)=>Number(a.key.split('/').at(-1))-Number(b.key.split('/').at(-1)));return json({messages:await Promise.all(items.map(async i=>({seq:Number(i.key.split('/').at(-1)),frame:decode(await storage.get(i.key))}))),expiresAt:meta.expiresAt});}
      const frame=decode(await storage.get(root+side+'/'+id));if(!frame)fail(404,'NOT_FOUND');return json(frame);
    });
    if(path==='/v2/icon'&&method==='GET'){hit(ip,'icon',60);return fetchPublicIcon(url.searchParams.get('host'),iconFetch);}
    fail(404,'NOT_FOUND');
  }
  return async request=>timing.run({read:0,write:0,list:0},async()=>{
    const start=performance.now();
    let response;try{response=await dispatch(request);}catch(e){response=json({error:{code:e.code??'SERVER_ERROR',message:e instanceof HttpError?e.message:'Internal server error'},...(e.retryAfter?{retryAfter:e.retryAfter}:{})},e.status??500,e.retryAfter?{'Retry-After':String(e.retryAfter)}:{});}
    const headers=new Headers(response.headers),origin=request.headers.get('Origin');headers.set('Vary','Origin');if(allowed(origin,corsOrigins))headers.set('Access-Control-Allow-Origin',origin);
    const t=timing.getStore();headers.set('Server-Timing',`total;dur=${(performance.now()-start).toFixed(2)}, blob_read;dur=${t.read.toFixed(2)}, blob_write;dur=${t.write.toFixed(2)}, blob_list;dur=${t.list.toFixed(2)}`);
    headers.set('Access-Control-Allow-Methods','GET, PUT, POST, DELETE, OPTIONS');headers.set('Access-Control-Allow-Headers','Content-Type, X-KJ-Token, X-KJ-Slot, X-KJ-Slot-Proof, X-KJ-Host, X-KJ-Guest');headers.set('Access-Control-Max-Age','86400');headers.set('Access-Control-Expose-Headers','ETag, Retry-After, Server-Timing');headers.set('X-Content-Type-Options','nosniff');return new Response(response.body,{status:response.status,headers});
  });
}
