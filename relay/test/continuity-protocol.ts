import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { solvePow } from '../../shared/protocol/src/pow.ts';
import { network } from '../scripts/network.mjs';

// The same public HTTP/WS assertions run against both adapters and production.
// Clock/capacity/rate boundary exhaustion is separate, never performed on customer IPs.
export async function continuityProtocol(base: string, proxy?: string, artifactName?: string, fetcher?: any) {
  const net = network(proxy), room = randomBytes(24).toString('base64url'), token = randomBytes(32).toString('base64url');
  const checks: string[] = [], frames: any[] = [], sockets: any[] = [];
  if(fetcher)net.fetch=fetcher;
  const result: any = { timestamp: new Date().toISOString(), base, mode: proxy ? 'proxy' : 'direct', checks, residualRooms: [], result: 'running' };
  let created = false;
  const env = { v: 1, iv: 'A'.repeat(16), ct: 'B'.repeat(22) };
  const ids = Array.from({length: 605}, () => randomBytes(16).toString('base64url'));
  const path = '/v1/groups/' + room;
  const call = async (p: string, method = 'GET', body?: any, headers: any = {}): Promise<any> => {const r=await net.fetch(base + path + p, {
    method, headers: { 'X-KJ-Token': token, ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });const bytes=await r.arrayBuffer();return new Response(r.status===204?null:bytes,{status:r.status,headers:r.headers});};
  const error = async (r: any, status: number, code: string) => { assert.equal(r.status, status); assert.equal((await r.json()).error.code, code); };
  const step = async (name: string, fn: () => Promise<void>) => { await fn(); checks.push(name); console.log('PASS ' + name); };
  const waitFrame = async (condition: () => boolean) => { const end = Date.now()+10000; while(!condition()) { if(Date.now()>=end)throw new Error('WS notification timed out'); await new Promise(r=>setTimeout(r,20)); } };
  try {
    const challenge: any = await (await net.fetch(base + '/v1/pow?purpose=group')).json();
    assert.equal((await net.fetch(base + '/v1/groups', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({room, tokenHash:createHash('sha256').update(token).digest('hex'), pow: await solvePow(challenge)}) })).status,201);
    created = true;
    const ws = new net.WebSocket(base.replace(/^http/,'ws') + path + '/ws', ['kj.v1','kjt.'+token]);
    sockets.push(ws);ws.on('message',(v:Buffer)=>{frames.push(JSON.parse(v.toString()));});
    await new Promise<void>((ok,bad)=>{ws.once('open',ok);ws.once('error',bad);});
    await step('journal dedup, after/limit pagination, token and payload boundaries, WS push',async()=>{
      await error(await call('/journal','GET',undefined,{'X-KJ-Token':'wrong'}),401,'UNAUTHORIZED');
      await error(await call('/journal','POST',{items:[{id:'invalid',env}]}),400,'BAD_REQUEST');
      await error(await call('/journal','POST',{items:Array.from({length:101},(_,i)=>({id:ids[i],env}))}),400,'BAD_REQUEST');
      await error(await call('/journal','POST',' '.repeat(262145)),413,'PAYLOAD_TOO_LARGE');
      const exact=JSON.stringify({items:[{id:ids[0],env}]});
      assert.equal((await call('/journal','POST',exact+' '.repeat(262144-Buffer.byteLength(exact)))).status,200);
      const duplicate = await (await call('/journal','POST',{items:[{id:ids[0],env:{...env,ct:'C'.repeat(22)}}]})).json();
      assert.deepEqual(duplicate,{seqs:[1],head:1});
      for(let n=1;n<601;n+=100)assert.equal((await call('/journal','POST',{items:ids.slice(n,n+100).map(id=>({id,env}))})).status,200);
      let p=await(await call('/journal?after=0&limit=500')).json();assert.equal(p.items.length,500);assert.equal(p.head,601);assert.equal(p.floor,1);assert.deepEqual(p.items.map((r:any)=>r.seq),Array.from({length:500},(_,i)=>i+1));
      assert.deepEqual(p.items[0].env,env);
      p=await(await call('/journal?after=500&limit=500')).json();assert.equal(p.items.length,101);assert.equal(p.items[0].seq,501);
      for(const query of ['after=-1','after=1.1','limit=501','limit=0'])await error(await call('/journal?'+query),400,'BAD_REQUEST');
      await waitFrame(()=>frames.some(f=>f.type==='journal'&&f.head===601));
    });
    await step('slots overwrite, cap 12, 64KiB boundary, deletion and WS push',async()=>{
      const raw=new Uint8Array(65536);raw[0]=1;
      for(let i=0;i<12;i++)assert.equal((await call('/slots/'+ids[i],'PUT',raw)).status,200);
      await error(await call('/slots/'+ids[12],'PUT',raw),429,'ROOM_FULL');
      assert.equal((await call('/slots/'+ids[0],'PUT',raw)).status,200);
      await error(await call('/slots/'+ids[0],'PUT',new Uint8Array(65537)),413,'PAYLOAD_TOO_LARGE');
      await error(await call('/slots/'+ids[0],'PUT',new Uint8Array(28)),400,'BAD_REQUEST');
      assert.equal((await(await call('/slots')).json()).slots.length,12);
      assert.equal((await call('/slots/'+ids[0],'DELETE')).status,204);
      assert.equal((await(await call('/slots')).json()).slots.length,11);
      await waitFrame(()=>frames.some(f=>f.type==='slot'&&f.slotId===ids[0]));
    });
    await step('blob 3MiB boundary, room 10MiB quota, overwrite and delete',async()=>{
      const raw=new Uint8Array(3*1024*1024);raw[0]=1;
      for(let i=0;i<3;i++)assert.equal((await call('/blobs/'+ids[i],'PUT',raw)).status,200);
      await error(await call('/blobs/'+ids[3],'PUT',raw),413,'PAYLOAD_TOO_LARGE');
      assert.equal((await call('/blobs/'+ids[0],'PUT',raw)).status,200);
      await error(await call('/blobs/'+ids[4],'PUT',new Uint8Array(raw.length+1)),413,'PAYLOAD_TOO_LARGE');
      assert.ok(Buffer.from(await(await call('/blobs/'+ids[0])).arrayBuffer()).equals(raw));
      assert.equal((await call('/blobs/'+ids[0],'DELETE')).status,204);
      await error(await call('/blobs/'+ids[0]),404,'NOT_FOUND');
    });
    await step('retirement cascades channels while preserving encrypted forward',async()=>{
      assert.equal((await call('/forward','POST',{env})).status,200);
      assert.equal((await call('','DELETE')).status,204);
      for(const p of ['/journal','/slots','/blobs/'+ids[1]])await error(await call(p),410,'GONE');
      assert.deepEqual(await(await call('/forward')).json(),{env});
    });
    result.result='passed';return result;
  } catch(e) {result.result='failed';result.error=e instanceof Error?e.message:String(e);throw e;}
  finally {
    for(const ws of sockets)ws.terminate();
    if(created)try{const r=await call('','DELETE');await r.text();if(![204,404].includes(r.status))result.residualRooms.push(room);}catch{result.residualRooms.push(room);}
    if(base==='https://kongjing.inc.re'&&created){const {cleanR2}=await import('../scripts/r2.mjs');await cleanR2([room]);}
    await net.close();
    await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
    await writeFile(new URL('../artifacts/continuity-protocol-'+(artifactName??(base.includes('kongjing.inc.re')?'online':base.includes('8791')?'worker':'local'))+'.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
    assert.deepEqual(result.residualRooms,[]);
  }
}
if(process.argv[1]?.endsWith('continuity-protocol.ts'))await continuityProtocol(process.argv[2]??'http://127.0.0.1:8793',process.argv.includes('--proxy')?process.argv[process.argv.indexOf('--proxy')+1]:undefined);
