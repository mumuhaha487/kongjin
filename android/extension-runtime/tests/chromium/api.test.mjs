import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { TestBridge, init, ID } from '../bridge.mjs';
let browser, server, base;
before(async () => {
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Fixture</title><body><div id=fixture>Ready</div>' + (req.url === '/frames' ? '<iframe src="/child"></iframe><iframe src="/child2"></iframe>' : '') + '</body>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); server?.close(); });
async function harness(type = 'page', id = ID) {
  const context = await browser.newContext(); const bridge = new TestBridge(); await bridge.attach(context);
  await init(context, { id, type, manifest: { manifest_version: 3, name: 'Contract', version: '1' }, hosts: ['https://permitted.test/*'], messages: { welcome: { message: '你好 $WHO$!', placeholders: { who: { content: '$1' } } } } });
  const page = await context.newPage(); await page.goto(base); await page.waitForFunction(() => __runtime.chrome.runtime.id); return { context, page, bridge };
}
test('Promise/callback storage, defaults, onChanged and removal values', async () => {
  const { context, page } = await harness();
  const result = await page.evaluate(async () => {
    const c = __runtime.chrome; const changes = []; c.storage.onChanged.addListener((diff, area) => changes.push([diff, area]));
    const returned = await c.storage.local.set({ answer: 42 });
    const promise = await c.storage.local.get({ answer: 0, fallback: 9 });
    const callback = await new Promise(resolve => c.storage.local.get('answer', resolve));
    await c.storage.local.remove('answer');
    return { promise, callback, changes, undefinedResult: returned === undefined, alias: __runtime.browser === c };
  });
  assert.deepEqual(result.promise, { answer: 42, fallback: 9 }); assert.deepEqual(result.callback, { answer: 42 }); assert.equal(result.undefinedResult, true); assert.equal(result.alias, true);
  assert.deepEqual(result.changes, [[{ answer: { newValue: 42 } }, 'local'], [{ answer: { oldValue: 42 } }, 'local']]); await context.close();
});
test('lastError is callback-scoped and missing receiver rejects Promise', async () => {
  const { context, page } = await harness();
  const result = await page.evaluate(async () => {
    const c = __runtime.chrome; let during; await new Promise(resolve => c.runtime.sendMessage({ ping: true }, () => { during = c.runtime.lastError?.message; resolve(); }));
    let rejected = ''; try { await c.runtime.sendMessage({ ping: true }); } catch (e) { rejected = e.message; }
    return { during, after: c.runtime.lastError === undefined, rejected };
  });
  assert.match(result.during, /Receiving end does not exist/); assert.equal(result.after, true); assert.equal(result.rejected, result.during); await context.close();
});
test('sendResponse async true, Promise listener and first response wins', async () => {
  const { context, page } = await harness(); const background = await context.newPage(); await background.goto(base + '/background');
  await background.evaluate(() => { __runtime.chrome.runtime.onMessage.addListener((message, sender, respond) => { if (message.type === 'promise') return Promise.resolve({ kind: 'promise', sender: sender.id }); setTimeout(() => { respond({ kind: 'async' }); respond('second'); }, 5); return true; }); });
  assert.deepEqual(await page.evaluate(() => __runtime.chrome.runtime.sendMessage({ type: 'async' })), { kind: 'async' });
  assert.deepEqual(await page.evaluate(() => __runtime.chrome.runtime.sendMessage({ type: 'promise' })), { kind: 'promise', sender: ID }); await context.close();
});
test('sendResponse null remains null; unhandled message resolves undefined', async () => {
  const { context, page } = await harness(); const background = await context.newPage(); await background.goto(base + '/background');
  await background.evaluate(() => __runtime.chrome.runtime.onMessage.addListener((m, s, r) => { if (m === 'null') r(null); }));
  assert.equal(await page.evaluate(() => __runtime.chrome.runtime.sendMessage('null')), null);
  assert.equal(await page.evaluate(async () => (await __runtime.chrome.runtime.sendMessage({ unhandled: true })) === undefined), true); await context.close();
});
test('Port messages and disconnect propagate between documents', async () => {
  const { context, page } = await harness(); const background = await context.newPage(); await background.goto(base + '/background');
  await background.evaluate(() => __runtime.chrome.runtime.onConnect.addListener(p => p.onMessage.addListener(m => p.postMessage({ echo: m, name: p.name }))));
  const result = await page.evaluate(() => new Promise(resolve => { const p = __runtime.chrome.runtime.connect({ name: 'test' }); p.onMessage.addListener(m => { p.disconnect(); resolve(m); }); p.postMessage('hello'); }));
  assert.deepEqual(result, { echo: 'hello', name: 'test' }); await context.close();
});
test('tabs lifecycle events keep created/activated/updated order', async () => {
  const { context, page } = await harness(); const order = await page.evaluate(async () => { const c = __runtime.chrome, order = []; c.tabs.onCreated.addListener(() => order.push('created')); c.tabs.onActivated.addListener(() => order.push('activated')); c.tabs.onUpdated.addListener(() => order.push('updated')); await c.tabs.create({ url: 'https://new.test/' }); return order; });
  assert.deepEqual(order, ['created', 'activated', 'updated']); await context.close();
});
test('executeScript serializes func/args and returns InjectionResult array', async () => {
  const { context, page } = await harness(); const result = await page.evaluate(() => __runtime.chrome.scripting.executeScript({ target: { tabId: 1 }, func: (a, b) => ({ sum: a + b, title: document.title }), args: [2, 3] }));
  assert.deepEqual(result, [{ frameId: 0, result: { sum: 5, title: 'Fixture' } }]); await context.close();
});
test('content environment omits privileged APIs and does not modify window.chrome', async () => {
  const { context, page } = await harness('content'); const result = await page.evaluate(() => ({ tabs: typeof __runtime.chrome.tabs, action: typeof __runtime.chrome.action, storage: typeof __runtime.chrome.storage.local.get, globalId: window.chrome?.runtime?.id, localId: __runtime.chrome.runtime.id }));
  assert.equal(result.tabs, 'undefined'); assert.equal(result.action, 'undefined'); assert.equal(result.storage, 'function'); assert.equal(result.globalId, undefined); assert.equal(result.localId, ID); await context.close();
});
test('bridge object is deleted immediately; a captured channel still works', async () => {
  const { context, page } = await harness(); const result = await page.evaluate(() => { let sent; window.__secretBridge = { postMessage(v) { sent = v; } }; const captured = KJRuntime.captureBridge('__secretBridge'); captured.postMessage('captured'); return { removed: !('__secretBridge' in window), sent }; }); assert.deepEqual(result, { removed: true, sent: 'captured' }); await context.close();
});
test('document_start/end/idle share lexical variables and obey DOM readiness', async () => {
  const { context, page } = await harness('content');
  await context.addInitScript(() => { globalThis.__stages = []; const scripts = [
    { matches: ['<all_urls>'], run_at: 'document_start', jsText: 'let shared=41;window.__stages.push(["start",document.readyState]);' },
    { matches: ['<all_urls>'], run_at: 'document_end', jsText: 'window.__stages.push(["end",++shared,document.readyState]);' },
    { matches: ['<all_urls>'], run_at: 'document_idle', jsText: 'window.__stages.push(["idle",shared,document.readyState]);' }
  ]; KJRuntime.runContent(__runtime, scripts); });
  await page.goto(base + '/order'); await page.waitForFunction(() => __stages.length === 3); const stages = await page.evaluate(() => __stages);
  assert.equal(stages[0][0], 'start'); assert.equal(stages[0][1], 'loading'); assert.deepEqual(stages.map(s => s[0]), ['start', 'end', 'idle']); assert.equal(stages[1][1], 42); assert.equal(stages[2][1], 42); await context.close();
});
test('all_frames false skips subframes; true includes every frame', async () => {
  const { context, page } = await harness('content');
  await context.addInitScript(() => KJRuntime.runContent(__runtime, [{ matches: ['<all_urls>'], run_at: 'document_start', jsText: 'window.__topOnly=true;' }, { matches: ['<all_urls>'], all_frames: true, run_at: 'document_start', jsText: 'window.__everyFrame=true;' }]));
  await page.goto(base + '/frames'); assert.equal(page.frames().length, 3);
  const values = await Promise.all(page.frames().map(f => f.evaluate(() => [!!window.__topOnly, !!window.__everyFrame]))); assert.deepEqual(values, [[true, true], [false, true], [false, true]]); await context.close();
});
test('host permission fetch and XHR use native transport; page fetch is unchanged', async () => {
  const { context, page } = await harness(); const result = await page.evaluate(async () => { const before = fetch; KJRuntime.installNetwork(__runtime); const text = await (await fetch('https://permitted.test/cors')).text(); const xhr = await new Promise(resolve => { const x = new XMLHttpRequest(); x.open('GET', 'https://permitted.test/xhr'); x.onload = () => resolve([x.status, x.responseText]); x.send(); }); return { text, xhr, wrapped: before !== fetch }; });
  assert.deepEqual(result, { text: 'native response', xhr: [200, 'native response'], wrapped: true }); await context.close();
});

