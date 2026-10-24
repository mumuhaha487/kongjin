import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchExtension} from './browser.mjs';
process.env.KJ_BLOCK_ONLINE_RELAY='1';process.env.KJ_STORE_OFFLINE_ONLY='1';
const c=await launchExtension(await mkdtemp(resolve('tests/.v3-offscreen-')),resolve('../release/unpacked'));
const result={passed:false,errors:[]};
async function until(fn,predicate,label){for(let i=0;i<100;i++){const r=await fn();if(predicate(r))return r;await new Promise(r=>setTimeout(r,100));}throw Error(label);}
try{
 const p=await c.newPage();p.on('pageerror',e=>result.errors.push(e.message));await p.goto('chrome-extension://agijcmabomapmbobdgblmckibkpobdij/index.html');await p.getByRole('textbox',{name:'搜索',exact:true}).waitFor();await p.evaluate(()=>chrome.runtime.sendMessage({type:'kj:pair',action:'status'}));
 const root=await c.browser().newBrowserCDPSession();
 const info=await root.send('Target.getTargets');assert.equal(info.targetInfos.filter(t=>t.url.endsWith('/offscreen.html')).length,1);
 const {sessionId}=await root.send('Target.attachToTarget',{targetId:info.targetInfos.find(t=>t.url.endsWith('/offscreen.html')).targetId,flatten:false});
 let next=0;const pending=new Map();root.on('Target.receivedMessageFromTarget',({sessionId:s,message})=>{if(s!==sessionId)return;const data=JSON.parse(message);if(data.id){pending.get(data.id)?.(data);pending.delete(data.id);}});
 const evalHost=async expression=>{const command=++next;const promise=new Promise(resolve=>pending.set(command,resolve));await root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:command,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}})});const r=await promise;if(r.result.exceptionDetails)throw Error(r.result.exceptionDetails.text);return r.result.result.value;};
 await evalHost(`globalThis.__foregroundEvents=[];chrome.runtime.onMessage.addListener(m=>{if(m.type==='kj:host-rpc'&&m.action==='foreground')globalThis.__foregroundEvents.push(m.args.visible);});`);
 await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await until(()=>evalHost('globalThis.__foregroundEvents'),r=>r.at(-1)==='true','visible-page state');
 const before=await evalHost('globalThis.__foregroundEvents.length');
 const pageCdp=await c.newCDPSession(p);let versions=[];pageCdp.on('ServiceWorker.workerVersionUpdated',e=>versions.push(...e.versions));await pageCdp.send('ServiceWorker.enable');
 const worker=await until(async()=>versions.find(v=>v.scriptURL.endsWith('/background.js')&&v.runningStatus==='running'),Boolean,'worker version');
 await pageCdp.send('ServiceWorker.stopWorker',{versionId:worker.versionId});
 const events=await until(()=>evalHost('globalThis.__foregroundEvents'),r=>r.length>before&&r.at(-1)==='true','foreground port reconnect after worker restart');
 const after=await root.send('Target.getTargets');assert.equal(after.targetInfos.filter(t=>t.url.endsWith('/offscreen.html')).length,1);
 result.foregroundEvents=events;result.oneOffscreenAfterRestart=true;assert.deepEqual(result.errors,[]);result.passed=true;
}finally{await c.close();await writeFile((process.env.KJ_EVIDENCE||'../docs/v6/v331-evidence')+'/offscreen-restart.json',JSON.stringify(result,null,2));}
console.log(JSON.stringify(result,null,2));
