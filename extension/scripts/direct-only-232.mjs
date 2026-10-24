import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {nativeMock} from './android-fixtures.mjs';

const output=resolve('../docs/v6/v332-evidence/direct-only-row');
const screenshots=resolve(output,'../screenshots');
await mkdir(screenshots,{recursive:true});await mkdir(output+'/raw',{recursive:true});
const temporary=await mkdtemp(resolve(tmpdir(),'kongjing-direct-only-232-'));
const protectedPaths=[resolve('../release/kongjing-2.3.1.zip'),resolve('../release/android'),resolve('../release/store'),resolve('dist-store')];
const copy='设备之间只通过直连传输，服务器不保存任何数据。离线的设备要等与其他设备同时在线时才会收到更新。';
const npm=resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const results=[],captures=[],errors=[],servers=[];
let browser,failed;
async function inventory(){
  const rows=[];
  async function visit(path){
    const info=await stat(path);
    if(info.isDirectory()){
      rows.push({path,kind:'directory',mtime:info.mtimeMs});
      for(const name of (await readdir(path)).sort())await visit(resolve(path,name));
    }else rows.push({path,kind:'file',mtime:info.mtimeMs,size:info.size,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});
  }
  for(const path of protectedPaths)await visit(path);
  return rows;
}
const before=await inventory();
await writeFile(output+'/protected-before.json',JSON.stringify(before,null,2));
async function run(name,args,extra={}){
  console.log('RUN '+name);
  await new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,args,{windowsHide:true,env:{...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',KJ_PLATFORM:'desktop',KJ_STORE:'0',KJ_PROFILE:'0',KJ_PERF_MAP:'0',...extra}});
    let log='';
    child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
    child.on('error',reject);
    child.on('close',async code=>{
      await writeFile(output+'/'+name+'.log',log);
      if(code!==0)reject(Error(name+' failed:\n'+log.slice(-6500)));
      else{console.log('PASS '+name);resolveRun();}
    });
  });
}
async function enlargeFonts(page,font){
  await page.evaluate(scale=>{
    window.__directOnlyFonts??=new WeakMap();
    const nodes=[...document.querySelectorAll('body *')].filter(el=>el instanceof HTMLElement&&!el.closest('.background,[aria-hidden="true"],.theme-snapshot'));
    const fresh=nodes.filter(el=>!window.__directOnlyFonts.has(el));
    const sizes=fresh.map(el=>parseFloat(getComputedStyle(el).fontSize));
    fresh.forEach((el,i)=>window.__directOnlyFonts.set(el,sizes[i]));
    nodes.forEach(el=>{if(el.matches('input,textarea')||[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim()))el.style.fontSize=window.__directOnlyFonts.get(el)*scale+'px';});
  },font/100);
}
async function inspect(config,server,theme,on){
  const android=config.platform==='android';
  const context=await browser.newContext({viewport:config.viewport,deviceScaleFactor:android?2.625:2,isMobile:android,hasTouch:android,reducedMotion:'reduce',locale:'zh-CN',timezoneId:'Asia/Singapore'});
  try{
    if(android)await nativeMock(context);
    await setup(context,fixture(theme),{'kj:mock':{paired:true}});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-10-24T12:51:00+08:00'));
    await page.goto(server.base);await page.waitForFunction(()=>window.kjTest?.getState().status.paired);
    await page.waitForTimeout(700);
    await page.evaluate(on=>{const state=window.kjTest.getState();window.kjTest.setState({status:{...state.status,relayUrl:'https://sync.example.com',directOnly:on},settingsOpen:true,settingsSection:'pairing'});},on);
    await page.waitForTimeout(700);
    await page.locator('.sync-v3-advanced').evaluate(el=>{el.open=true;});
    await page.getByText(copy,{exact:true}).waitFor({state:'visible'});
    const referenceRow=page.locator('#settings-sharing .relay-setting-row').filter({has:page.getByRole('switch',{name:'浏览记录',exact:true})});
    await referenceRow.locator('small').first().waitFor({state:'visible'});
    // Materialize the reference section before enlarging; Android's
    // content-visibility can otherwise leave a newly rendered label unscaled.
    await page.locator('#settings-sharing h3').evaluate(el=>el.scrollIntoView({block:'start'}));
    await enlargeFonts(page,config.font);
    await page.waitForTimeout(200);
    const properties=['fontSize','fontWeight','lineHeight','color','marginTop','display'];
    const referenceStyle=await referenceRow.locator('small').first().evaluate((el,properties)=>Object.fromEntries(properties.map(key=>[key,getComputedStyle(el)[key]])),properties);
    let reference;
    const capture=on===(config.font===130),name=`direct-only-${config.name}-${theme}.png`;
    if(capture){
      const clip=await referenceRow.evaluate(el=>{
        const heading=document.querySelector('#settings-sharing h3').getBoundingClientRect(),row=el.getBoundingClientRect();
        const top=Math.floor(heading.top),bottom=Math.ceil(row.bottom);
        if(top<0||bottom>innerHeight)throw Error('reference rows must be fully visible');
        return {x:0,y:top,width:innerWidth,height:bottom-top};
      });
      reference=await page.screenshot({path:resolve(output,'raw',name.replace('.png','-sharing.png')),clip});
    }
    const directRow=page.locator('.sync-v3-advanced > .relay-setting-row');
    await directRow.evaluate(el=>el.scrollIntoView({block:'start'}));
    await enlargeFonts(page,config.font);
    await page.waitForTimeout(250);
    const styles=await page.getByText(copy,{exact:true}).evaluate(el=>{
      const css=getComputedStyle(el),r=el.getBoundingClientRect(),panel=document.querySelector('.settings-panel').getBoundingClientRect();
      const row=el.closest('.relay-setting-row'),rowStyle=getComputedStyle(row),rowRect=row.getBoundingClientRect();
      const toggle=row.querySelector('[role="switch"]'),toggleRect=toggle.getBoundingClientRect();
      const probe=document.createElement('i');probe.style.color='var(--text-3)';document.body.append(probe);
      const color=getComputedStyle(probe).color;probe.remove();
      return {fontSize:parseFloat(css.fontSize),color:css.color,expectedColor:color,smallInTitle:el.tagName==='SMALL'&&el.parentElement.tagName==='SPAN'&&el.parentElement.parentElement===row,switchSibling:el.parentElement.nextElementSibling===toggle,alignItems:rowStyle.alignItems,borderWidth:rowStyle.borderBottomWidth,borderStyle:rowStyle.borderBottomStyle,rowBottom:rowRect.bottom,toggleLeft:toggleRect.left,toggleCenter:(toggleRect.top+toggleRect.bottom)/2,rowCenter:(rowRect.top+rowRect.bottom)/2,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,panel:{left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom},documentWidth:document.documentElement.scrollWidth};
    });
    assert.ok(Math.abs(styles.fontSize-12*config.font/100)<.01);
    assert.equal(styles.color,styles.expectedColor);assert.equal(styles.smallInTitle,true);assert.equal(styles.switchSibling,true);
    assert.equal(styles.alignItems,'center');assert.ok(Math.abs(styles.toggleCenter-styles.rowCenter)<=.5,'switch must be vertically centered');
    assert.equal(styles.borderWidth,'1px');assert.equal(styles.borderStyle,'solid');assert.ok(styles.rowBottom>styles.bottom,'divider follows subtitle');
    assert.ok(styles.right<styles.toggleLeft,'subtitle stays left of switch');
    assert.equal(await page.getByText(copy,{exact:true}).count(),1);
    assert.equal(await page.getByText('离线的设备要等双方同时在线才会同步',{exact:true}).count(),0);
    const actualStyle=await page.getByText(copy,{exact:true}).evaluate((el,properties)=>Object.fromEntries(properties.map(key=>[key,getComputedStyle(el)[key]])),properties);
    assert.deepEqual(actualStyle,referenceStyle,'subtitle computed styles must equal sharing subtitle');
    assert.ok(styles.scrollWidth<=styles.clientWidth+1,'description must wrap');
    assert.ok(styles.left>=styles.panel.left&&styles.right<=styles.panel.right,'description stays in drawer');
    assert.ok(styles.top>=styles.panel.top&&styles.bottom<=styles.panel.bottom,'whole description must be visible');
    assert.ok(styles.documentWidth<=config.viewport.width,'no horizontal overflow');
    assert.equal(await page.getByRole('switch',{name:'仅直连，不在服务器保存数据',exact:true}).getAttribute('aria-checked'),String(on));
    results.push({platform:config.platform,theme,font:config.font,viewport:config.viewport,on,passed:true,styles,actualStyle,referenceStyle});
    if(capture){
      const main=await page.screenshot({path:resolve(output,'raw',name)});
      const a=await sharp(main).metadata(),b=await sharp(reference).metadata();
      assert.equal(a.width,b.width);
      // Two original captures from the same page/scale, joined without resampling
      // or moving any product element. The lower strip starts with “同步内容”.
      await sharp({create:{width:a.width,height:a.height+b.height,channels:3,background:'#000'}}).composite([{input:main,left:0,top:0},{input:reference,left:0,top:a.height}]).png().toFile(resolve(screenshots,name));
      const {width,height}=await sharp(resolve(screenshots,name)).metadata();
      captures.push({name,width,height,theme,on,font:config.font,composition:'Upper: original advanced-settings viewport. Lower: original sharing-settings strip from same page. No scaling or DOM movement.',main:{width:a.width,height:a.height},reference:{width:b.width,height:b.height}});
    }
  }finally{await context.close();}
}
try{
  if(!process.argv.includes('--qa-only')){
  const checks=await Promise.allSettled([
    run('lint',['node_modules/eslint/bin/eslint.js','src','tests']),
    run('unit-self',['node_modules/vitest/vitest.mjs','run']),
    run('unit-android',['node_modules/vitest/vitest.mjs','run'],{KJ_PLATFORM:'android'}),
    run('unit-store',['node_modules/vitest/vitest.mjs','run','--exclude','tests/continuity*.test.ts'],{KJ_STORE:'1'}),
  ]);
  for(const check of checks)if(check.status==='rejected')throw check.reason;
  await run('pack-self',[npm,'run','pack']);
  await run('build-android',[npm,'run','build:android']);
  await run('check-self',[npm,'run','check']);
  }
  const desktop=resolve(temporary,'desktop'),android=resolve(temporary,'android');
  await run('qa-desktop',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',desktop,'--emptyOutDir']);
  await run('qa-android',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',android,'--emptyOutDir'],{KJ_PLATFORM:'android'});
  const desktopServer=await homeServer(desktop,0),androidServer=await homeServer(android,0);servers.push(desktopServer,androidServer);
  browser=await chromium.launch({executablePath:resolve('tests/.browser/chrome-win/chrome.exe'),args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND']});
  for(const config of [
    {name:'desktop',platform:'desktop',viewport:{width:1440,height:900},font:100},
    {name:'android',platform:'android',viewport:{width:412,height:915},font:100},
    {name:'android-360-130',platform:'android',viewport:{width:360,height:640},font:130},
  ])for(const theme of ['light','dark'])for(const on of [false,true])await inspect(config,config.platform==='android'?androidServer:desktopServer,theme,on);
  assert.deepEqual(errors,[]);
  console.log('PASS 12 description/state/layout checks and 6 screenshots');
  await browser.close();browser=null;
  for(const server of servers)await server.close();servers.length=0;
  await run('overflow-full',['node_modules/tsx/dist/cli.mjs','scripts/overflow-v3.mjs'],{KJ_PLATFORM:'android',KJ_QA_ANDROID_DIR:android,KJ_EVIDENCE:output+'/overflow',KJ_AUDIT_QUICK:'0'});
  const matrix=JSON.parse(await readFile(output+'/overflow/overflow-results.json','utf8'));
  assert.equal(matrix.results.length,1176);assert.deepEqual(matrix.errors,[]);
  assert.equal(matrix.results.filter(row=>row.issues.length).length,0);
  const zip=await readFile('../release/kongjing-2.3.2.zip');
  const ready=await readFile('dist-android/READY.md','utf8');
  const artifacts={version:'2.3.2',zip:'release/kongjing-2.3.2.zip',zipSha256:createHash('sha256').update(zip).digest('hex'),androidBuildTime:/构建时间：([^\n]+)/.exec(ready)[1],extensionId:'agijcmabomapmbobdgblmckibkpobdij'};
  await writeFile(output+'/artifacts.json',JSON.stringify(artifacts,null,2));console.log(JSON.stringify(artifacts,null,2));
}catch(error){failed=error;}
finally{
  await browser?.close();for(const server of servers)await server.close();
  const after=await inventory();
  await writeFile(output+'/protected-after.json',JSON.stringify(after,null,2));
  const protection={unchanged:JSON.stringify(before)===JSON.stringify(after),paths:protectedPaths,files:before.filter(row=>row.kind==='file').length,checks:['SHA-256','size','file mtime','directory mtime']};
  await writeFile(output+'/protected-outputs.json',JSON.stringify(protection,null,2));
  await writeFile(output+'/results.json',JSON.stringify({passed:!failed,results,captures,errors,failure:failed?.stack},null,2));
  const rel=relative(tmpdir(),temporary);
  assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..')&&temporary.startsWith(resolve(tmpdir())+sep),'cleanup must stay inside OS temp');
  await rm(temporary,{recursive:true,force:true});
  await writeFile(output+'/temporary-cleanup.json',JSON.stringify({temporary,removed:true},null,2));
  assert.equal(protection.unchanged,true,'protected releases changed');
}
if(failed)throw failed;
console.log('PASS direct-only copy, tests, full overflow matrix, rebuild and output protection');
