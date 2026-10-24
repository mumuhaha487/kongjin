// Local-only fault injector. Uses the real Edge router and production MV3/offscreen
// bundles. No fault switches or protocol mocks enter a production build.
import assert from 'node:assert/strict';
import http from 'node:http';
import {Readable} from 'node:stream';
import {cp,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createRouter} from '../../edge/lib/router.mjs';
import {MemoryStorage} from '../../edge/lib/storage.mjs';
import {launchExtension} from './browser.mjs';

process.env.KJ_BLOCK_ONLINE_RELAY='1';
process.env.KJ_STORE_OFFLINE_ONLY='1';
const output=resolve('../docs/v6/v334-evidence/faults');await mkdir(output,{recursive:true});
const directory=await mkdtemp(resolve(tmpdir(),'kongjing-join-234-'));
const id='agijcmabomapmbobdgblmckibkpobdij';
let url;
const contexts=[],sessions=[],result={startedAt:new Date().toISOString(),production:true,online:false,scenarios:[],errors:[]};
let fault;
const router=createRouter({storage:new MemoryStorage(),secret:'local-only-234-fault-test',difficulty:0});
const server=http.createServer(async(req,res)=>{
  try{
    const request=new Request(url+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const isState=req.method==='PUT'&&/\/obj\/d\/[^/]+\/state$/.test(new URL(request.url).pathname);
    let response;
    if(fault&&isState&&request.headers.get('x-kj-slot')!==fault.inviterSlot){
      fault.attempts.push(Date.now());
      if(fault.mode==='persistent'||fault.mode==='once'&&fault.attempts.length===1){
        fault.injected++;
        response=new Response(JSON.stringify({error:{code:'NETWORK',message:'Test-only injected state PUT 500'}}),{status:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':request.headers.get('Origin')||'*'}});
      }else if(fault.hold){await fault.hold;}
    }
    if(!response)response=await router(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
  }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
url='http://localhost:'+server.address().port;
async function until(fn,predicate,label,timeout=20000){
  const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,150));}
  throw Error(label+' timeout');
}
async function offscreen(context){
  const root=await context.browser().newBrowserCDPSession();sessions.push(root);
  const targets=await until(()=>root.send('Target.getTargets'),r=>r.targetInfos.some(t=>t.url.endsWith('/offscreen.html')),'offscreen');
  const {sessionId}=await root.send('Target.attachToTarget',{targetId:targets.targetInfos.find(t=>t.url.endsWith('/offscreen.html')).targetId,flatten:false});
  let id=0;const pending=new Map();
  root.on('Target.receivedMessageFromTarget',({sessionId:s,message})=>{if(s!==sessionId)return;const m=JSON.parse(message);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(m.error.message)):p?.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')result.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:n,method,params})}).catch(reject);});
  await send('Runtime.enable');
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  await evaluate(`globalThis.__OriginalRTC=RTCPeerConnection;globalThis.RTCPeerConnection=class extends globalThis.__OriginalRTC{constructor(config){super({...config,iceServers:[]});}};`);
  return {evaluate};
}
async function desktop(name){
  const context=await launchExtension(resolve(directory,'profile-'+name),resolve(directory,'extension'));contexts.push(context);
  let page=await context.newPage();
  async function open(){await page.goto(`chrome-extension://${id}/index.html`);await page.getByRole('textbox',{name:'搜索',exact:true}).waitFor();}
  await open();
  const call=(action,args={})=>page.evaluate(({action,args})=>chrome.runtime.sendMessage({type:'kj:pair',action,args}),{action,args});
  await call('status');const cdp=await offscreen(context);await call('relay',{url});
  const setView=async(action)=>{await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('#settings-pairing > h3').evaluate(el=>el.scrollIntoView({block:'start'}));if(action)await page.getByRole('button',{name:action,exact:true}).click();};
  return {get page(){return page;},call,status:()=>call('status'),cdp,context,setView,
    async reopen(){await page.close();page=await context.newPage();await open();await call('status');await setView();},
    async data(){return page.evaluate(async()=>(await chrome.storage.local.get('data')).data);},
  };
}
async function hostSlot(a){return a.cdp.evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('kj-secrets');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const get=key=>new Promise(resolve=>{const r=db.transaction('secrets').objectStore('secrets').get(key);r.onsuccess=()=>resolve(r.result);});return {group:await get('group'),identity:await get('identity')};})()`);}
async function begin(a,b,name){
  const invitation=await a.call('create',{name:'本地邀请方 · Chrome'});
  assert.equal(invitation.pair.view,'invite');
  const {group,identity}=await hostSlot(a);
  const {deriveSlotId}=await import('../../shared/protocol/src/continuity-crypto.ts');
  const {unb64}=await import('../../shared/protocol/src/crypto.ts');
  fault={inviterSlot:await deriveSlotId(unb64(group.gk),group.epoch,identity.deviceId),mode:name,attempts:[],injected:0};
  if(name==='once')fault.hold=new Promise(resolve=>{fault.release=resolve;});
  await b.setView('加入已有配对组');
  await b.page.getByRole('textbox',{name:'配对码',exact:true}).fill(invitation.pair.code);
  await b.page.getByRole('textbox',{name:'本机名称',exact:true}).fill('本地加入方 · Chrome');
  await b.page.getByRole('button',{name:'连接',exact:true}).click();
  await Promise.all([until(a.status,r=>r.pair.view==='sas','host sas'),until(b.status,r=>r.pair.view==='sas','join sas')]);
  await a.call('confirm');await b.page.getByRole('button',{name:'一致',exact:true}).click();
  await b.page.getByRole('dialog',{name:'正在完成加入…',exact:true}).getByRole('heading',{name:'正在完成加入…',exact:true}).waitFor();
  await until(a.status,r=>r.status.devices.some(d=>d.joining),'inviter pending member');
  assert.equal((await b.status()).status.paired,false);
}
async function verifySuccess(a,b){
  await until(b.status,r=>r.pair.view==='success'&&r.status.paired,'joined',30000);
  await until(()=>Promise.all([a.status(),b.status()]),states=>states.every(s=>s.status.devices.length===2&&s.status.devices.every(d=>!d.joining)&&s.status.devices.filter(d=>!d.self).every(d=>d.online&&['direct','relay'].includes(d.transport))),'both members online',30000);
  const title='加入重试后双向同步 '+Date.now();
  for(const device of [a,b]){
    const text=title+(device===a?'A':'B');
    assert.equal((await device.page.evaluate(title=>chrome.runtime.sendMessage({type:'kj:collect',url:'https://join.example/'+encodeURIComponent(title),title}),text)).ok,true);
    await until(()=>Promise.all([a.data(),b.data()]),data=>data.every(d=>d.bookmarks.some(bookmark=>bookmark.title===text)),'post join sync',30000);
  }
}
try{
  await cp('dist',resolve(directory,'extension'),{recursive:true});
  const path=resolve(directory,'extension/manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'));
  assert.equal(manifest.version,'2.3.4');manifest.host_permissions.push(url+'/*');await writeFile(path,JSON.stringify(manifest));
  for(const scenario of ['first-500','persistent-retry','persistent-reopen']){
    console.log('SCENARIO '+scenario);
    const a=await desktop(scenario+'-a'),b=await desktop(scenario+'-b');
    await begin(a,b,scenario==='first-500'?'once':'persistent');
    await until(()=>fault.attempts.length,n=>n>0,'first joiner state PUT');
    const started=fault.attempts[0];
    await a.setView();await a.page.locator('.joining-pill').waitFor();
    assert.equal(await a.page.locator('.device-row').filter({has:a.page.getByText('等待加入',{exact:true})}).locator('.device-presence,.transport-pill').count(),0);
    await a.page.screenshot({path:output+'/'+scenario+'-inviter-waiting.png'});
    await b.page.screenshot({path:output+'/'+scenario+'-completing.png'});
    if(scenario==='first-500'){
      await until(()=>fault.attempts.length,n=>n>=2,'automatic retry PUT');
      fault.release();
      await verifySuccess(a,b);
      assert.equal(fault.injected,1,'only first state PUT failed, the next succeeds');
    }else{
      console.log('WAIT real >=120 second retry budget');
      await until(b.status,r=>r.status.joinPhase==='failed'&&r.pair.view==='join-failed','retry exhausted',155000);
      const elapsed=Date.now()-started;assert.ok(elapsed>=120000);
      await b.page.getByRole('dialog',{name:'没有完成加入',exact:true}).getByRole('heading',{name:'没有完成加入',exact:true}).waitFor();
      await b.page.screenshot({path:output+'/'+scenario+'-failed.png'});
      if(scenario==='persistent-reopen'){
        await b.reopen();
        await b.page.locator('#settings-pairing [data-join-phase="failed"]').waitFor();
        assert.equal(await b.page.getByRole('button',{name:'加入已有配对组',exact:true}).count(),0);
        await b.page.screenshot({path:output+'/'+scenario+'-reopened.png'});
      }
      fault.mode='recovered';
      await (scenario==='persistent-reopen'?b.page.locator('#settings-pairing'):b.page.getByRole('dialog',{name:'没有完成加入',exact:true})).getByRole('button',{name:'重试',exact:true}).click();
      await verifySuccess(a,b);
    }
    result.scenarios.push({name:scenario,passed:true,statePutAttempts:fault.attempts.length,injected500s:fault.injected,elapsedMs:Date.now()-started,firstPut500:true,waitingBeforeOnline:true,bidirectionalSync:true,reopened:scenario==='persistent-reopen'});
    console.log('PASS '+scenario);
    fault=undefined;await a.context.close();await b.context.close();
  }
  assert.deepEqual(result.errors,[]);result.passed=true;
}catch(error){result.passed=false;result.error=error.stack;process.exitCode=1;console.error(error);}
finally{
  fault?.release?.();
  for(const context of contexts)await context.close().catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  const path=relative(tmpdir(),directory);assert.ok(path&&!isAbsolute(path)&&!path.startsWith('..')&&directory.startsWith(resolve(tmpdir())+sep));
  await rm(directory,{recursive:true,force:true});result.temporaryRemoved=true;
  await writeFile(output+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