test('Document facade supports native Node arguments without exporting chrome', async () => {
  const { context, page } = await harness('content');
  await page.evaluate(async () => KJRuntime.runContent(__runtime, [{ matches: ['<all_urls>'], runAt: 'document_end', jsText: 'window.__nativeNode=[document.createTreeWalker(document).root.nodeType,document.contains(document.documentElement),globalThis.chrome.runtime.id];' }]));
  assert.deepEqual(await page.evaluate(() => __nativeNode), [9, true, ID]);
  assert.equal(await page.evaluate(() => window.chrome?.runtime?.id), undefined);
  await context.close();
});

test('registered camelCase allFrames/runAt/excludeMatches follow manifest behavior', async () => {
  const { context, page } = await harness('content');
  await context.addInitScript(() => KJRuntime.runContent(__runtime, [{ matches: ['<all_urls>'], allFrames: true, runAt: 'document_start', excludeMatches: ['*://*/child2'], jsText: 'window.__registered=document.readyState;' }]));
  await page.goto(base + '/frames');
  assert.deepEqual(await Promise.all(page.frames().map(f => f.evaluate(() => window.__registered || 'excluded'))), ['loading','loading','excluded']);
  await context.close();
});

test('native MAIN injection accepts return and rejects non-cloneable results', async () => {
  const { context, page } = await harness('content');
  const results = await page.evaluate(async () => {
    const replies=[];const r=KJRuntime.createRuntime({id:'test',type:'content',manifest:{}},{postMessage(s){replies.push(JSON.parse(s))}});
    r.receive({v:1,kind:'hello',endpoint:'main'});
    r.receive({v:1,kind:'inject',id:'one',world:'MAIN',functionBody:true,code:'return {value: 42, api: typeof window.chrome?.runtime};'});
    r.receive({v:1,kind:'inject',id:'two',world:'MAIN',functionBody:true,code:'return document.body;'});
    await new Promise(resolve=>setTimeout(resolve,50));return replies.filter(x=>x.kind==='injectionResult');
  });
  assert.deepEqual(results.find(r=>r.id==='one').value,{value:42,api:'undefined'});
  assert.match(results.find(r=>r.id==='two').error,/clone/i);await context.close();
});

