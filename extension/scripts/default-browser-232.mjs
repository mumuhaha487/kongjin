import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {nativeMock,mobileOptions,bridgeCall} from './android-fixtures.mjs';

// Never use a production build command: all bundles stay in OS temp.
const output=resolve('../docs/v6/v332-evidence');
await mkdir(output+'/screenshots',{recursive:true});
const temporary=await mkdtemp(resolve(tmpdir(),'kongjing-default-browser-232-'));
const protectedPaths=[resolve('dist-android'),resolve('../release/unpacked'),resolve('../release/kongjing-2.3.1.zip')];
const results=[],screenshots=[],errors=[];
let browser,server,failed;
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
    const child=spawn(process.execPath,args,{windowsHide:true,env:{...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',KJ_PLATFORM:'android',KJ_STORE:'0',KJ_PROFILE:'0',KJ_PERF_MAP:'0',...env}});
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
async function capture(page,name){
  const file='default-browser-'+name+'.png';
  await page.screenshot({path:output+'/screenshots/'+file});
  const {width,height}=await sharp(output+'/screenshots/'+file).metadata();
  screenshots.push({file,width,height,viewport:mobileOptions.viewport,dpr:mobileOptions.deviceScaleFactor,theme:'light'});
}
async function checkRow(page,isDefault){
  const styles=await page.locator('.native-browser-prefs .setting-row').first().evaluate(row=>{
    const target=row.children[1],css=getComputedStyle(target),icon=target.querySelector('svg');
    const normalize=value=>{
      const probe=document.createElement('i');probe.style.color=value;document.body.append(probe);
      const color=getComputedStyle(probe).color;probe.remove();return color;
    };
    return {
      title:row.firstElementChild.textContent,
      text:target.textContent,tag:target.tagName,color:css.color,
      fontSize:css.fontSize,
      clearFontSize:getComputedStyle(document.querySelector('#settings-browser .danger-text')).fontSize,
      height:target.getBoundingClientRect().height,
      accent:normalize('var(--accent)'),muted:normalize('var(--text-3)'),success:normalize('var(--success)'),
      interactive:target.matches('button,a,[role="button"],[tabindex]'),
      check:icon?.classList.contains('lucide-check')??false,
      iconColor:icon?getComputedStyle(icon).color:null,
      iconWidth:icon?.getBoundingClientRect().width??null,
      iconHeight:icon?.getBoundingClientRect().height??null,
    };
  });
  assert.equal(styles.title,'默认浏览器');
  assert.equal(styles.fontSize,styles.clearFontSize,'same font as 清除');
  if(isDefault){
    assert.equal(styles.text,'已是默认');
    assert.equal(styles.tag,'SPAN');
    assert.equal(styles.color,styles.muted);
    assert.equal(styles.interactive,false);
    assert.equal(styles.check,true);
    assert.equal(styles.iconColor,styles.success);
    assert.equal(styles.iconWidth,14);
    assert.equal(styles.iconHeight,14);
    assert.equal(await page.getByRole('button',{name:'去设置',exact:true}).count(),0);
  }else{
    assert.equal(styles.text,'去设置');
    assert.equal(styles.tag,'BUTTON');
    assert.equal(styles.color,styles.accent);
    assert.ok(styles.height>=44,'native settings action must be at least 44px high');
  }
  results.push({isDefault,passed:true,styles});
}
try{
  const checks=await Promise.allSettled([
    run('default-browser-lint',['node_modules/eslint/bin/eslint.js','src','tests']),
    run('default-browser-typescript',['node_modules/typescript/bin/tsc','--noEmit']),
    run('default-browser-unit-self',['node_modules/vitest/vitest.mjs','run'],{KJ_PLATFORM:'desktop'}),
    run('default-browser-unit-android',['node_modules/vitest/vitest.mjs','run']),
    run('default-browser-unit-store',['node_modules/vitest/vitest.mjs','run','--exclude','tests/continuity*.test.ts'],{KJ_STORE:'1',KJ_PLATFORM:'desktop'}),
  ]);
  for(const check of checks)if(check.status==='rejected')throw check.reason;
  const android=resolve(temporary,'android');
  await run('default-browser-qa-android',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',android,'--emptyOutDir']);
  server=await homeServer(android,0);
  browser=await chromium.launch({executablePath:resolve('tests/.browser/chrome-win/chrome.exe'),args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND']});
  const context=await browser.newContext({...mobileOptions,reducedMotion:'reduce'});
  await nativeMock(context);
  await setup(context,fixture('light'),{'kj:mock':{paired:true}});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-10-24T12:51:00+08:00'));
  await page.goto(server.base);
  await page.waitForFunction(()=>window.kjTest?.getState().status.paired&&window.__nativeCalls.some(call=>call.method==='ready'));
  await page.waitForTimeout(700);
  await page.getByRole('button',{name:'我的',exact:true}).click();
  await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  await page.waitForTimeout(700);
  await page.waitForFunction(()=>{
    const layer=document.querySelector('.settings-layer'),panel=layer.querySelector('.settings-panel');
    return layer.dataset.open==='true'&&getComputedStyle(layer).visibility==='visible'&&panel.getAnimations().length===0;
  });
  await page.locator('#settings-browser > h3').evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.waitForTimeout(200);
  await checkRow(page,false);
  await capture(page,'not-default');
  await page.getByRole('button',{name:'去设置',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__nativeCalls.filter(call=>call.method==='requestDefaultBrowser').length),1);
  await page.evaluate(()=>{window.__browserPrefs.isDefault=true;document.activeElement?.blur();});
  assert.equal((await bridgeCall(page,'browserPrefsChanged')).ok,true);
  await page.getByText('已是默认',{exact:true}).waitFor();
  await page.waitForTimeout(200);
  await checkRow(page,true);
  await capture(page,'is-default');
  // Status must remain ordinary non-interactive text, including when clicked.
  await page.getByText('已是默认',{exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__nativeCalls.filter(call=>call.method==='requestDefaultBrowser').length),1);
  await page.evaluate(()=>{window.__browserPrefs.isDefault=false;});
  assert.equal((await bridgeCall(page,'browserPrefsChanged')).ok,true);
  await page.getByRole('button',{name:'去设置',exact:true}).waitFor();
  results.push({scene:'native-preference-update-roundtrip',passed:true});
  await page.evaluate(()=>{delete window.KongjingNative.getBrowserPrefs;});
  assert.equal((await bridgeCall(page,'browserPrefsChanged')).ok,true);
  assert.equal(await page.locator('.native-browser-prefs').count(),0);
  results.push({scene:'missing-native-preferences-hide-group',passed:true});
  assert.deepEqual(errors,[]);
  await context.close();await browser.close();browser=null;
  await server.close();server=null;
  console.log('PASS default browser states, native action, missing-interface fallback and 2 screenshots');
  await run('default-browser-overflow-full',['node_modules/tsx/dist/cli.mjs','scripts/overflow-v3.mjs'],{KJ_QA_ANDROID_DIR:android,KJ_EVIDENCE:output+'/default-browser-overflow',KJ_AUDIT_QUICK:'0'});
  const matrix=JSON.parse(await readFile(output+'/default-browser-overflow/overflow-results.json','utf8'));
  assert.equal(matrix.results.length,1176);
  assert.equal(matrix.results.filter(row=>row.issues.length).length,0);
  assert.deepEqual(matrix.errors,[]);
}catch(error){failed=error;}
finally{
  await browser?.close();await server?.close();
  const after=await inventory();
  const protection={unchanged:JSON.stringify(before)===JSON.stringify(after),paths:protectedPaths,files:before.filter(row=>row.kind==='file').length,checks:['SHA-256','size','file mtime','directory mtime']};
  await writeFile(output+'/default-browser-protected-outputs.json',JSON.stringify(protection,null,2));
  await writeFile(output+'/default-browser-results.json',JSON.stringify({passed:!failed,results,screenshots,errors,failure:failed?.stack},null,2));
  const rel=relative(tmpdir(),temporary);
  assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..')&&temporary.startsWith(resolve(tmpdir())+sep),'cleanup must stay inside OS temp');
  await rm(temporary,{recursive:true,force:true});
  await writeFile(output+'/default-browser-temporary-cleanup.json',JSON.stringify({temporary,removed:true},null,2));
  assert.equal(protection.unchanged,true,'protected 2.3.1 outputs changed');
}
if(failed)throw failed;
console.log('PASS 1176 overflow combinations; protected 2.3.1 outputs unchanged; temporary QA bundle deleted');
