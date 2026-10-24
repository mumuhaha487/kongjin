import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createHash} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {continuityE2E} from './continuity-e2e.ts';
import {continuityProtocol} from './continuity-protocol.ts';
import {protocolSuite} from './protocol.ts';

const {outputFiles}=await build({entryPoints:['test/continuity-runtime.mjs'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});
const mf=new Miniflare({...convertV4MiniflareOptions({workers:[{name:'kongjing-continuity-test',modules:true,script:outputFiles[0].text,compatibilityDate:'2026-10-21',
  durableObjects:{GROUPS:{className:'GroupRoom',useSQLite:true},PAIRS:{className:'PairRoom',useSQLite:true},GUARDS:{className:'Guard',useSQLite:true}},r2Buckets:['BUCKET'],bindings:{TESTING:'true',LOCAL:'true',TEST_CONFIG:'{"difficulty":0}',POW_SECRET:'local-test-only',IP_HASH_SALT:'local-test-only'}}]}),unsafeInspectDurableObjects:true});
const checks:string[]=[],DAY=86400000;
let clock=Date.now();
const {GROUPS,BUCKET}=await mf.getBindings<any>();
const room='X'.repeat(32),id='B'.repeat(22),token='local-workerd-test-token';
const stub=GROUPS.get(GROUPS.idFromName(room));
const call=(p:string,method='GET',body?:any,config:any={})=>stub.fetch('https://internal/'+p,{method,headers:{'X-KJ-Token':token,'X-Test-Clock':String(clock),'X-Test-Config':JSON.stringify(config)},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});
const env={v:1,iv:'A'.repeat(16),ct:'B'.repeat(22)},slot=new Uint8Array(29);slot[0]=1;
try {
  const origin=(await mf.ready).origin;
  // dispatchFetch exercises workerd directly without the dev HTTP bridge's unread-body reset.
  const transport=(url:any,init:any)=>mf.dispatchFetch(url,init);
  const original=await protocolSuite(origin,undefined,transport);
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/protocol-workerd.json',JSON.stringify(original,null,2));
  await continuityProtocol(origin,undefined,'workerd',transport);
  assert.equal((await call('create','POST',{room,tokenHash:createHash('sha256').update(token).digest('hex')})).status,201);
  const sql=await mf.unsafeGetDurableObjectStorage('kongjing-continuity-test','GroupRoom',{name:room});
  for(let i=0;i<5;i++)assert.equal((await call('journal','POST',{items:[{id:Buffer.alloc(16,i).toString('base64url'),env}]},{journalCount:3})).status,200);
  let page:any=await(await call('journal')).json();assert.equal(page.gap,true);assert.equal(page.floor,3);assert.equal(page.head,5);
  checks.push('workerd SQLite capacity eviction, gap, monotonic head');
  await call('slots/'+id,'PUT',slot);await call('blobs/'+id,'PUT',slot);
  const rows=await sql.exec('SELECT env FROM kj_journal UNION ALL SELECT env FROM kj_slots');
  assert.equal(rows.length,4);for(const r of rows)assert.equal(JSON.parse(Buffer.from(r.env as any).toString()).v,1);
  assert.equal((await BUCKET.get('g/'+room+'/b/'+id)).size,29);
  checks.push('read physical SQLite BLOB columns and R2 object');
  for(const [path,method,body,config,key]of [
    ['journal','POST',{items:[{id,env}]},{journalPut:2},'journalPut'],['journal','GET',undefined,{journalGet:2},'journalGet'],
    ['slots','GET',undefined,{slots:2},'slots'],['blobs/'+id,'PUT',slot,{blobPut:2},'blobPut'],
  ]as const){
    clock+=60000;
    for(let i=0;i<2;i++)assert.equal((await call(path,method,body,config)).status,200);
    const denied=await call(path,method,body,config);assert.equal(denied.status,429,key);assert.equal(denied.headers.get('Retry-After'),'60');
    clock+=60000;assert.equal((await call(path,method,body,config)).status,200);
  }
  checks.push('workerd room read/write/slot/blob limits and Retry-After reset');
  clock+=30*DAY;await call('test-alarm','POST');assert.equal((await sql.exec('SELECT COUNT(*) AS n FROM kj_slots'))[0].n,0);
  assert.ok((await sql.exec('SELECT COUNT(*) AS n FROM kj_journal'))[0].n as number>0);
  checks.push('workerd alarm removes 30-day slots while retaining journal');
  clock+=60*DAY;await call('test-alarm','POST');assert.equal((await sql.exec('SELECT COUNT(*) AS n FROM kj_journal'))[0].n,0);
  page=await(await call('journal')).json();assert.equal(page.floor,page.head+1);assert.equal(page.gap,true);
  checks.push('workerd 90-day journal alarm preserves head');
  await call('journal','POST',{items:[{id,env}]});await call('slots/'+id,'PUT',slot);
  assert.equal((await call('delete','DELETE')).status,204);
  for(const t of ['kj_journal','kj_slots','kj_blobs'])assert.equal((await sql.exec('SELECT COUNT(*) AS n FROM '+t))[0].n,0);
  assert.equal(await BUCKET.get('g/'+room+'/b/'+id),null);
  checks.push('workerd cascade deletes actual SQLite rows and R2 bytes');
  clock+=180*DAY+3600000;await call('test-alarm','POST');assert.equal((await call('journal')).status,404);
  checks.push('workerd 180-day room garbage collection');
  await continuityE2E((await mf.ready).origin,undefined,async(rooms,needles)=>{
    let journalRows=0,slotRows=0,blobs=0;
    for(const room of rooms.keys()) {
      const db=await mf.unsafeGetDurableObjectStorage('kongjing-continuity-test','GroupRoom',{name:room});
      for(const table of ['kj_journal','kj_slots'])for(const row of await db.exec('SELECT env FROM '+table)){
        const raw=Buffer.from(row.env as any);for(const needle of needles)assert.equal(raw.includes(Buffer.from(needle)),false);
        if(table==='kj_journal')journalRows++;else slotRows++;
      }
      for(const object of (await BUCKET.list({prefix:'g/'+room+'/b/'})).objects) {
        const raw=Buffer.from(await(await BUCKET.get(object.key)).arrayBuffer());
        for(const needle of needles)assert.equal(raw.includes(Buffer.from(needle)),false);blobs++;
      }
    }
    assert.ok(journalRows>0&&slotRows>0&&blobs>0);return {journalRows,slotRows,blobs,containsPlaintext:false};
  },'workerd-storage');
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/continuity-runtime.json',JSON.stringify({timestamp:new Date().toISOString(),checks,result:'passed'},null,2)+'\n');
  console.log('PASSED '+checks.length+' workerd runtime groups');
}finally{await mf.dispose();}
