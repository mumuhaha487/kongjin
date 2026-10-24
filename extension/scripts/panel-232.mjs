import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {chromium} from 'playwright';
import postcss from 'postcss';
import sharp from 'sharp';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {nativeMock} from './android-fixtures.mjs';

// All bundles are disposable QA output. Production and acceptance folders are read-only.
const output=resolve('../docs/v6/v332-evidence');
await mkdir(output+'/screenshots',{recursive:true});
const temporary=await mkdtemp(resolve(tmpdir(),'kongjing-panel-232-'));
const protectedPaths=[resolve('dist-android'),resolve('../release/unpacked'),resolve('../release/kongjing-2.3.1.zip')];
const results=[],errors=[],servers=[],screenshots=[];
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
async function run(name,args,env={}){
  await new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,args,{windowsHide:true,env:{...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',KJ_STORE:'0',KJ_PROFILE:'0',KJ_PERF_MAP:'0',...env}});
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
async function capture(page,name,locator=page){
  const file='panel-'+name+'.png';
  await locator.screenshot({path:output+'/screenshots/'+file});
  const {width,height}=await sharp(output+'/screenshots/'+file).metadata();
  screenshots.push({file,width,height});
}
async function section(page,title){
  const heading=page.locator('.settings-content h3').filter({hasText:new RegExp('^'+title+'$')});
  await heading.evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.waitForTimeout(200);
}
async function snapshotStyles(page){
  return page.evaluate(()=>{
    const panel=document.querySelector('.settings-panel');
    const normalize=(property,value)=>{
      const probe=document.createElement('i');probe.style[property]=value;document.body.append(probe);
      const answer=getComputedStyle(probe)[property];probe.remove();return answer;
    };
    return {
      panelBackground:getComputedStyle(panel).backgroundColor,
      backdrop:getComputedStyle(panel).backdropFilter,
      scrim:normalize('backgroundColor','var(--scrim)'),
      toggleOff:normalize('backgroundColor','var(--toggle-off)'),
      toggles:[...document.querySelectorAll('.toggle')].map(el=>({
        label:el.getAttribute('aria-label'),on:el.classList.contains('on'),disabled:el.disabled,
        background:getComputedStyle(el).backgroundColor,knob:getComputedStyle(el.firstElementChild).backgroundColor,
        shadow:getComputedStyle(el.firstElementChild).boxShadow,
      })),
      accent:normalize('backgroundColor','var(--accent)'),
      shadow:normalize('boxShadow','0 1px 2px rgba(10,20,40,.28),0 0 0 .5px rgba(10,20,40,.10)'),
      disabledShadow:normalize('boxShadow','0 1px 3px rgba(0,0,0,.3)'),
    };
  });
}
function checkToggles(styles,theme){
  const expected=theme==='light'?'rgba(30, 60, 120, 0.16)':'rgba(160, 190, 255, 0.22)';
  assert.equal(styles.toggleOff,expected);
  assert.ok(styles.toggles.some(t=>!t.on));
  for(const toggle of styles.toggles){
    assert.equal(toggle.background,toggle.on?styles.accent:expected,toggle.label+' track');
    assert.equal(toggle.knob,'rgb(255, 255, 255)',toggle.label+' white knob');
    assert.equal(toggle.shadow,toggle.on&&toggle.disabled?styles.disabledShadow:styles.shadow,toggle.label+' shadow');
  }
}
async function noBleed(page,platform,theme){
  await page.evaluate(()=>{
    document.getAnimations().forEach(a=>a.pause());
    const probe=document.createElement('div');probe.id='panel-qa-bleed';
    Object.assign(probe.style,{position:'fixed',inset:'0',zIndex:'39',pointerEvents:'none',background:'rgb(255,0,0)'});
    document.body.append(probe);
  });
  const box=await page.locator('.settings-panel').boundingBox();
  // Exclude rounded corners and the deliberately translucent 1px border.
  const clip={x:box.x+24,y:box.y+32,width:box.width-48,height:box.height-64};
  const red=await page.screenshot({clip});
  await page.evaluate(()=>{document.getElementById('panel-qa-bleed').style.background='rgb(0,0,255)';});
  const blue=await page.screenshot({clip});
  await page.evaluate(()=>document.getElementById('panel-qa-bleed').remove());
  const a=await sharp(red).removeAlpha().raw().toBuffer(),b=await sharp(blue).removeAlpha().raw().toBuffer();
  assert.equal(a.length,b.length);
  let maxDifference=0,changedChannels=0;
  for(let i=0;i<a.length;i++){const difference=Math.abs(a[i]-b[i]);maxDifference=Math.max(maxDifference,difference);if(difference)changedChannels++;}
  const evidence={platform,theme,scene:'opaque-occlusion',maxDifference,changedChannels,channels:a.length};
  results.push(evidence);
  if(changedChannels){
    await writeFile(output+'/screenshots/panel-bleed-failure-red.png',red);
    await writeFile(output+'/screenshots/panel-bleed-failure-blue.png',blue);
  }
  assert.equal(maxDifference,0,'Content under the opaque panel must not affect any interior pixel');
}
async function open(browser,server,platform,theme,unsupported=false){
  const android=platform==='android';
  const context=await browser.newContext({viewport:android?{width:412,height:915}:{width:1440,height:900},deviceScaleFactor:android?2.625:2,isMobile:android,hasTouch:android,reducedMotion:'reduce',locale:'zh-CN',timezoneId:'Asia/Singapore'});
  if(android)await nativeMock(context);
  await setup(context,fixture(theme),{'kj:mock':{paired:true}});
  let fallbackRules=0;
  if(unsupported)await context.route('**/*.css',async route=>{
    const response=await route.fetch();
    const css=postcss.parse(await response.text());
    // Exercise the exact shipped fallback declarations in a browser that
    // supports blur, by making only their @supports guard evaluate true.
    css.walkAtRules('supports',rule=>{
      if(rule.params.includes('backdrop-filter')&&rule.params.startsWith('not')){
        rule.params='not (kj-qa-unsupported-property: 1)';fallbackRules++;
      }
    });
    await route.fulfill({response,body:css.toString()});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.clock.setFixedTime(new Date('2026-10-24T12:51:00+08:00'));
  await page.goto(server.base);await page.waitForFunction(()=>window.kjTest?.getState().status.paired);
  if(android)await page.waitForFunction(()=>window.__nativeCalls.some(c=>c.method==='ready'));
  await page.waitForTimeout(700);
  if(android){
    await page.getByRole('button',{name:'我的',exact:true}).click();
    await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  }else await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.waitForTimeout(700);
  if(android)await page.waitForFunction(()=>{
    const layer=document.querySelector('.settings-layer'),panel=layer.querySelector('.settings-panel');
    return layer.dataset.open==='true'&&getComputedStyle(layer).visibility==='visible'&&panel.getAnimations().length===0;
  });
  return {context,page,fallbackRules:()=>fallbackRules};
}
async function inspect(platform,server,theme){
  const {context,page}=await open(browser,server,platform,theme);
  try{
    await section(page,'书签');
    const styles=await snapshotStyles(page);
    checkToggles(styles,theme);
    if(platform==='android'){
      assert.equal(styles.panelBackground,theme==='light'?'rgb(247, 250, 254)':'rgb(12, 18, 34)');
      assert.equal(styles.backdrop,'none');
      assert.equal(styles.scrim,theme==='light'?'rgba(0, 4, 16, 0.22)':'rgba(0, 4, 16, 0.32)');
      await capture(page,`android-settings-bookmarks-${theme}`);
      await section(page,'浏览器');
      const off=page.getByRole('switch',{name:'在新标签页打开书签',exact:true});
      assert.equal(await off.getAttribute('aria-checked'),'false');
      await capture(page,`android-settings-browser-${theme}`);
      if(theme==='light')await capture(page,'toggle-off-light',off.locator('..'));
      await noBleed(page,platform,theme);
      // All overlay types share --glass, but verify their actual computed
      // backgrounds as well, including portalled menus and toast surfaces.
      await page.evaluate(()=>window.kjTest.setState({settingsOpen:false,overlay:{type:'bookmark',id:'default-common'}}));
      const bookmark=page.getByRole('dialog',{name:'添加书签',exact:true});
      await bookmark.waitFor();await page.waitForTimeout(300);
      assert.equal(await bookmark.evaluate(e=>getComputedStyle(e).backgroundColor),styles.panelBackground);
      await page.keyboard.press('Escape');await page.waitForTimeout(300);
      await page.locator('.engine-trigger').click();await page.waitForTimeout(200);
      assert.equal(await page.getByRole('menu',{name:'搜索引擎',exact:true}).evaluate(e=>getComputedStyle(e).backgroundColor),styles.panelBackground);
      await page.keyboard.press('Escape');
      await page.evaluate(()=>window.kjTest.setState({toasts:[{id:232,text:'本设备已被移出配对组',type:'removed'}]}));
      await page.locator('.toast').waitFor();await page.waitForTimeout(200);
      assert.equal(await page.locator('.toast').evaluate(e=>getComputedStyle(e).backgroundColor),styles.panelBackground);
    }else{
      assert.equal(styles.panelBackground,theme==='light'?'rgba(247, 250, 254, 0.74)':'rgba(10, 16, 32, 0.7)');
      assert.equal(styles.backdrop,'blur(28px) saturate(1.5)');
      await capture(page,`desktop-settings-${theme}`);
      const session=await context.newCDPSession(page);
      await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-reduced-motion',value:'reduce'}]});
      assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-transparency: reduce)').matches),true);
      await page.waitForFunction(expected=>getComputedStyle(document.querySelector('.settings-panel')).backgroundColor===expected,theme==='light'?'rgb(247, 250, 254)':'rgb(12, 18, 34)',{timeout:3000});
      assert.equal((await snapshotStyles(page)).panelBackground,theme==='light'?'rgb(247, 250, 254)':'rgb(12, 18, 34)');
      results.push({platform,theme,scene:'reduced-transparency',passed:true});
    }
    results.push({platform,theme,scene:'normal',passed:true,styles});
  }finally{await context.close();}
}
try{
  const desktop=resolve(temporary,'desktop'),android=resolve(temporary,'android');
  await run('panel-qa-desktop',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',desktop,'--emptyOutDir'],{KJ_PLATFORM:'desktop'});
  await run('panel-qa-android',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',android,'--emptyOutDir'],{KJ_PLATFORM:'android'});
  const desktopServer=await homeServer(desktop,0),androidServer=await homeServer(android,0);servers.push(desktopServer,androidServer);
  browser=await chromium.launch({executablePath:resolve('tests/.browser/chrome-win/chrome.exe'),args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND']});
  for(const theme of ['light','dark']){
    await inspect('desktop',desktopServer,theme);
    await inspect('android',androidServer,theme);
    const fallback=await open(browser,desktopServer,'desktop',theme,true);
    try{
      assert.ok(fallback.fallbackRules()>0,'shipped unsupported-blur guard must be exercised');
      const background=(await snapshotStyles(fallback.page)).panelBackground;
      assert.equal(background,theme==='light'?'rgb(247, 250, 254)':'rgb(12, 18, 34)');
      results.push({platform:'desktop',theme,scene:'unsupported-backdrop-filter',passed:true,background,method:'QA route activates the shipped @supports fallback guard'});
    }finally{await fallback.context.close();}
  }
  assert.deepEqual(errors,[]);
  await writeFile(output+'/panel-screenshots.json',JSON.stringify(screenshots,null,2));
  console.log(`PASS ${results.length} panel checks and ${screenshots.length} screenshots`);
  await run('panel-overflow-full',['node_modules/tsx/dist/cli.mjs','scripts/overflow-v3.mjs'],{KJ_PLATFORM:'android',KJ_QA_ANDROID_DIR:android,KJ_EVIDENCE:output+'/panel-overflow'});
}catch(error){failed=error;}
finally{
  await browser?.close();for(const server of servers)await server.close();
  const after=await inventory();
  const protection={unchanged:JSON.stringify(before)===JSON.stringify(after),paths:protectedPaths,files:before.filter(r=>r.kind==='file').length,checks:['SHA-256','size','file mtime','directory mtime']};
  await writeFile(output+'/panel-protected-outputs.json',JSON.stringify(protection,null,2));
  await writeFile(output+'/panel-results.json',JSON.stringify({passed:!failed,results,errors,failure:failed?.stack},null,2));
  const rel=relative(tmpdir(),temporary);
  assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..')&&temporary.startsWith(resolve(tmpdir())+sep),'cleanup must stay inside OS temp');
  await rm(temporary,{recursive:true,force:true});
  await writeFile(output+'/panel-temporary-cleanup.json',JSON.stringify({temporary,removed:true},null,2));
  assert.equal(protection.unchanged,true,'protected 2.3.1 outputs changed');
}
if(failed)throw failed;
console.log('PASS full overflow matrix; protected acceptance outputs unchanged; temporary QA bundles deleted');
