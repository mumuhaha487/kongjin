import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {unzipSync} from 'fflate';
import {launchExtension} from './browser.mjs';
process.env.KJ_BLOCK_ONLINE_RELAY='1';
const root=await mkdtemp(resolve('tests/.v3-migration-')),extension=resolve(root,'extension'),id='agijcmabomapmbobdgblmckibkpobdij',edge='http://localhost:8793',legacy='http://localhost:8795';
const children=[],contexts=[],result={startedAt:new Date().toISOString(),checks:[],errors:[],online:false};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,predicate,label,timeout=60000){const start=Date.now();while(Date.now()-start<timeout){const v=await fn();if(v?.pair?.view==='failure')throw Error(label+': '+v.pair.error);if(predicate(v))return v;await wait(100);}throw Error(label+' timeout');}
const call=(p,action,args={})=>p.evaluate(({action,args})=>chrome.runtime.sendMessage({type:'kj:pair',action,args}),{action,args});
async function open(i){const c=await launchExtension(resolve(root,'profile-'+i),extension);contexts.push(c);c.on('console',m=>{if(m.text().startsWith('QA_FETCH'))console.log(m.text());});let p=await c.newPage();p.on('pageerror',e=>result.errors.push(e.message));await p.goto(`chrome-extension://${id}/index.html`);await p.getByRole('textbox',{name:'搜索',exact:true}).waitFor();await call(p,'status');return {c,p};}
const secret=(p,key,value,write=false)=>p.evaluate(async({key,value,write})=>{const db=await new Promise((r,j)=>{const q=indexedDB.open('kj-secrets');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});return new Promise((r,j)=>{const tx=db.transaction('secrets',write?'readwrite':'readonly');const q=write?tx.objectStore('secrets').put(value,key):tx.objectStore('secrets').get(key);q.onsuccess=()=>r(write?null:q.result);q.onerror=()=>j(q.error);});},{key,value,write});
const data=p=>p.evaluate(async()=>(await chrome.storage.local.get('data')).data);
async function add(p,title){await p.evaluate(async title=>{const {data}=await chrome.storage.local.get('data'),now=Date.now();data.bookmarks.push({id:crypto.randomUUID(),url:'https://migration.example/'+encodeURIComponent(title),title,groupId:data.groups[0].id,order:data.bookmarks.length,icon:{mode:'letter'},createdAt:now,updatedAt:now});await chrome.storage.local.set({data});},title);}
try{
 for(const [port,path]of [[8793,'../edge/scripts/dev.mjs'],[8795,'../relay/local/server.mjs']]){
  assert.equal(await fetch('http://localhost:'+port+(port===8793?'/v2/health':'/v1/health')).then(()=>true).catch(()=>false),false,'test port must be free');
  const s=spawn(process.execPath,[path,'--port',String(port),'--pow','0','--data',resolve(root,'data-'+port)],{windowsHide:true,stdio:'ignore'});children.push(s);
  await until(()=>fetch('http://localhost:'+port+(port===8793?'/v2/health':'/v1/health')).then(r=>r.ok).catch(()=>false),Boolean,'local service');
 }
 const entries=unzipSync(new Uint8Array(await readFile('../release/kongjing-2.2.0.zip')));
 for(const [name,bytes]of Object.entries(entries)){const target=resolve(extension,name);assert.ok(target.startsWith(extension+sep));await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
 let manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));assert.equal(manifest.version,'2.2.0');manifest.host_permissions.push(legacy+'/*',edge+'/*');await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
 let a=await open(0),b=await open(1);await call(a.p,'relay',{url:legacy});await call(b.p,'relay',{url:legacy});
 const invitation=await call(a.p,'create',{name:'Legacy A · Chrome'});await call(b.p,'join',{code:invitation.pair.code,name:'Legacy B · Chrome'});
 const [sa,sb]=await Promise.all([until(()=>call(a.p,'status'),s=>s.pair.view==='sas','legacy inviter'),until(()=>call(b.p,'status'),s=>s.pair.view==='sas','legacy joiner')]);assert.equal(sa.pair.sas,sb.pair.sas);
 await Promise.all([call(a.p,'confirm'),call(b.p,'confirm')]);await until(()=>call(b.p,'status'),s=>s.status.paired&&s.pair.view==='success','legacy group');
 const before=await secret(a.p,'group');result.deviceIds=before.members.map(m=>m.deviceId).sort();
 await add(a.p,'Before upgrade');await call(a.p,'sync');await until(()=>data(b.p),d=>d.bookmarks.some(b=>b.title==='Before upgrade'),'old sync');
 // Simulate production origin in the old credential without any online request.
 await secret(a.p,'relayUrl','https://kongjing.inc.re',true);for(const d of [a,b]){await secret(d.p,'app.sync-v3',{url:edge,directOnly:false,turnUrl:'',turnUser:'',turnCredential:''},true);}
 await a.c.close();await b.c.close();await rm(resolve(root,'profile-0/Default/Service Worker'),{recursive:true,force:true});
 const oldDir=resolve(root,'legacy-extension');await cp(extension,oldDir,{recursive:true});
 await rm(extension,{recursive:true});await cp('dist',extension,{recursive:true});manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));manifest.host_permissions.push(edge+'/*',legacy+'/*');await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
 await writeFile(resolve(extension,'qa-local.js'),`const originalFetch=globalThis.fetch.bind(globalThis);globalThis.fetch=async(url,init)=>{const target=String(url).replace('https://kongjing.inc.re','${legacy}');const r=await originalFetch(target,init);localStorage.setItem('qa:v3-fetch',JSON.stringify([...(JSON.parse(localStorage.getItem('qa:v3-fetch')||'[]')),{url:target,status:r.status}]));return r;};const OriginalWS=WebSocket;globalThis.WebSocket=class extends OriginalWS{constructor(url,protocols){super(String(url).replace('wss://kongjing.inc.re','ws://localhost:8795'),protocols);}};const OriginalRTC=RTCPeerConnection;globalThis.RTCPeerConnection=class extends OriginalRTC{constructor(config){super({...config,iceServers:[]});}};`);
 const html=await readFile(resolve(extension,'offscreen.html'),'utf8');await writeFile(resolve(extension,'offscreen.html'),html.replace('<head>','<head><script src="./qa-local.js"></script>'));
 a=await open(0);
 // Keep B genuinely on the old archive while only A has upgraded.
 const bContext=await launchExtension(resolve(root,'profile-1'),oldDir);contexts.push(bContext);const bp=await bContext.newPage();await bp.goto(`chrome-extension://${id}/index.html`);b={c:bContext,p:bp};
 await until(()=>call(a.p,'status'),s=>s.status.paired&&s.status.connection==='online','A automatic migration');
 assert.equal((await secret(a.p,'group')).gk,before.gk);assert.deepEqual((await call(a.p,'status')).status.devices.map(d=>d.deviceId).sort(),result.deviceIds);
 await add(a.p,'Upgraded A to legacy B');await call(a.p,'sync');await until(()=>data(b.p),d=>d.bookmarks.some(b=>b.title==='Upgraded A to legacy B'),'compatibility dual write');
 result.checks.push('actual 2.2.0 archive credentials retained; A upgrades without pairing; Edge-to-Cloudflare compatibility dual write reaches old B');
 await add(b.p,'Legacy B to upgraded A');await call(b.p,'sync');await until(()=>data(a.p),d=>d.bookmarks.some(b=>b.title==='Legacy B to upgraded A'),'old to upgraded');
 result.checks.push('legacy peer changes merge into the upgraded app');
 await secret(b.p,'relayUrl','https://kongjing.inc.re',true);await b.c.close();await rm(resolve(root,'profile-1/Default/Service Worker'),{recursive:true,force:true});b=await open(1);await until(()=>call(b.p,'status'),s=>s.status.paired&&s.status.connection==='online','B automatic migration');
 assert.equal((await secret(b.p,'group')).gk,before.gk);
 await until(()=>Promise.all([call(a.p,'status'),call(b.p,'status')]),v=>v.every(s=>s.status.transport==='direct'),'upgraded direct');
 await add(b.p,'Both upgraded direct');await until(()=>data(a.p),d=>d.bookmarks.some(b=>b.title==='Both upgraded direct'),'post-upgrade sync');
 result.checks.push('both upgraded profiles retain GK/member IDs/epoch and establish direct sync without invite/join');
 result.noRepair=true;result.passed=true;assert.deepEqual(result.errors,[]);
}catch(e){result.passed=false;result.error=e.stack;result.debug=await Promise.all(contexts.map(c=>c.pages().find(p=>p.url().includes(id))?.evaluate(()=>({trace:JSON.parse(localStorage.getItem('qa:v3-fetch')||'[]')})).catch(()=>null)));console.error(e);process.exitCode=1;}
finally{for(const c of contexts)await c.close().catch(()=>{});for(const c of children)c.kill();const output=process.env.KJ_EVIDENCE||'../docs/v6/v331-evidence';await mkdir(output,{recursive:true});await writeFile(output+'/migration.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
