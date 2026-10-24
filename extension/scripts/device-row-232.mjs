import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {chromium} from 'playwright';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {nativeMock} from './android-fixtures.mjs';

// QA bundles only. Never invoke default build/pack or touch a release output.
const output=resolve('../docs/v6/v332-evidence');
await mkdir(output+'/screenshots',{recursive:true});
const temporary=await mkdtemp(resolve(tmpdir(),'kongjing-device-row-232-'));
const protectedPaths=[resolve('dist-android'),resolve('../release/unpacked'),resolve('../release/kongjing-2.3.1.zip')];
const results=[],errors=[],servers=[];
let browser;
async function protectedInventory(){
  const rows=[];
  async function visit(path){
    const info=await stat(path);
    if(info.isDirectory()){
      rows.push({path,kind:'directory',mtime:info.mtimeMs});
      for(const entry of (await readdir(path)).sort())await visit(resolve(path,entry));
    }else rows.push({path,kind:'file',mtime:info.mtimeMs,size:info.size,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});
  }
  for(const path of protectedPaths)await visit(path);
  return rows;
}
const before=await protectedInventory();
function run(name,args,env={}){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,args,{windowsHide:true,env:{...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',KJ_STORE:'0',...env}});
    let log='';
    child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
    child.on('error',reject);
    child.on('close',async code=>{
      await writeFile(output+'/'+name+'.log',log);
      if(code!==0)reject(Error(name+' failed:\n'+log.slice(-6000)));
      else{console.log('PASS '+name);resolveRun();}
    });
  });
}
const devices=[
  {deviceId:'a',name:'Windows · Chrome',platform:'Windows',self:true,online:true,transport:'direct'},
  {deviceId:'b',name:'MacBook · Chrome',platform:'macOS',self:false,online:true,transport:'relay'},
  {deviceId:'c',name:'非常长的设备名称 · 空境 Android 测试机',platform:'Android',self:false,online:true,transport:'direct'},
];
async function audit(page,platform,font){
  return page.evaluate(({platform,font})=>{
    const issues=[],scale=font/100;
    const near=(actual,expected,label)=>{if(Math.abs(actual-expected)>.51)issues.push({kind:'style',label,actual,expected});};
    const color=(element,token,label,property='color')=>{
      const sample=document.createElement('i');sample.style.color=`var(${token})`;
      document.body.append(sample);const expected=getComputedStyle(sample).color;sample.remove();
      const css=getComputedStyle(element),actual=css[property];if(actual!==expected)issues.push({kind:'color',label,actual,expected,class:element.className,transition:css.transition,animations:element.getAnimations().map(a=>a.animationName)});
    };
    const bounds=(element,parent,label)=>{
      const r=element.getBoundingClientRect(),p=parent.getBoundingClientRect();
      if(r.left<p.left-.5||r.right>p.right+.5||r.top<p.top-.5||r.bottom>p.bottom+.5)issues.push({kind:'bounds',label});
    };
    const rows=[...document.querySelectorAll('#settings-pairing .device-row')];
    if(rows.length!==3)issues.push({kind:'count',actual:rows.length});
    if(document.documentElement.scrollWidth>innerWidth)issues.push({kind:'document-overflow'});
    rows.forEach((row,i)=>{
      const css=getComputedStyle(row),r=row.getBoundingClientRect();
      near(parseFloat(css.minHeight),56,'row.minHeight');
      near(parseFloat(css.paddingTop),10,'row.paddingTop');near(parseFloat(css.paddingBottom),10,'row.paddingBottom');near(parseFloat(css.gap),12,'row.gap');
      if(r.height<56)issues.push({kind:'height',height:r.height});
      if(css.alignItems!=='center')issues.push({kind:'row-alignment'});
      if(i){const p=rows[i-1].getBoundingClientRect();if(p.bottom>r.top+.5)issues.push({kind:'row-overlap'});near(parseFloat(css.borderTopWidth),1,'row.border');color(row,'--border','row.borderColor','borderTopColor');}
      const icon=row.querySelector(':scope > svg'),name=row.querySelector('.device-name'),meta=row.querySelector('.device-meta'),action=row.querySelector(':scope > button');
      near(icon.getBoundingClientRect().width,20,'icon.width');near(icon.getBoundingClientRect().height,20,'icon.height');near(parseFloat(getComputedStyle(icon).marginTop),2,'icon.marginTop');
      color(icon,'--text-2','icon');
      if(getComputedStyle(icon).alignSelf!=='flex-start')issues.push({kind:'icon-alignment'});
      near(parseFloat(getComputedStyle(name).fontSize),14*scale,'name.font');near(parseFloat(getComputedStyle(name).lineHeight),20,'name.lineHeight');
      if(getComputedStyle(name).fontWeight!=='500'||getComputedStyle(name).webkitLineClamp!=='2')issues.push({kind:'name-style'});
      if(name.getBoundingClientRect().height>40.5)issues.push({kind:'name-lines'});
      color(name,'--text','name');
      near(parseFloat(getComputedStyle(meta).marginTop),4,'meta.marginTop');near(parseFloat(getComputedStyle(meta).rowGap),4,'meta.rowGap');near(parseFloat(getComputedStyle(meta).columnGap),6,'meta.columnGap');
      for(const item of [meta,...meta.querySelectorAll('span')]){near(parseFloat(getComputedStyle(item).fontSize),12*scale,'meta.font');near(parseFloat(getComputedStyle(item).lineHeight),18,'meta.lineHeight');}
      if(i===0){if(meta.querySelector('.device-presence')||meta.firstElementChild.textContent!=='本机')issues.push({kind:'self-order'});}
      else {
        const presence=meta.querySelector('.device-presence'),dot=presence.querySelector('i');
        near(dot.getBoundingClientRect().width,6,'presence.dot');near(dot.getBoundingClientRect().height,6,'presence.dot');
        color(presence,'--text-3','presence');color(dot,dot.classList.contains('offline')?'--text-3':'--success','presence.dotColor','backgroundColor');
      }
      for(const pill of meta.querySelectorAll('.self-pill,.transport-pill')){
        const p=getComputedStyle(pill);near(parseFloat(p.paddingTop),0,'pill.paddingTop');near(parseFloat(p.paddingBottom),0,'pill.paddingBottom');near(parseFloat(p.paddingLeft),8,'pill.paddingLeft');near(parseFloat(p.paddingRight),8,'pill.paddingRight');near(parseFloat(p.marginTop),0,'pill.margin');
        color(pill,pill.classList.contains('self-pill')?'--text-2':pill.classList.contains('direct')?'--success':pill.classList.contains('relay')?'--accent':'--text-3','pill');
        color(pill,'--surface','pill.surface','backgroundColor');
      }
      near(parseFloat(getComputedStyle(action).fontSize),12*scale,'action.font');
      if(getComputedStyle(action).alignSelf!=='center')issues.push({kind:'action-alignment'});
      if(platform==='android'&&(action.getBoundingClientRect().width<44||action.getBoundingClientRect().height<44))issues.push({kind:'action-hit-area'});
      for(const child of [icon,name,meta,action,...meta.children])bounds(child,row,child.className?.baseVal||child.className);
      const main=row.querySelector('.device-info').getBoundingClientRect(),button=action.getBoundingClientRect();
      if(main.right>button.left+.5)issues.push({kind:'action-overlap'});
      if(name.getBoundingClientRect().bottom>meta.getBoundingClientRect().top-.5)issues.push({kind:'name-meta-overlap'});
    });
    return issues;
  },{platform,font});
}
async function targeted(platform,directory){
  const server=await homeServer(directory,0);servers.push(server);
  const quick=process.env.KJ_DEVICE_ROW_QUICK==='1';
  for(const [width,height]of quick?[[360,640]]:[[360,640],[360,800],[390,844],[412,915]])for(const font of quick?[130]:[100,115,130])for(const theme of quick?['dark']:['light','dark']){
    const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:platform==='android'?2.625:2,isMobile:platform==='android',hasTouch:platform==='android',reducedMotion:'reduce',locale:'zh-CN'});
    if(platform==='android')await nativeMock(context);
    await setup(context,fixture(theme),{'kj:mock':{paired:true}});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(server.base);await page.waitForFunction(()=>window.kjTest?.getState().status.paired);
    await page.waitForTimeout(700);
    await page.evaluate(devices=>{
      const s=window.kjTest.getState();window.kjTest.setState({settingsOpen:true,settingsSection:'pairing',status:{...s.status,devices,transport:'direct'}});
    },devices);
    await page.locator('.device-row').last().waitFor();
    await page.waitForTimeout(250);
    await page.evaluate(scale=>{
      const elements=[...document.querySelectorAll('body *')].filter(e=>e instanceof HTMLElement);
      const sizes=elements.map(e=>getComputedStyle(e).fontSize);
      elements.forEach((e,i)=>{if(e.matches('input,textarea')||[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))e.style.fontSize=parseFloat(sizes[i])*scale+'px';});
      // Containers also inherit the enlarged meta size, matching all inner labels.
      document.querySelectorAll('.device-meta').forEach(e=>e.style.fontSize=12*scale+'px');
    },font/100);
    await page.locator('#settings-pairing > h3').evaluate(e=>e.scrollIntoView({block:'start'}));
    await page.waitForTimeout(150);
    results.push({platform,width,height,font,theme,scene:'three-devices',issues:await audit(page,platform,font)});
    if([[360,640],[412,915]].some(([w,h])=>w===width&&h===height)&&[100,130].includes(font))await page.screenshot({path:`${output}/screenshots/device-row-${platform}-${width}x${height}-${font}-${theme}.png`});
    // Exercise the new offline dot/copy and inline rename without adding fixtures to production.
    await page.evaluate(devices=>{window.kjTest.setState({status:{...window.kjTest.getState().status,devices:devices.map((d,i)=>i===1?{...d,online:false,transport:'offline'}:d)}});},devices);
    const offline=page.locator('.device-row').nth(1);
    assert.equal((await offline.locator('.device-presence').textContent()).trim(),'离线');
    assert.equal(await offline.locator('.transport-pill').textContent(),'离线');
    // Existing reduced-motion CSS gives every transition a 150ms duration.
    // Assert the final token color after that transition, rather than an interpolated frame.
    await page.waitForFunction(()=>{
      const row=document.querySelectorAll('.device-row')[1];
      const sample=document.createElement('i');sample.style.color='var(--text-3)';
      document.body.append(sample);const expected=getComputedStyle(sample).color;sample.remove();
      return getComputedStyle(row.querySelector('.device-online')).backgroundColor===expected
        &&getComputedStyle(row.querySelector('.transport-pill')).color===expected;
    });
    results.push({platform,width,height,font,theme,scene:'offline',issues:await audit(page,platform,font)});
    await page.getByRole('button',{name:'重命名',exact:true}).click();
    const input=page.getByRole('textbox',{name:'本机名称',exact:true});
    await input.fill('非常长的设备名称 · 空境 Android 测试机');
    const renameIssues=await input.evaluate(e=>{const p=e.closest('.device-info').getBoundingClientRect(),r=e.getBoundingClientRect();return r.left<p.left-.5||r.right>p.right+.5?[{kind:'rename-overflow'}]:[];});
    results.push({platform,width,height,font,theme,scene:'rename',issues:renameIssues});
    await page.keyboard.press('Escape');await context.close();
  }
}
let failed;
try{
  const desktop=resolve(temporary,'desktop'),android=resolve(temporary,'android');
  await run('qa-desktop',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',desktop,'--emptyOutDir'],{KJ_PLATFORM:'desktop'});
  await run('qa-android',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',android,'--emptyOutDir'],{KJ_PLATFORM:'android'});
  browser=await chromium.launch({executablePath:resolve('tests/.browser/chrome-win/chrome.exe'),args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND']});
  await targeted('desktop',desktop);await targeted('android',android);
  assert.deepEqual(errors,[]);assert.deepEqual(results.filter(r=>r.issues.length),[]);
  await writeFile(output+'/device-row-results.json',JSON.stringify({passed:true,results,errors},null,2));
  if(process.env.KJ_DEVICE_ROW_QUICK!=='1')await run('overflow-full',['node_modules/tsx/dist/cli.mjs','scripts/overflow-v3.mjs'],{KJ_QA_ANDROID_DIR:android,KJ_EVIDENCE:output});
}catch(error){failed=error;}
finally{
  await browser?.close();for(const server of servers)await server.close();
  const after=await protectedInventory();
  const protection={unchanged:JSON.stringify(before)===JSON.stringify(after),paths:protectedPaths,files:before.filter(r=>r.kind==='file').length,checks:['SHA-256','size','file mtime','directory mtime']};
  await writeFile(output+'/protected-outputs.json',JSON.stringify(protection,null,2));
  await writeFile(output+'/device-row-results.json',JSON.stringify({passed:!failed,results,errors,failure:failed?.stack},null,2));
  const rel=relative(tmpdir(),temporary);
  assert.ok(!isAbsolute(rel)&&rel&&!rel.startsWith('..'+sep)&&!rel.startsWith('..')&&temporary.startsWith(resolve(tmpdir())+sep),'temporary cleanup must stay inside OS temp');
  await rm(temporary,{recursive:true,force:true});
  await writeFile(output+'/temporary-cleanup.json',JSON.stringify({temporary,removed:true},null,2));
  assert.equal(protection.unchanged,true,'protected 2.3.1 outputs changed');
}
if(failed)throw failed;
console.log(`PASS ${results.length} targeted combinations; full matrix ${process.env.KJ_DEVICE_ROW_QUICK==='1'?'skipped (quick run)':'passed'}; protected outputs unchanged; temporary bundles deleted`);
