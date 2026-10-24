import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchChrome,launchExtension} from './browser.mjs';
import {homeServer} from './android-server.mjs';
import {mobileOptions,nativeMock,bridgeCall} from './android-fixtures.mjs';
process.env.KJ_BLOCK_ONLINE_RELAY='1';process.env.KJ_STORE_OFFLINE_ONLY='1';
const output='../docs/v6/v331-evidence';await mkdir(output,{recursive:true});
const result={startedAt:new Date().toISOString(),checks:[],errors:[]};
const browser=await launchChrome(),home=await homeServer('dist-android-qa',4198);
const profile=await mkdtemp(resolve('tests/.lost-update-chrome-'));
const desktop=await launchExtension(profile,resolve('dist-qa'));
try {
 for(const kind of ['IndexedDB','chrome.storage']) {
  const context=kind==='IndexedDB'?await browser.newContext(mobileOptions):desktop;
  if(kind==='IndexedDB')await nativeMock(context);
  const url=kind==='IndexedDB'?home.base:'chrome-extension://agijcmabomapmbobdgblmckibkpobdij/index.html';
  const a=await context.newPage(),b=await context.newPage();
  for(const page of [a,b]){page.on('pageerror',e=>result.errors.push(e.message));await page.goto(url);await page.waitForFunction(()=>!!window.kjTest);}
  await a.waitForTimeout(1200);
  // This gate is inside the SAME actual Web Lock as the protocol's v3.3 callback.
  await a.evaluate(()=>{
   window.__remoteDone=window.kjTest.withAppDataLock(async()=>{
    const latest=await window.kjTest.appData.read();
    window.__held=true;await new Promise(r=>window.__release=r);
    latest.bookmarks.push({id:'remote-held',title:'远端并发',url:'https://example.com/remote-held',groupId:latest.groups[0].id,order:90,icon:{mode:'letter'},createdAt:Date.now(),updatedAt:Date.now()});
    await window.kjTest.storage.set('data',latest);
   });
  });
  await a.waitForFunction(()=>window.__held);
  await b.evaluate(()=>{
   window.__ack=false;
   window.__localDone=window.kjTest.getState().update(data=>{
    data.bookmarks.push({id:'local-held',title:'本机并发',url:'https://example.com/local-held',groupId:data.groups[0].id,order:91,icon:{mode:'letter'},createdAt:Date.now(),updatedAt:Date.now()});
   }).then(()=>window.__ack=true);
  });
  assert.equal(await b.evaluate(()=>window.__ack),false,'no success before durable commit');
  await a.evaluate(()=>window.__release());
  await Promise.all([a.evaluate(()=>window.__remoteDone),b.evaluate(()=>window.__localDone)]);
  const persisted=await b.evaluate(()=>window.kjTest.appData.read());
  assert.ok(persisted.bookmarks.some(b=>b.id==='remote-held'));
  assert.ok(persisted.bookmarks.some(b=>b.id==='local-held'));
  await b.reload();await b.waitForFunction(()=>!!window.kjTest);await b.waitForTimeout(1000);
  const reloaded=await b.evaluate(()=>window.kjTest.appData.read());
  assert.ok(reloaded.bookmarks.some(b=>b.id==='local-held'));
  result.checks.push(kind+': real cross-context Web Lock, delayed remote write + local update, durable ack, reload retains both');
  if(kind==='IndexedDB'){
   const reply=await bridgeCall(b,'addBookmark',{url:'https://example.com/native-durable',title:'原生真实落盘'});
   assert.ok(reply.ok);
   assert.ok((await b.evaluate(()=>window.kjTest.appData.read())).bookmarks.some(b=>b.title==='原生真实落盘'));
   result.checks.push('native addBookmark acknowledges only after IndexedDB commit');
   await b.evaluate(()=>{
    window.__rawSet=window.kjTest.storage.set;
    window.kjTest.storage.set=async(key,...args)=>{if(key==='data')throw Error('QA_QUOTA');return window.__rawSet(key,...args);};
   });
   const failed=await bridgeCall(b,'addBookmark',{url:'https://example.com/native-failed',title:'不能误报成功'});
   assert.equal(failed.ok,false);assert.equal(failed.error,'QA_QUOTA');
   await b.evaluate(()=>window.kjTest.storage.set=window.__rawSet);
   assert.equal((await b.evaluate(()=>window.kjTest.appData.read())).bookmarks.some(b=>b.title==='不能误报成功'),false);
   result.checks.push('native addBookmark returns failure on injected durable IndexedDB write error');
   await context.close();
  }
 }
 assert.deepEqual(result.errors,[]);result.passed=true;
}catch(e){result.passed=false;result.error=e.stack;process.exitCode=1;}
finally{await desktop.close();await browser.close();await home.close();await writeFile(output+'/lost-update-browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
