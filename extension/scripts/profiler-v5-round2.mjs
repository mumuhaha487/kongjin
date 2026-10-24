import assert from 'node:assert/strict';
import {writeFile}from'node:fs/promises';
import {chromium}from'playwright';
import {homeServer}from'./android-server.mjs';
import {setup,fixture}from'./fixtures.mjs';
const server=await homeServer('dist-android-profiler',4198);const browser=await chromium.launch({executablePath:'tests/.browser/chrome-win/chrome.exe',args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND']});
try{
 const c=await browser.newContext({viewport:{width:412,height:915},deviceScaleFactor:2.625,isMobile:true,hasTouch:true});await setup(c,fixture('dark'));
 await c.addInitScript(()=>window.kjProfile=[]);const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(server.base);await p.waitForFunction(()=>window.kjTest?.relayState);await p.waitForTimeout(2400);
 const mounts=await p.evaluate(()=>window.kjProfile);assert.ok(mounts.some(e=>e.phase==='mount'),'React profiling renderer positive control');
 const nodes=await p.locator('.persistent-sheet').count();assert.equal(nodes,4);
 await p.evaluate(()=>window.kjTest.setState({settingsOpen:true}));await p.waitForTimeout(700);
 const ref=await p.getByRole('dialog',{name:'设置',exact:true}).elementHandle();
 await p.keyboard.press('Escape');await p.waitForTimeout(700);
 const results=[];
 for(const scene of ['settings','relay','bookmark','me']){
  await p.evaluate(()=>window.kjProfile=[]);
  await p.evaluate(scene=>{
   if(scene==='settings')window.kjTest.setState({settingsOpen:true});
   if(scene==='relay')window.kjTest.relayState.setState({open:true});
   if(scene==='bookmark')window.kjTest.setState({overlay:{type:'bookmark'}});
   if(scene==='me')document.querySelector('.avatar-trigger').click();
  },scene);await p.waitForTimeout(700);
  const commits=await p.evaluate(()=>window.kjProfile.filter(e=>!e.id.startsWith('setting:')));assert.equal(commits.length,0,scene+' homepage commits');
  assert.equal(await p.locator('.persistent-sheet[data-open=true]').count(),1);
  const willChange=await p.locator('.persistent-sheet[data-open=true] [role=dialog]').evaluate(e=>e.style.willChange);assert.equal(willChange,'');
  if(scene==='settings') assert.equal(await ref.evaluate(e=>e===document.querySelector('.settings-panel')),true);
  results.push({scene,homepageCommits:commits,willChangeAfterAnimation:willChange});
  await p.keyboard.press('Escape');await p.waitForTimeout(700);
  assert.ok(await p.locator('.persistent-sheet[data-settled=closed]').evaluateAll(nodes=>nodes.every(e=>getComputedStyle(e).opacity==='0')),'parked surfaces cannot paint cached child display lists');
 }
 await p.evaluate(()=>window.kjTest.setState({settingsOpen:true}));await p.waitForTimeout(700);
 await p.evaluate(()=>{window.kjProfile=[];window.kjTest.getState().setting('history',false)});await p.waitForTimeout(250);
 const settingRows=await p.evaluate(()=>window.kjProfile.filter(e=>e.id.startsWith('setting:')));
 assert.deepEqual(settingRows.map(e=>e.id),['setting:history']);
 await p.keyboard.press('Escape');await p.waitForTimeout(700);
 // Positive control: the same Profiler callbacks observe a real homepage update.
 await p.evaluate(()=>{window.kjProfile=[];window.kjTest.setState({focused:true})});await p.waitForTimeout(200);
 const positive=await p.evaluate(()=>window.kjProfile);assert.ok(positive.some(e=>e.id==='Search'));assert.equal(errors.length,0);
 const out={renderer:'react-dom/profiling.js, QA only',mounts,results,positiveControl:positive,settingRows,errors};
 await writeFile('../docs/v5-perf/round2-profiler.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));await c.close();
}finally{await browser.close();await server.close()}
