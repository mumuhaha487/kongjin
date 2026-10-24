import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import sharp from 'sharp';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {mobileOptions,nativeMock,bridgeCall} from './android-fixtures.mjs';
const root='../docs/v6';await mkdir(root+'/traces',{recursive:true});
const server=await homeServer('dist-android',4204);
const browser=await chromium.launch({executablePath:'tests/.browser/chrome-win/chrome.exe',args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND']});
const results=[],errors=[];
async function trace(page,cdp,name,wait) {
 await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing',transferMode:'ReturnAsStream'});
 const start=performance.now();await page.waitForTimeout(wait);const elapsed=performance.now()-start;
 const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const {stream}=await done;
 let raw='';for(;;){const chunk=await cdp.send('IO.read',{handle:stream});raw+=chunk.data;if(chunk.eof)break}await cdp.send('IO.close',{handle:stream});
 await writeFile(root+'/traces/'+name+'.json.gz',gzipSync(raw));
 const events=JSON.parse(raw).traceEvents;const main=events.find(e=>e.name==='thread_name'&&e.args?.name==='CrRendererMain');
 const es=events.filter(e=>e.pid===main.pid&&e.tid===main.tid&&e.ph==='X');
 const tasks=es.filter(e=>/^(RunTask|ThreadControllerImpl::RunTask)$/.test(e.name)).map(e=>[e.ts,e.ts+e.dur]).sort((a,b)=>a[0]-b[0]);
 let busy=0,end=0;for(const [s,t]of tasks){busy+=Math.max(0,t-Math.max(s,end));end=Math.max(end,t)}
 const metric={name,elapsedMs:+elapsed.toFixed(2),busyPercent:+(busy/1000/elapsed*100).toFixed(3),gcMs:+es.filter(e=>e.name==='MajorGC'||e.name==='MinorGC').reduce((s,e)=>s+e.dur/1000,0).toFixed(3),drawFrames:events.filter(e=>e.name==='DrawFrame'&&e.pid===main.pid).length,paintMs:+es.filter(e=>e.name==='Paint').reduce((s,e)=>s+e.dur/1000,0).toFixed(3),timerCallbacks:es.filter(e=>e.name==='TimerFire').length};
 results.push(metric);console.log(metric);return metric;
}
try {
 const context=await browser.newContext(mobileOptions);await nativeMock(context);await setup(context,fixture('dark'));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.clock.setFixedTime(new Date('2026-10-24T12:51:00+08:00'));
 const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});
 await page.goto(server.base);await page.waitForFunction(()=>window.kongjing);await page.waitForTimeout(3500);
 const activityAt=await page.evaluate(()=>{document.dispatchEvent(new Event('touchstart'));return performance.now()});
 await page.evaluate(()=>{
  window.__ambientWrites=[];const nodes=[...document.querySelectorAll('.cloud-wave,.twinkle-layer,.clock-spark,.colon')];
  window.__ambientObserver=new MutationObserver(rows=>{window.__ambientWrites.push({at:performance.now(),elements:[...new Set(rows.map(r=>nodes.indexOf(r.target)))].length});});
  for(const node of nodes)window.__ambientObserver.observe(node,{attributes:true,attributeFilter:['style']});
 });
 await page.waitForTimeout(2200);
 const writes=await page.evaluate(()=>{window.__ambientObserver.disconnect();return window.__ambientWrites});
 const buckets=new Map();for(const row of writes){const key=Math.floor((row.at-writes[0].at)/1000);buckets.set(key,(buckets.get(key)||0)+1)}
 assert.ok(Math.max(...buckets.values())<=30);assert.ok(writes.every(r=>r.elements<=6));
 await trace(page,cdp,'ambient-active-6x',5000);
 // Last activity is the navigation; wait beyond the complete 20s+1.2s idle ramp.
 const remaining=await page.evaluate(at=>Math.max(0,at+23000-performance.now()),activityAt);await page.waitForTimeout(remaining);
 const frozenStyles=await page.locator('.cloud-wave,.twinkle-layer,.clock-spark,.colon').evaluateAll(es=>es.map(e=>e.getAttribute('style')));
 const first=await page.screenshot({path:root+'/screenshots/ambient-frozen-start.png'});
 await page.waitForTimeout(1200);
 const second=await page.screenshot({path:root+'/screenshots/ambient-frozen-after.png'});
 const a=await sharp(first).removeAlpha().raw().toBuffer(),b=await sharp(second).removeAlpha().raw().toBuffer();
 let changed=0,maxDelta=0,totalDelta=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);changed+=d>0;maxDelta=Math.max(maxDelta,d);totalDelta+=d;}
 console.log('frozen pixels',{changed,maxDelta,mean:totalDelta/a.length});
 const diagnostic=await page.evaluate(()=>({now:performance.now(),styles:[...document.querySelectorAll('.cloud-wave,.twinkle-layer,.clock-spark,.colon')].map(e=>({class:e.getAttribute('class'),style:e.getAttribute('style')})),animations:document.getAnimations().filter(a=>a.playState==='running').map(a=>({target:a.effect?.target?.getAttribute?.('class'),time:a.currentTime,timing:a.effect?.getTiming()}))}));
 assert.deepEqual(diagnostic.styles.map(s=>s.style),frozenStyles,'Frozen environment style changed');
 await writeFile(root+'/ambient-diagnostic.json',JSON.stringify(diagnostic,null,2));console.log(diagnostic);
 await page.waitForTimeout(Math.max(0,activityAt+30000-await page.evaluate(()=>performance.now())));
 // A longer, fixed 15s idle window includes V8's memory-reducer collection;
 // do not discard GC spikes or subtract them from main-thread busy time.
 const idle=await trace(page,cdp,'ambient-frozen-after-30s-6x',15000);
 const positions=await page.locator('.cloud-wave').evaluateAll(es=>es.map(e=>e.style.transform));
 await page.evaluate(()=>document.dispatchEvent(new Event('touchstart')));await page.waitForTimeout(100);
 assert.notDeepEqual(await page.locator('.cloud-wave').evaluateAll(es=>es.map(e=>e.style.transform)),positions);
 await bridgeCall(page,'setVisible',{visible:false});await page.waitForTimeout(150);
 const hidden=await trace(page,cdp,'ambient-native-hidden-6x',2000);
 await bridgeCall(page,'setVisible',{visible:true});
 // Reduced motion & smooth-first use no environmental timer, without changing interaction WAAPI.
 await context.close();
 assert.deepEqual(errors,[]);
 await writeFile(root+'/ambient-results.json',JSON.stringify({method:'Chromium412x915,DPR2.625,touch,CPU6x; main RunTask union (includes GC); active 5s, frozen 15s starting 30s after activity, hidden 2s; raw DrawFrame count; Date fixed; no RAF probe; production build',maxCallbacksPerSecond:Math.max(...buckets.values()),maxElementsPerTick:Math.max(...writes.map(r=>r.elements)),frozenImageChangedChannels:changed,maxDelta,meanDelta:totalDelta/a.length,results,errors},null,2));
 assert.equal(idle.drawFrames,0,'Frozen page still produces frames');assert.ok(idle.busyPercent<=1,'Frozen page not near zero');assert.equal(hidden.drawFrames,0);
 assert.equal(changed,0,'Fully frozen screenshots must be pixel-identical');
}finally{await browser.close();await server.close()}
