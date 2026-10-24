import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {unzipSync} from 'fflate';
import {launchExtension,launchChrome} from './browser.mjs';
import {homeServer} from './android-server.mjs';
import {mobileOptions,nativeMock,bridgeCall} from './android-fixtures.mjs';
import {deriveGroup,unb64} from '../../shared/protocol/src/crypto.ts';
import {deriveSlotId} from '../../shared/protocol/src/continuity-crypto.ts';
import {TransportEdge} from '../../shared/protocol/src/transport-edge.ts';
import {ProxyAgent,fetch as proxyFetch} from 'undici';
import {startServer} from '../../edge/scripts/dev.mjs';
import {FileStorage,MemoryStorage} from '../../edge/lib/storage.mjs';
const online=process.argv.includes('--online');
const regression=process.argv.includes('--atomic');
const upgrade=process.argv.includes('--upgrade-from-231');
if((regression||upgrade)&&online)throw Error('Atomicity and upgrade regressions are local-only');
const evidence=process.env.KJ_EVIDENCE||(regression?'../docs/v6/v331-evidence':'../docs/v6/v3-evidence');
if(online) {
 await mkdir('../docs/v6/v3-evidence',{recursive:true});
 await writeFile('../docs/v6/v3-evidence/online-once.json',JSON.stringify({startedAt:new Date().toISOString(),purpose:'single authorized proxy application round'}),{flag:'wx'});
}
if(!online)process.env.KJ_BLOCK_ONLINE_RELAY='1';
else {delete process.env.KJ_BLOCK_ONLINE_RELAY;delete process.env.KJ_STORE_OFFLINE_ONLY;}
const localPort=Number(process.env.KJ_EDGE_TEST_PORT||8793);
const url=online?'https://sync.example.com':'http://localhost:'+localPort;
const dir=await mkdtemp(process.env.KJ_TEST_ROOT||resolve('tests/.v3-'+(online?'online-':'local-'))),id='agijcmabomapmbobdgblmckibkpobdij';
const contexts=[],devices=[],servers=[],cdps=[],groups=[];
const proxyAgent=online?new ProxyAgent('http://127.0.0.1:10808'):undefined;
const network=(input,init)=>online?proxyFetch(input,{...init,dispatcher:proxyAgent}):fetch(input,init);
const result={startedAt:new Date().toISOString(),online,url,checks:[],timings:{},errors:[]};
result.localStorageFailures=[];
const memoryBackend=process.argv.includes('--memory-backend');
async function until(fn,predicate,label,timeout=90000){console.log('WAIT',label);const start=Date.now();while(Date.now()-start<timeout){const value=await Promise.race([fn(),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error(label+' call timeout')),15000);t.unref();})]);if(value?.pair?.view==='failure')throw Error(label+': '+value.pair.error);if(predicate(value))return value;await new Promise(r=>setTimeout(r,100));}throw Error(label+' timeout');}
async function offscreen(context){
 const root=await context.browser().newBrowserCDPSession();cdps.push(root);
 const target=await until(()=>root.send('Target.getTargets'),v=>v.targetInfos.some(t=>t.url.endsWith('/offscreen.html')),'offscreen target');
 const {sessionId}=await root.send('Target.attachToTarget',{targetId:target.targetInfos.find(t=>t.url.endsWith('/offscreen.html')).targetId,flatten:false});
 let seq=0;const pending=new Map();
 root.on('Target.receivedMessageFromTarget',({sessionId:s,message})=>{if(s!==sessionId)return;const data=JSON.parse(message);if(data.id){const p=pending.get(data.id);pending.delete(data.id);if(data.error)p?.reject(Error(data.error.message));else p?.resolve(data.result);}else if(data.method==='Runtime.exceptionThrown')result.errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const command=++seq;pending.set(command,{resolve,reject});root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:command,method,params})}).catch(reject);});
 await send('Runtime.enable');await send('Page.enable');
 const evaluate=async(expression)=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 return {send,evaluate};
}
const iceScript=`globalThis.__OriginalRTC ??= RTCPeerConnection; globalThis.RTCPeerConnection = class extends globalThis.__OriginalRTC { constructor(config) { super({...config,iceServers:[]}); } async setLocalDescription(...args) { if(globalThis.__forceRelay) throw Error('QA forced direct failure'); return super.setLocalDescription(...args); } };`;
async function desktop(index){
 const context=await launchExtension(resolve(dir,'profile-'+index),resolve(dir,'extension'),{...(online?{proxy:{server:'http://127.0.0.1:10808'}}:{})});contexts.push(context);
 const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));await page.goto(`chrome-extension://${id}/index.html`);
 await page.getByRole('textbox',{name:'搜索',exact:true}).waitFor();
 const call=(action,args={})=>page.evaluate(({action,args})=>chrome.runtime.sendMessage({type:'kj:pair',action,args}),{action,args});
 await call('status');
 const cdp=await offscreen(context);await cdp.evaluate(iceScript);
 await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:iceScript});
 const d={page,context,call,cdp,status:()=>call('status'),data:()=>page.evaluate(async()=>(await chrome.storage.local.get('data')).data)};
 await call('relay',{url});
 devices.push(d);return d;
}
async function pair(a,b,name){
 let invitation=await a.status();if(invitation.pair.view!=='invite')invitation=await a.call('invite');assert.equal(invitation.pair.view,'invite');
 await b.call('join',{code:invitation.pair.code,name});
 const [sa,sb]=await Promise.all([until(a.status,s=>s.pair.view==='sas','inviter SAS'),until(b.status,s=>s.pair.view==='sas','joiner SAS')]);assert.equal(sa.pair.sas,sb.pair.sas);assert.ok(sb.pair.peerName);
 await Promise.all([a.call('confirm'),b.call('confirm')]);
 await until(b.status,s=>s.status.paired&&s.pair.view==='success','joined');
}
async function readSecret(d,key){
 const expression=`(${async function(key){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('kj-secrets');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return new Promise((resolve,reject)=>{const r=db.transaction('secrets').objectStore('secrets').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}})(${JSON.stringify(key)})`;
 return d.phone?d.page.evaluate(expression):d.cdp.evaluate(expression);
}
async function auditRoom(a){
 const group=await readSecret(a,'group'),identity=await readSecret(a,'identity');
 const keys=await deriveGroup(unb64(group.gk),group.epoch),slot=await deriveSlotId(unb64(group.gk),group.epoch,identity.deviceId);
 groups.push({keys,slot}); result.testRoom=keys.roomId;
 return new TransportEdge(keys.roomId,keys.roomToken,slot,{url,fetch:network});
}
async function add(d,title){
 if(d.phone)return bridgeCall(d.page,'addBookmark',{url:'https://continuity.example/'+encodeURIComponent(title),title});
 const reply=await d.page.evaluate(title=>chrome.runtime.sendMessage({type:'kj:collect',url:'https://continuity.example/'+encodeURIComponent(title),title}),title);
 assert.equal(reply.ok,true,'real quick-collect durable acknowledgement');return reply;
}
async function received(d,title){return (await d.data())?.bookmarks.some(b=>b.title===title);}
async function bindPhone(page,context,directory){
 const files=await import('node:fs/promises').then(fs=>fs.readdir(resolve(directory,'assets')));
 let mainFile;
 for(const file of files.filter(f=>f.endsWith('.js'))){const code=await readFile(resolve(directory,'assets',file),'utf8');if(code.includes('foreground')&&code.includes('join-view')&&code.includes('getState')){mainFile=file;break;}}
 assert.ok(mainFile,'production Android bridge module');
 const phoneCall=(action,args={})=>page.evaluate(async({action,args,file})=>{
  const module=await import(new URL('assets/'+file,document.baseURI).href);
  const values=Object.values(module);
  const store=values.find(value=>typeof value==='function'&&typeof value.getState==='function'&&value.getState().status&&value.getState().pair);
  if(!store)throw Error('production store not resolved');globalThis.__v3Store=store;
  const command=values.find(fn=>typeof fn==='function'&&Function.prototype.toString.call(fn).includes('join-view')&&Function.prototype.toString.call(fn).includes('.command('));
  if(!command)throw Error('production pairing bridge not resolved');
  if(action!=='status')await command(action,args);
  return {status:store.getState().status,pair:store.getState().pair};
 },{action,args,file:mainFile});
 return {phone:true,page,context,call:phoneCall,status:()=>phoneCall('status'),data:()=>page.evaluate(()=>globalThis.__v3Store.getState().data),mainFile};
}
async function localManifest(){
 const path=resolve(dir,'extension/manifest.json');
 const manifest=JSON.parse(await readFile(path,'utf8'));
 manifest.host_permissions.push(url+'/*','http://127.0.0.1:8790/*');
 await writeFile(path,JSON.stringify(manifest));
 if(upgrade){
  // Test copy only: install local host-only ICE before a paired engine starts.
  await writeFile(resolve(dir,'extension/qa-ice.js'),iceScript);
  const htmlPath=resolve(dir,'extension/offscreen.html');
  await writeFile(htmlPath,(await readFile(htmlPath,'utf8')).replace('<head>','<head><script src="./qa-ice.js"></script>'));
 }
}
try{
 if(!online){
  assert.equal(await fetch(url+'/v2/health').then(()=>true).catch(()=>false),false,'local test port must be free');
  const backend=memoryBackend?new MemoryStorage():new FileStorage(resolve(dir,'edge'));
  const storage=new Proxy(backend,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return async(...args)=>{try{return await Reflect.apply(value,target,args);}catch(error){result.localStorageFailures.push({operation:key,code:error.code,message:error.message});throw error;}};}});
  const server=await startServer({port:localPort,difficulty:0,storage});servers.push({kill:()=>new Promise(r=>server.close(r))});
  result.localBackend=memoryBackend?'MemoryStorage':'FileStorage';
 }
 if(upgrade){
  const extension=resolve(dir,'extension');
  const entries=unzipSync(await readFile('../release/kongjing-2.3.1.zip'));
  assert.equal(JSON.parse(Buffer.from(entries['manifest.json']).toString()).version,'2.3.1');
  for(const [name,bytes]of Object.entries(entries)){
   const target=resolve(extension,name);assert.ok(target.startsWith(extension+sep));
   await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);
  }
 }else await cp('dist',resolve(dir,'extension'),{recursive:true});
 if(!online)await localManifest();
 let a=await desktop(0),b=await desktop(1);
 assert.equal((await a.call('create',{name:'Windows A · Chrome'})).pair.view,'invite');
 const transport=await auditRoom(a);
 // create has already opened the invitation; pair() deliberately regenerates a fresh mailbox.
 await pair(a,b,'Windows B · Chrome');result.checks.push('two actual MV3 profiles pair via B-entered code');
 const androidDirectory=upgrade?resolve(dir,'android-home'):resolve('dist-android');
 if(upgrade){assert.ok(process.env.KJ_OLD_ANDROID_DIR,'old Android directory required');await cp(process.env.KJ_OLD_ANDROID_DIR,androidDirectory,{recursive:true});}
 const home=await homeServer(androidDirectory,process.env.KJ_EDGE_TEST_PORT?0:4193);servers.push({kill:()=>home.close()});
 const browser=await launchChrome({args:[],...(online?{proxy:{server:'http://127.0.0.1:10808'}}:{})});servers.push({kill:()=>browser.close()});
 const context=await browser.newContext(mobileOptions);contexts.push(context);await nativeMock(context);await context.addInitScript(iceScript);await context.route(/^https:\/\/(?:kongjing\.inc\.re|sync\.example\.com)\/v[12]\/icon\?/,async route=>route.fulfill({contentType:'image/webp',body:await readFile('tests/fixtures/github.webp')}));
 const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));
 await context.route('https://appassets.androidplatform.net/home/**',async route=>{const path=new URL(route.request().url()).pathname.replace('/home','');const response=await fetch(home.base.replace('/index.html',path));await route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type')},body:Buffer.from(await response.arrayBuffer())});});
 await page.goto(online?'https://appassets.androidplatform.net/home/index.html':home.base.replace('127.0.0.1','localhost'));await page.waitForFunction(()=>!!window.kongjing);
 let phone=await bindPhone(page,context,androidDirectory);devices.push(phone);
 await phone.call('relay',{url});await pair(a,phone,'Pixel · 空境');
 await until(()=>Promise.all(devices.map(d=>d.status())),v=>v.every(s=>s.status.devices.length===3&&s.status.devices.filter(d=>!d.self).every(d=>d.transport==='direct')),'three-device direct mesh',90000);
 result.checks.push('two offscreen WebRTC hosts + mobile page direct mesh; origin='+new URL(page.url()).origin);
 if(upgrade){
  const oldTitle='retained-231-'+result.startedAt,phoneTitle='retained-android-231-'+result.startedAt;
  await add(a,oldTitle);await add(phone,phoneTitle);
  await page.evaluate(async()=>{await globalThis.__v3Store.getState().setting('smoothFirst',true);});
  await until(()=>Promise.all(devices.map(d=>d.data())),rows=>rows.every(data=>data.settings.smoothFirst&&[oldTitle,phoneTitle].every(title=>data.bookmarks.some(b=>b.title===title))),'old-version customized settings and bookmarks converge');
  await Promise.all(devices.map(d=>d.call('sync')));
  const oldData=await Promise.all(devices.map(d=>d.data()));
  const oldGroups=await Promise.all(devices.map(d=>readSecret(d,'group')));
  const oldIdentities=await Promise.all(devices.map(d=>readSecret(d,'identity')));
  const oldMain=phone.mainFile;
  await page.goto('about:blank');
  await a.context.close();await b.context.close();
  for(const index of [0,1]){
   const cache=resolve(dir,'profile-'+index+'/Default/Service Worker');
   assert.ok(cache.startsWith(dir+sep));await rm(cache,{recursive:true,force:true});
  }
  // Preserve profiles, Chrome storage, localStorage and IndexedDB; replace code only.
  for(const [target,source]of [[resolve(dir,'extension'),'dist'],[androidDirectory,'dist-android']]){
   assert.ok(target.startsWith(dir+sep));await rm(target,{recursive:true,force:true});await cp(source,target,{recursive:true});
  }
  await localManifest();devices.length=0;
  a=await desktop(0);b=await desktop(1);
  await page.goto(home.base.replace('127.0.0.1','localhost')+'?upgrade=232');await page.waitForFunction(()=>!!window.kongjing);
  phone=await bindPhone(page,context,androidDirectory);devices.push(phone);
  assert.notEqual(phone.mainFile,oldMain,'phone must load the new production bundle');
  await until(()=>Promise.all(devices.map(d=>d.status())),rows=>rows.every(s=>s.status.paired&&s.status.devices.length===3),'upgrade retains three paired members');
  await until(()=>Promise.all(devices.map(d=>d.status())),rows=>rows.every(s=>s.status.devices.filter(d=>!d.self).every(d=>d.transport==='direct')),'upgraded three-device direct mesh');
  for(let i=0;i<devices.length;i++){
   const device=devices[i],data=await device.data(),group=await readSecret(device,'group'),identity=await readSecret(device,'identity');
   for(const key of ['settings','profile','groups'])assert.deepEqual(data[key],oldData[i][key],'upgrade keeps '+key+' on device '+i);
   const bookmarks=data=>data.bookmarks.map(b=>({id:b.id,url:b.url,title:b.title,groupId:b.groupId})).sort((a,b)=>a.id.localeCompare(b.id));
   assert.deepEqual(bookmarks(data),bookmarks(oldData[i]),'upgrade keeps all bookmarks');
   assert.equal(group.gk,oldGroups[i].gk);assert.equal(group.epoch,oldGroups[i].epoch);
   assert.deepEqual(group.members.map(m=>m.deviceId).sort(),oldGroups[i].members.map(m=>m.deviceId).sort());
   assert.equal(identity.deviceId,oldIdentities[i].deviceId);
   if(!device.phone)assert.equal(await device.page.evaluate(()=>chrome.runtime.getManifest().version),'2.3.2');
  }
  result.upgrade={from:'2.3.1',to:'2.3.2',devices:3,dataPreserved:true,settingsPreserved:true,groupKeyEpochAndIdentityPreserved:true,noRePair:true,method:'same desktop profile paths and same phone origin/IndexedDB; overwrite code and clear only isolated desktop service-worker code caches'};
  result.checks.push('2.3.1 → 2.3.2 actual overwrite upgrade retains all bookmarks/settings/profile/groups/GK/epoch/device IDs on two MV3 profiles and Android IndexedDB, without re-pairing');
 }
 if(regression){
  await Promise.all(devices.map(d=>d.call('sync')));
  await b.cdp.evaluate(`globalThis.__originalSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(...args) {
      const result = Reflect.apply(globalThis.__originalSend, chrome.runtime, args);
      const message = args[0];
      if (!globalThis.__atomicHeld && message?.type === 'kj:host-storage' && message.action === 'get' && message.key === 'data') {
        globalThis.__atomicHeld = true;
        return result.then(async value => { globalThis.__atomicRead = true; await new Promise(r => globalThis.__atomicRelease = r); return value; });
      }
      return result;
    };`);
  const remoteTitle='deterministic-remote-'+result.startedAt,localTitle='deterministic-local-'+result.startedAt;
  await add(a,remoteTitle);
  await until(()=>b.cdp.evaluate('globalThis.__atomicRead === true'),Boolean,'real offscreen read paused inside v3.3 lock',10000);
  let acknowledged=false;
  const localWrite=add(b,localTitle).then(()=>{acknowledged=true;});
  await new Promise(r=>setTimeout(r,200));
  assert.equal(acknowledged,false,'MV3 collection cannot acknowledge while remote load/merge holds the shared lock');
  await b.cdp.evaluate('globalThis.__atomicRelease(); chrome.runtime.sendMessage = globalThis.__originalSend;');
  await localWrite;
  await until(()=>Promise.all(devices.map(d=>d.data())),v=>v.every(data=>[remoteTitle,localTitle].every(title=>data.bookmarks.some(b=>b.title===title))),'deterministic overlapping writes retain both',20000);
  result.checks.push('deterministic real MV3 offscreen read delay + concurrent toolbar collection: no early success; both local/remote bookmarks retained');
 }
 let start=Date.now();await add(a,'v3-desktop-'+result.startedAt);await until(()=>received(phone,'v3-desktop-'+result.startedAt),Boolean,'desktop to phone');result.timings.desktopToPhone=Date.now()-start;
 start=Date.now();await add(phone,'v3-phone-'+result.startedAt);await until(()=>received(b,'v3-phone-'+result.startedAt),Boolean,'phone to desktop');result.timings.phoneToDesktop=Date.now()-start;
 result.checks.push('real bidirectional encrypted bookmark synchronization');
 if(regression){
  const titles=[];
  for(let i=0;i<12;i++){
   const batch=devices.map((d,n)=>'atomic-'+n+'-'+i+'-'+result.startedAt);titles.push(...batch);
   await Promise.all(devices.map((d,n)=>add(d,batch[n])));
  }
  await until(()=>Promise.all(devices.map(d=>d.data())),v=>v.every(data=>titles.every(title=>data.bookmarks.some(b=>b.title===title))),'36 concurrent local + remote writes converge',60000);
  await new Promise(r=>setTimeout(r,20000));
  const snapshots=await Promise.all(devices.map(d=>d.data()));
  assert.ok(snapshots.every(data=>titles.every(title=>data.bookmarks.some(b=>b.title===title))));
  result.atomic={titles:titles.length,retainedAfterMs:20000,counts:snapshots.map(data=>data.bookmarks.filter(b=>titles.includes(b.title)).length)};
  result.checks.push('2 real chrome.storage profiles + Android IndexedDB: 36 concurrent collections retained on every device after 20 seconds');
 }

 // Force ICE negotiation failure without replacing the protocol or transport implementation.
 await Promise.all(devices.map(async(d)=>{
  if(d.phone)await d.page.evaluate(()=>{globalThis.__forceRelay=true;});else await d.cdp.evaluate('globalThis.__forceRelay=true');
  await d.call('configure',{turnUser:'qa-force-relay'});
 }));
 await until(()=>Promise.all(devices.map(d=>d.status())),v=>v.every(s=>s.status.transport==='relay'),'fallback transport');
 start=Date.now();await add(a,'v3-fallback-'+result.startedAt);await until(()=>received(phone,'v3-fallback-'+result.startedAt),Boolean,'fallback delivery',30000);result.timings.fallback=Date.now()-start;
 result.checks.push('forced real RTC negotiation failure falls back to encrypted Edge object/watch transport');
 await bridgeCall(page,'setVisible',{visible:false});
 await phone.context.setOffline(true);
 const offlineTitle='v3-offline-'+result.startedAt;
 await add(a,offlineTitle);await new Promise(r=>setTimeout(r,500));
 assert.equal(await received(phone,offlineTitle),false);
 start=Date.now();await phone.context.setOffline(false);await bridgeCall(page,'setVisible',{visible:true});
 await until(()=>received(phone,offlineTitle),Boolean,'offline foreground catchup',30000);result.timings.offlineCatchup=Date.now()-start;
 result.checks.push('Android offline then native foreground catches up encrypted server state');
 await Promise.all(devices.map(async(d)=>{
  if(d.phone)await d.page.evaluate(()=>{globalThis.__forceRelay=false;});else await d.cdp.evaluate('globalThis.__forceRelay=false');
  await d.call('configure',{turnUser:''});
 }));
 await until(()=>Promise.all(devices.map(d=>d.status())),v=>v.every(s=>s.status.devices.filter(d=>!d.self).every(d=>d.transport==='direct')),'restored direct mesh');
 await Promise.all(devices.map(d=>d.call('sync')));
 await Promise.all(devices.map(d=>d.call('configure',{directOnly:'true'})));
 const objects=(await transport.list()).objects.map(o=>o.key);
 assert.equal(objects.some(k=>k.startsWith('d/')||k.startsWith('b/')),false,'direct-only retains no business objects');
 start=Date.now();await add(phone,'v3-only-direct-'+result.startedAt);await until(()=>received(b,'v3-only-direct-'+result.startedAt),Boolean,'direct-only delivery');result.timings.directOnly=Date.now()-start;
 assert.equal((await transport.list()).objects.some(o=>/^(d|b)\//.test(o.key)),false);
 result.checks.push('all three direct-only: P2P delivered and server holds no state/history/event/tabs/presence/blob objects');
 // The same visibility path used by native setVisible reaches the live v3.1 engine.
 await bridgeCall(page,'setVisible',{visible:false});await new Promise(r=>setTimeout(r,500));await bridgeCall(page,'setVisible',{visible:true});
 result.checks.push('native setVisible and desktop visibility ports are connected to setForeground');
 await mkdir(evidence,{recursive:true});
 await a.page.screenshot({path:evidence+'/desktop-direct.png'});
 await phone.page.screenshot({path:evidence+'/android-direct.png'});
 assert.deepEqual(result.errors,[]);
 result.passed=true;

}catch(e){result.passed=false;result.error=e.stack;console.error(e);process.exitCode=1;}
finally{
 result.statuses=await Promise.all(devices.map(d=>d.status().catch(()=>null)));
 await mkdir(evidence,{recursive:true});await writeFile(evidence+'/'+(online?'online':'local')+'.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,statuses:result.statuses?.map(s=>s?{paired:s.status.paired,transport:s.status.transport,members:s.status.devices.length,pair:s.pair?.view}:null)},null,2));
 for(const c of contexts)await c.close().catch(()=>{});
 if(online)for(const g of groups){const reader=new TransportEdge(g.keys.roomId,g.keys.roomToken,g.slot,{url,fetch:network});for(const object of (await reader.list()).objects){const owner=/^(?:d|sig)\/([^/]+)\//.exec(object.key)?.[1]||g.slot;await new TransportEdge(g.keys.roomId,g.keys.roomToken,owner,{url,fetch:network}).delete(object.key);}result.cleanupRemaining=(await reader.list()).objects.length;}
 for(const s of servers)await s.kill();await proxyAgent?.close();
 await writeFile(evidence+'/'+(online?'online':'local')+'.json',JSON.stringify(result,null,2));
}