test('synchronous same-origin XHR stays usable for importScripts', async () => {
  const { context, page } = await harness();
  const text=await page.evaluate(()=>{KJRuntime.installNetwork(__runtime);const x=new XMLHttpRequest();x.open('GET','/sync',false);x.send();return x.responseText;});
  assert.match(text,/Fixture/);await context.close();
});

test('literal document-start executor runs under strict CSP without unsafe-eval', async () => {
  const { context, page } = await harness('content');
  await context.route('https://strict.test/**',route=>route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"script-src 'self'; object-src 'none'"},body:'<!doctype html><title>CSP</title><p>protected page</p>'}));
  await context.addInitScript(()=>KJRuntime.runContent(__runtime,[{matches:['<all_urls>'],run_at:'document_start'}],window,async function(chrome,browser,window,self,globalThis,document,MutationObserver,end,idle){let shared=41;window.__cspStart=document.readyState;await end;window.__cspEnd=++shared;await idle;window.__cspDone=chrome.runtime.id;}));
  await page.goto('https://strict.test/');await page.waitForFunction(()=>window.__cspDone);
  assert.deepEqual(await page.evaluate(()=>[__cspStart,__cspEnd,__cspDone]),['loading',42,ID]);await context.close();
});

test('extension timers pause and resume without pausing page timers', async () => {
  const {context,page}=await harness();
  const result=await page.evaluate(async()=>{
    const wait=ms=>new Promise(resolve=>nativeWait(resolve,ms));const nativeWait=setTimeout.bind(window);
    KJRuntime.installBackground(__runtime);let ticks=0;const timer=setInterval(()=>ticks++,10);
    await wait(40);__runtime.receive({v:1,kind:'event',api:'_host.visibility',args:[false]});const stopped=ticks;
    await wait(60);const paused=ticks===stopped;__runtime.receive({v:1,kind:'event',api:'_host.visibility',args:[true]});await wait(40);clearInterval(timer);
    return {paused,resumed:ticks>stopped};
  });assert.deepEqual(result,{paused:true,resumed:true});await context.close();
});
