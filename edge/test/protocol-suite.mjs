import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {hash,mac} from '../lib/router.mjs';
export async function runProtocol(fetcher,{local=false,storage,advance,onFixture}={}){
  const room=randomBytes(24).toString('base64url'),token=randomBytes(32).toString('base64url'),slot=randomBytes(16).toString('base64url'),other=randomBytes(16).toString('base64url');
  const pair=randomBytes(24).toString('base64url');onFixture?.({room,pair});
  const headers={'X-KJ-Token':token,'X-KJ-Slot':slot,'X-KJ-Slot-Proof':mac(token,slot)};
  const request=(path,method='GET',data,extra={})=>fetcher('/v2'+path,{method,headers:{...headers,...extra},...(data!==undefined?{body:Buffer.isBuffer(data)?data:JSON.stringify(data)}:{})});
  let checks=0;const eq=(a,b)=>{assert.equal(a,b);checks++;};
  async function proof(purpose){const c=await(await request('/pow?purpose='+purpose)).json();for(let n=0n;;n++){const b=Buffer.alloc(8);b.writeBigUInt64BE(n);const d=createHash('sha256').update(Buffer.from(c.challenge,'base64url')).update(b).digest();let bits=0;for(const x of d){if(!x){bits+=8;continue;}bits+=Math.clz32(x)-24;break;}if(bits>=c.difficulty)return{...c,nonce:b.toString('base64url')};}}
  const created=()=>request('/groups','POST',{room,tokenHash:hash(token),pow:undefined});
  eq((await request('/health')).status,200);eq((await created()).status,428);
  const pow=await proof('group');eq((await request('/groups','POST',{room,tokenHash:hash(token),pow})).status,201);
  eq((await request('/groups','POST',{room:randomBytes(24).toString('base64url'),tokenHash:hash(token),pow})).status,400);
  const path='/rooms/'+room,bytes=Buffer.alloc(128,23);
  eq((await request(path+'/list','GET',undefined,{'X-KJ-Token':'wrong'})).status,401);
  eq((await request(path+'/obj/d/'+other+'/state','PUT',bytes)).status,403);
  eq((await request(path+'/obj/d/'+slot+'/state','PUT',Buffer.alloc(1048577))).status,413);
  eq((await request(path+'/obj/d/'+slot+'/tabs','PUT',Buffer.alloc(65537))).status,413);
  eq((await request(path+'/obj/d/'+slot+'/h/'+new Date().toISOString().slice(0,10).replaceAll('-',''),'PUT',Buffer.alloc(262145))).status,413);
  eq((await request(path+'/obj/b/'+other,'PUT',Buffer.alloc(3145729))).status,413);
  eq((await request(path+'/obj/d/'+slot+'/state','PUT',bytes)).status,200);
  const read=await request(path+'/obj/d/'+slot+'/state');eq(read.status,200);assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);checks++;
  const list=await(await request(path+'/list')).json();eq(list.objects[0].size,bytes.length);eq(list.objects[0].key,'d/'+slot+'/state');
  const watch=request(path+'/watch?since='+list.cursor);const write=new Promise(r=>setTimeout(r,25)).then(()=>request(path+'/obj/d/'+slot+'/tabs','PUT',bytes));const [response]=await Promise.all([watch,write]);const change=await response.json();assert.ok(change.changed?.includes('d/'+slot+'/tabs'),JSON.stringify(change));checks++;
  if(local){const l=await(await request(path+'/list')).json(),before={...storage.counts};const timeout=await(await request(path+'/watch?since='+l.cursor)).json();eq(timeout.changed.length,0);eq(storage.counts.head,before.head);eq(storage.counts.get,before.get+1);}
  for(const origin of ['https://appassets.androidplatform.net','http://localhost:8791','chrome-extension://agijcmabomapmbobdgblmckibkpobdij']){eq((await request('/health','GET',undefined,{Origin:origin})).headers.get('Access-Control-Allow-Origin'),origin);eq((await request('/health','OPTIONS',undefined,{Origin:origin})).headers.get('Access-Control-Allow-Origin'),origin);}
  eq((await request('/health','GET',undefined,{Origin:'https://evil.example'})).headers.get('Access-Control-Allow-Origin'),null);
  eq((await request('/icon?host=127.0.0.1')).status,400);
  const pc=await proof('pair');const p=await(await request('/pair','POST',{room:pair,pow:pc})).json();assert.ok(p.hostKey);checks++;
  const pr='/pair/'+pair,guest=randomBytes(32).toString('base64url');
  eq((await request(pr+'/guest/0','PUT',{t:'hello-j'},{'X-KJ-Guest':guest})).status,204);
  eq((await request(pr+'/guest/0','PUT',{t:'different'},{'X-KJ-Guest':guest})).status,409);
  eq((await request(pr+'/guest/1','PUT',{}, {'X-KJ-Guest':randomBytes(32).toString('base64url')})).status,429);
  eq((await request(pr+'/host/0','PUT',{t:'hello-i'},{'X-KJ-Host':p.hostKey})).status,204);
  const frames=await(await request(pr+'/guest/messages?after=-1','GET',undefined,{'X-KJ-Host':p.hostKey})).json();eq(frames.messages.length,1);
  eq((await request(pr+'/host/1','PUT',Buffer.alloc(16385),{'X-KJ-Host':p.hostKey})).status,413);
  eq((await request(path+'/obj/d/'+slot+'/state','DELETE')).status,204);eq((await request(path+'/obj/d/'+slot+'/state')).status,404);
  if(local){advance(601000);eq((await request(pr+'/host/0','GET',undefined,{'X-KJ-Host':p.hostKey})).status,404);}
  // Only this test room and pair room are cleaned; production audit uses these exact roots.
  for(const item of(await(await request(path+'/list')).json()).objects)await request(path+'/obj/'+item.key,'DELETE');
  return {checks,room,pair,slot};
}
