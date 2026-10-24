import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {nativeMock} from './android-fixtures.mjs';
import {singleLineAudit} from './single-line-audit.mjs';

const pixelOnly=process.argv.includes('--pixel-only'),recapture=process.argv.includes('--recapture-baseline'),baseline=process.argv.includes('--baseline')||recapture,capturesOnly=process.argv.includes('--captures-only'),out=resolve('../docs/v7'),shots=out+'/screenshots',evidence=out+'/evidence';
await mkdir(shots,{recursive:true});await mkdir(evidence,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function inventory(){
 const rows=[];async function walk(path){const s=await stat(path);if(s.isDirectory()){for(const n of(await readdir(path)).sort())await walk(resolve(path,n));}else rows.push({path,bytes:s.size,mtime:s.mtimeMs,sha256:sha(await readFile(path))});}
 for(const n of(await readdir('../release')).sort())if(/\.(zip|crx)$/.test(n)&&!n.includes('2.4.0'))await walk(resolve('../release',n));
 for(const p of ['../release/store','../release/android','dist-store'])await walk(resolve(p));return rows;
}
let state;
if(baseline&&!recapture){const temp=await mkdtemp(resolve(tmpdir(),'kongjing-home-240-'));state={temp,protected:await inventory()};await cp('dist-android',temp+'/android',{recursive:true});await cp('dist',temp+'/desktop',{recursive:true});await writeFile(evidence+'/baseline-state.json',JSON.stringify(state,null,2));}
else state=JSON.parse(await readFile(evidence+'/baseline-state.json','utf8'));
if(process.argv.includes('--snapshot-protection')){await writeFile(evidence+'/round3-protection-state.json',JSON.stringify(await inventory(),null,2));process.exit(0);}
if(!baseline)state.protected=JSON.parse(await readFile(evidence+'/round3-protection-state.json','utf8').catch(()=>JSON.stringify(state.protected)));
const browserOptions={executablePath:resolve('tests/.browser/chrome-win/chrome.exe'),args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND']};
// Use the same software rasterizer for before/after photos; GPU rounding can
// otherwise differ by 1/255 at a handful of glow-edge pixels between processes.
let browser=await chromium.launch({...browserOptions,args:[...browserOptions.args,'--disable-gpu']});
const android=await homeServer(baseline?state.temp+'/android':'dist-android',0),desktop=await homeServer(baseline?state.temp+'/desktop':'dist',0);
const label=baseline?'234':'240',checks=[],diffs=[],performanceResults=[];
function data(theme,{count=8,nickname='Alex'}={}){const d=fixture(theme);while(d.bookmarks.length<count){const i=d.bookmarks.length;d.bookmarks.push({...d.bookmarks[1],id:'home240-'+i,title:['文档','设计','阅读','工具'][i%4],url:'https://example.com/'+i,order:i});}d.bookmarks=d.bookmarks.slice(0,count);d.profile.nickname=nickname;return d;}
async function scene(server,w,h,theme,mobile=true,motion='reduce',options={}){
 const c=await browser.newContext({viewport:{width:w,height:h},deviceScaleFactor:mobile?2.625:2,isMobile:mobile,hasTouch:mobile,reducedMotion:motion,locale:'zh-CN',timezoneId:'Asia/Singapore'});
 if(mobile)await nativeMock(c);await setup(c,data(theme,options));await c.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,r=>r.abort());
 const p=await c.newPage();await p.clock.setFixedTime(new Date('2026-10-24T08:24:00+08:00'));await p.goto(server.base);await p.locator('.bookmark-link').first().waitFor();await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(1800);
 // Reduced motion stops the Android clock after its initial configuration.
 // Normalize the environmental phase for strict pixel comparisons: its initial
 // configure() integrates module-to-mount wall time even when motion is reduced.
 if(mobile&&motion==='reduce')await p.evaluate(()=>{document.querySelectorAll('.cloud-wave').forEach((e,i)=>{e.style.transform=`translateX(${-50*([0,60000,90000][i]/[240000,180000,135000][i])}%)`;});const star=document.querySelector('.clock-spark');if(star){star.style.transform='scale(0.7) rotate(0deg)';star.style.opacity='0.45';}const colon=document.querySelector('.colon');if(colon)colon.style.opacity='1';const twinkle=document.querySelector('.twinkle-layer');if(twinkle)twinkle.style.opacity='1';});
 if(motion==='reduce')await p.waitForTimeout(250);
 return {c,p};
}
async function pixelCompare(a,b,name){const x=await sharp(a).ensureAlpha().raw().toBuffer({resolveWithObject:true}),y=await sharp(b).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.deepEqual(x.info,y.info);let changed=0,max=0;for(let i=0;i<x.data.length;i++){const d=Math.abs(x.data[i]-y.data[i]);if(d)changed++;max=Math.max(max,d);}diffs.push({name,changedChannels:changed,maxDelta:max});assert.equal(changed,0,name+' must remain pixel-identical');}
async function enlarge(p,scale){await p.evaluate(scale=>{const nodes=[...document.querySelectorAll('body *')].filter(e=>e instanceof HTMLElement),sizes=nodes.map(e=>parseFloat(getComputedStyle(e).fontSize));nodes.forEach((e,i)=>{if(e.matches('input,textarea')||[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))e.style.fontSize=sizes[i]*scale+'px';});},scale);await p.waitForTimeout(250);}
async function mobileMetrics(p){return p.evaluate(()=>{
 const box=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};},summary=document.querySelector('.mobile-clock-summary'),date=document.querySelector('.mobile-summary-date'),nickname=document.querySelector('.mobile-nickname'),greet=document.querySelector('.mobile-greet'),stage=document.querySelector('#stage'),header=document.querySelector('.topbar'),clock=document.querySelector('.clock-section'),footer=document.querySelector('.sync-status'),grid=document.querySelector('.bookmark-grid'),range=document.createRange(),walker=document.createTreeWalker(summary,NodeFilter.SHOW_TEXT),textTops=[];while(walker.nextNode()){range.selectNodeContents(walker.currentNode);for(const r of range.getClientRects())textTops.push(r.top);}
 const topGap=box(clock).y-box(header).bottom,bottomGap=box(footer).y-box(grid).bottom,availableTop=box(header).bottom,availableBottom=innerHeight-parseFloat(getComputedStyle(document.querySelector('#root')).paddingBottom),clockDigit=box(document.querySelector('.clock')),summaryBox=box(summary),contentCenter=(summaryBox.y+clockDigit.bottom)/2;
 const style=getComputedStyle(summary),youtube=[...document.querySelectorAll('.bookmark-name')].find(e=>e.textContent==='YouTube'),tracks=getComputedStyle(grid).gridTemplateColumns.split(' ').map(Number.parseFloat);
 return {width:document.documentElement.scrollWidth,summary:summary.textContent,summaryLines:[...new Set(textTops)].length,date:box(date),dateText:date.textContent,summaryBox,clockBox:box(clock),greet:greet?box(greet):null,greetText:greet?.textContent,nickname:nickname?.textContent,nicknameWidth:nickname?.getBoundingClientRect().width,nicknameFlex:nickname?getComputedStyle(nickname).flex:null,nicknameToDateGap:nickname?box(date).x-box(nickname).right:null,greetToNicknameGap:nickname&&greet?box(nickname).x-box(greet).right:null,gap:style.columnGap,justify:style.justifyContent,topGap,bottomGap,beforeFlex:getComputedStyle(stage,'::before').flex,afterFlex:getComputedStyle(stage,'::after').flex,firstBookmark:box(document.querySelector('.bookmark-link')),centerOffset:Math.abs(contentCenter-(availableTop+availableBottom)/2),columns:tracks.length,tracks,youtube:youtube?{client:youtube.clientWidth,scroll:youtube.scrollWidth,text:youtube.textContent}:null,visibleBookmarks:[...document.querySelectorAll('.bookmark')].filter(e=>!e.querySelector('.add-bookmark')&&e.getBoundingClientRect().bottom<=innerHeight-56).length};
});}
function assertMobile(row,w,h){
 assert.equal(row.width,w);assert.equal(row.summaryLines,1,'Merged greeting/date remains a single line');
 assert.ok(row.summaryBox.x>=20-.5&&row.summaryBox.right<=w-20+.5,'Greeting row retains at least 20px screen margin');
 assert.ok(row.summaryBox.width<=row.clockBox.width-40+.5,'Greeting width follows parent minus 40px');
 // Fixed greeting/date do not shrink. At 640px/130% their combined width can
 // exceed the nominal summary width; assert they stay inside the clock column
 // and never collide with the right column, rather than clipping the date.
 assert.ok(row.date.right<=(w<h?row.summaryBox.right:row.clockBox.right)+.5&&row.date.x>=row.summaryBox.x-.5,'Full date remains in the clock column');
 assert.equal(row.dateText,' · 10月24日 星期六');
 if(row.nickname){assert.equal(row.nicknameFlex,'0 1 auto');assert.ok(Math.abs(row.nicknameToDateGap)<.1&&Math.abs(row.greetToNicknameGap)<.1,'No extra gap between fixed greeting, nickname and date');assert.equal(row.greetText,'早上好，');}
 if(w>h){assert.equal(row.justify,'flex-start');assert.ok(Math.abs(row.summaryBox.x-row.clockBox.x-20)<.5,'Landscape greeting is left aligned at existing 20px inset');assert.equal(row.columns,Math.floor((w*.6-40)/72));assert.ok(row.tracks.every(t=>t>=72-.1));if(w===915)assert.ok(row.columns>=6);if(w===640){assert.equal(row.youtube.text,'YouTube');assert.ok(row.youtube.scroll<=row.youtube.client,'YouTube remains unellipsized');}}
 if(w<h){assert.ok(row.bottomGap<=row.topGap*2.5+.5,'Bottom blank <= 2.5 × top blank');assert.ok(row.topGap>=-.5&&row.bottomGap>=-.5);assert.equal(row.beforeFlex,'1 1 0px');assert.equal(row.afterFlex,'2 1 0px');}
 if(w===915)assert.ok(row.centerOffset<=8,'Landscape clock is centered in available height');
}
async function reviewScreenshots(){
 const portraits=['light','dark'].flatMap(t=>['360x640','360x640-130','412x915','390x844'].map(s=>`home-240-${s}-${t}.png`));
 const landscapes=['light','dark'].flatMap(t=>['640x360','640x360-130','915x412','915x412-130'].map(s=>`home-240-${s}-${t}.png`));
 const extra=kind=>['light','dark'].flatMap(t=>[100,130].map(f=>`home-240-360x640-${kind}-${f}-${t}.png`));
 async function montage(files,name,width,height,cols){
  const pieces=[];
  for(let i=0;i<files.length;i++){
   const x=i%cols*width,y=Math.floor(i/cols)*height;
   pieces.push({input:Buffer.from(`<svg width="${width}" height="32"><rect width="100%" height="100%" fill="white"/><text x="8" y="21" font-family="sans-serif" font-size="12">${files[i].replace('home-240-','')}</text></svg>`),left:x,top:y});
   pieces.push({input:await sharp(shots+'/'+files[i]).resize({width,height:height-32,fit:'inside'}).png().toBuffer(),left:x,top:y+32});
  }
  await sharp({create:{width:width*cols,height:height*Math.ceil(files.length/cols),channels:3,background:'white'}}).composite(pieces).png().toFile(shots+'/'+name);
 }
 await montage(portraits,'home-240-review.png',360,947,4);
 await montage(landscapes,'home-240-review-landscape.png',650,452,2);
 await montage(extra('long-nickname'),'home-240-review-nicknames.png',360,672,4);
 await montage(extra('24-bookmarks'),'home-240-review-24-bookmarks.png',360,1330,4);
 const files=[...portraits,...landscapes,...extra('long-nickname'),...extra('24-bookmarks'),...['light','dark'].flatMap(t=>[`home-240-compare-360x640-${t}.png`,...['desktop','tablet-portrait','tablet-landscape'].map(k=>`home-240-${k}-${t}.png`)])];
 const metadata=[];
 for(const file of files){const m=await sharp(shots+'/'+file).metadata();metadata.push({file,width:m.width,height:m.height,hasAlpha:m.hasAlpha});}
 await writeFile(evidence+'/screenshot-metadata.json',JSON.stringify(metadata,null,2));
}
async function trace(p,cdp,name){
 await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing',transferMode:'ReturnAsStream'});const start=performance.now();await p.waitForTimeout(5000);const elapsed=performance.now()-start;
 const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const {stream}=await done;let raw='';for(;;){const r=await cdp.send('IO.read',{handle:stream});raw+=r.data;if(r.eof)break;}await cdp.send('IO.close',{handle:stream});await writeFile(evidence+'/'+label+'-'+name+'.json.gz',gzipSync(raw));
 const events=JSON.parse(raw).traceEvents,main=events.find(e=>e.name==='thread_name'&&e.args?.name==='CrRendererMain'),es=events.filter(e=>e.pid===main.pid&&e.tid===main.tid&&e.ph==='X'),tasks=es.filter(e=>/^(RunTask|ThreadControllerImpl::RunTask)$/.test(e.name)).map(e=>[e.ts,e.ts+e.dur]).sort((a,b)=>a[0]-b[0]);let busy=0,end=0;for(const[s,t]of tasks){busy+=Math.max(0,t-Math.max(s,end));end=Math.max(end,t);}const row={name,busyPercent:busy/1000/elapsed*100,paintMs:es.filter(e=>e.name==='Paint').reduce((s,e)=>s+e.dur/1000,0),drawFrames:events.filter(e=>e.name==='DrawFrame'&&e.pid===main.pid).length};performanceResults.push(row);console.log(label,row);
}
try{
 for(const theme of ['light','dark']){
  for(const[w,h]of pixelOnly?[]:[[360,640],[412,915],[390,844],[640,360],[915,412]]){
   const{c,p}=await scene(android,w,h,theme);const name=`home-${label}-${w}x${h}-${theme}`,file=shots+'/'+name+'.png';await p.screenshot({path:file});
   if(!baseline){
    const row=await p.evaluate(()=>{const r=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};return {viewport:{width:innerWidth,height:innerHeight},clock:r(document.querySelector('.clock-section')),search:r(document.querySelector('.search-enter')),groups:r(document.querySelector('.groups')),grid:r(document.querySelector('.bookmark-grid')),bookmarks:[...document.querySelectorAll('.bookmark:not(:has(.add-bookmark))')].map(r),summary:document.querySelector('.mobile-clock-summary')?.textContent,columns:getComputedStyle(document.querySelector('.bookmark-grid')).gridTemplateColumns.split(' ').length,padding:getComputedStyle(document.querySelector('#root')).paddingBottom,scrollWidth:document.documentElement.scrollWidth};});
    assert.equal(row.scrollWidth,w);assert.equal(row.columns,w>h?Math.floor((w*.6-40)/72):4);assert.equal(row.summary,'早上好，Alex · 10月24日 星期六');
    if(w>h){assert.ok(row.clock.right<=w*.4+.5);assert.ok(row.search.x>=w*.4-.5);}
    if(w===360)assert.equal(row.bookmarks.filter(b=>b.bottom<=h-56).length>=8,true,'8 complete bookmarks above toolbar');
    const mobile=await mobileMetrics(p);assertMobile(mobile,w,h);
    const single=await p.evaluate(singleLineAudit);assert.deepEqual(single.issues,[]);checks.push({name,...row,...mobile});
    for(const font of [115,130]){
      // A new context gives each font sample an independent, unscaled baseline.
      const scaled=await scene(android,w,h,theme),sp=scaled.p;
      await sp.waitForFunction(()=>[...document.querySelectorAll('.clock,.search-enter,.bookmark')].every(e=>+getComputedStyle(e).opacity>.999),null,{timeout:10000});await enlarge(sp,font/100);
      const lines=await sp.evaluate(singleLineAudit);assert.deepEqual(lines.issues,[]);
      const metrics=await mobileMetrics(sp);assertMobile(metrics,w,h);
      if(w===360&&font===130){assert.ok(metrics.visibleBookmarks>=4);await sp.screenshot({path:shots+`/home-240-360x640-130-${theme}.png`});}
      if(w>h&&font===130)await sp.screenshot({path:shots+`/home-240-${w}x${h}-130-${theme}.png`});
      checks.push({name,font,...metrics,singleLineChecks:lines.checked});
      await scaled.c.close();
    }
   }
   await c.close();
  }
  if(!baseline&&!pixelOnly)for(const options of [{count:24,nickname:'Alex',label:'24-bookmarks'},{count:4,nickname:'Alex',label:'few-bookmarks'},{nickname:'非常长的中文昵称测试用户',label:'long-nickname'},{nickname:'',label:'no-nickname'}]){
   for(const font of [100,130]){
    const{c,p}=await scene(android,360,640,theme,true,'reduce',options);if(font!==100)await enlarge(p,font/100);
    const metrics=await mobileMetrics(p);assertMobile(metrics,360,640);const lines=await p.evaluate(singleLineAudit);assert.deepEqual(lines.issues,[]);
    if(options.count===24&&font===100)assert.ok(Math.abs(metrics.firstBookmark.y-288.796875)<.1,'24 bookmarks retain original first row');
    if(options.count===4)assert.ok(metrics.topGap>0&&Math.abs(metrics.bottomGap/metrics.topGap-2)<.01,'Few bookmarks use 1:2 blank space');
    if(options.label==='long-nickname')assert.equal(metrics.nickname,'非常长的中文昵称测试用户');
    if(options.label==='no-nickname')assert.equal(metrics.summary,'早上好 · 10月24日 星期六');
    if(!['no-nickname','few-bookmarks'].includes(options.label))await p.screenshot({path:shots+`/home-240-360x640-${options.label}-${font}-${theme}.png`,fullPage:options.count===24});
    checks.push({name:options.label,font,theme,...metrics,singleLineChecks:lines.checked});await c.close();
   }
  }
  for(const [kind,server,w,h,mobile]of [['desktop',desktop,1440,900,false],['tablet-portrait',android,768,1024,true],['tablet-landscape',android,1024,768,true]]){
   const{c,p}=await scene(server,w,h,theme,mobile);const file=shots+`/home-${label}-${kind}-${theme}.png`;
   const dom=await p.evaluate(()=>[...document.querySelectorAll('.clock-section,.clock,.clock-spark,.greeting,.date,.search-enter,.bookmark-grid,.cloud-wave,.twinkle-layer')].map(e=>{const s=getComputedStyle(e),b=e.getBoundingClientRect();return {class:e.getAttribute('class'),inline:e.getAttribute('style'),x:b.x,y:b.y,width:b.width,height:b.height,display:s.display,transform:s.transform,opacity:s.opacity,filter:s.filter,canvas:e instanceof HTMLCanvasElement?e.toDataURL():undefined};}));for(const row of dom)if(row.canvas)row.canvas=sha(row.canvas);await writeFile(evidence+`/${label}-${kind}-${theme}-dom.json`,JSON.stringify(dom,null,2));
   await p.screenshot({path:file});if(!baseline)await pixelCompare(shots+`/home-234-${kind}-${theme}.png`,file,kind+' '+theme);await c.close();
  }
 }
 if(!baseline&&!pixelOnly){
  const{c,p}=await scene(android,360,640,'light');await p.addStyleTag({content:':root{--kj-toolbar-height:88px;--kj-inset-bottom:12px}'});await p.waitForTimeout(250);assert.equal(await p.locator('#root').evaluate(e=>getComputedStyle(e).paddingBottom),'104px');await p.addStyleTag({content:':root{--kj-toolbar-height:initial}'});await p.waitForTimeout(250);assert.equal(await p.locator('#root').evaluate(e=>getComputedStyle(e).paddingBottom),'84px');checks.push({nativeHeight:88,padding:104,fallbackHeight:56,safeArea:12,fallbackPadding:84});await c.close();
  for(const theme of ['light','dark']){const a=await sharp(shots+`/home-234-360x640-${theme}.png`).resize({width:360}).toBuffer(),b=await sharp(shots+`/home-240-360x640-${theme}.png`).resize({width:360}).toBuffer();const title=Buffer.from(`<svg width="720" height="40"><rect width="720" height="40" fill="white"/><g font-family="sans-serif" font-size="18" fill="#111"><text x="150" y="27">2.3.4</text><text x="510" y="27">2.4.0</text></g></svg>`);await sharp({create:{width:720,height:680,channels:3,background:'white'}}).composite([{input:title,left:0,top:0},{input:a,left:0,top:40},{input:b,left:360,top:40}]).png().toFile(shots+`/home-240-compare-360x640-${theme}.png`);}
  await reviewScreenshots();
 }
 if(!capturesOnly){await browser.close();browser=await chromium.launch(browserOptions);}
 if(!capturesOnly)for(const[platform,server,w,h,mobile,rate]of [['android',android,412,915,true,6],['desktop',desktop,1440,900,false,4]]){
  const{c,p}=await scene(server,w,h,'dark',mobile,'no-preference'),cdp=await c.newCDPSession(p);await cdp.send('Emulation.setCPUThrottlingRate',{rate});await trace(p,cdp,platform+'-active');if(mobile){await p.waitForTimeout(22000);await trace(p,cdp,platform+'-frozen');}await c.close();
 }
 await writeFile(evidence+'/'+label+(pixelOnly?'-pixels':capturesOnly?'-captures':'-results')+'.json',JSON.stringify({checks,diffs,performanceResults},null,2));
 if(!baseline){const after=await inventory();await writeFile(evidence+'/protected-outputs.json',JSON.stringify({unchanged:JSON.stringify(state.protected)===JSON.stringify(after),before:state.protected,after},null,2));assert.deepEqual(after,state.protected,'Old archives/store/Android outputs changed');}
}finally{await browser.close();await android.close();await desktop.close();}
if(process.argv.includes('--cleanup')){assert.ok(state.temp.startsWith(resolve(tmpdir())+sep));await rm(state.temp,{recursive:true,force:true});}
console.log('PASS home 2.4.0 '+(baseline?'baseline saved':'layout, desktop/tablet pixel equality, performance and protection'));
