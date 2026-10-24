import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {chromium} from 'playwright';
import {unzipSync} from 'fflate';
import {check} from './check.mjs';
import {singleLineAudit} from './single-line-audit.mjs';
import {singleLineCaptures} from './single-line-captures-233.mjs';

const baseline=process.argv.includes('--baseline'),capturesOnly=process.argv.includes('--captures-only'),output=resolve('../docs/v6/v333-evidence',baseline?'baseline':capturesOnly?'capture-recheck':'final');
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(resolve(tmpdir(),'kongjing-release-233-'));
const protectedPaths=['../release/kongjing-2.3.1.zip','../release/kongjing-2.3.2.zip','../release/android','../release/store','dist-store'].map(path=>resolve(path));
const npm=resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const env={...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',KJ_PLATFORM:'desktop',KJ_STORE:'0',KJ_PROFILE:'0',KJ_PERF_MAP:'0',KJ_SMOKE_CAPTURE:'0'};
const results=[];let failed;
async function inventory(){
  const rows=[];
  async function visit(path){const info=await stat(path);if(info.isDirectory()){rows.push({path,kind:'directory',mtime:info.mtimeMs});for(const name of(await readdir(path)).sort())await visit(resolve(path,name));}else rows.push({path,kind:'file',mtime:info.mtimeMs,size:info.size,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});}
  for(const path of protectedPaths)await visit(path);return rows;
}
const before=await inventory();await writeFile(output+'/protected-before.json',JSON.stringify(before,null,2));
async function run(name,args,extra={}){
  console.log('RUN '+name);
  return new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,args,{windowsHide:true,env:{...env,...extra}});let log='';
    child.stdout.on('data',b=>{log+=b;if(name==='local-edge')process.stdout.write(b);});child.stderr.on('data',b=>log+=b);child.on('error',reject);
    child.on('close',async code=>{await writeFile(output+'/'+name+'.log',log);results.push({name,passed:code===0});if(code!==0)reject(Error(name+' failed:\n'+log.slice(-8000)));else{console.log('PASS '+name);resolveRun();}});
  });
}
try{
  const browser=await chromium.launch({executablePath:resolve('tests/.browser/chrome-win/chrome.exe')});
  try{
    const page=await browser.newPage();
    await page.setContent('<style>.badge{width:16px;font:14px/20px sans-serif}.chip{width:32px;font:14px/20px sans-serif}button{width:20px;font:14px/20px sans-serif}</style><div class="badge">离线</div><div class="chip">仅本机</div><button><span>全部打开</span></button><p>允许多行的正文与说明</p>');
    const bad=await page.evaluate(singleLineAudit);assert.equal(bad.issues.length,3);
    await page.addStyleTag({content:'.badge,.chip,button{white-space:nowrap;flex-shrink:0}'});
    const good=await page.evaluate(singleLineAudit);assert.equal(good.issues.length,0);assert.equal(good.checked,3);
    await writeFile(output+'/single-line-detector.json',JSON.stringify({passed:true,wrapped:bad,singleLine:good},null,2));
  }finally{await browser.close();}
  if(!baseline&&!capturesOnly&&!process.argv.includes('--qa-only')){
    const checks=await Promise.allSettled([
      run('lint',['node_modules/eslint/bin/eslint.js','src','tests']),
      run('unit-self',['node_modules/vitest/vitest.mjs','run']),
      run('unit-android',['node_modules/vitest/vitest.mjs','run'],{KJ_PLATFORM:'android'}),
      run('unit-store',['node_modules/vitest/vitest.mjs','run','--exclude','tests/continuity*.test.ts'],{KJ_STORE:'1'}),
    ]);for(const check of checks)if(check.status==='rejected')throw check.reason;
    await run('pack-self',[npm,'run','pack']);
    await run('build-android',[npm,'run','build:android']);
    await run('check-self',[npm,'run','check']);
  }
  if(!baseline){
    await run('check-store-current',['scripts/check.mjs','--build-only'],{KJ_STORE:'1'});
    const archive=unzipSync(await readFile('../release/store/kongjing-2.0.7-store.zip'));
    const store=resolve(temporary,'store-archive');
    for(const [name,bytes]of Object.entries(archive)){
      const path=resolve(store,name);assert.ok(path.startsWith(store+sep));
      await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);
    }
    await check([store],true);
    await writeFile(output+'/check-store-archive.json',JSON.stringify({passed:true,version:'2.0.7',files:Object.keys(archive).length,method:'Read-only ZIP extraction to OS temporary directory, validate permissions/CSP/isolation/sensitive values independently of pre-existing dist-store byte differences.'},null,2));
    results.push({name:'check-store-archive',passed:true});
  }
  const qa=resolve(temporary,'android-qa');
  await run('qa-android',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',qa,'--emptyOutDir'],{KJ_PLATFORM:'android'});
  if(!capturesOnly){
  try{await run('overflow-full',['node_modules/tsx/dist/cli.mjs','scripts/overflow-v3.mjs'],{KJ_PLATFORM:'android',KJ_QA_ANDROID_DIR:qa,KJ_EVIDENCE:output+'/overflow',KJ_AUDIT_QUICK:'0'});}catch(error){if(!baseline)throw error;}
  const matrix=JSON.parse(await readFile(output+'/overflow/overflow-results.json','utf8'));assert.equal(matrix.results.length,1200);assert.deepEqual(matrix.errors,[]);
  const counts={};for(const row of matrix.results)for(const issue of row.issues){const key=issue.kind+' | '+(issue.label||issue.text||'');counts[key]=(counts[key]||0)+1;}
  await writeFile(output+'/violations.json',JSON.stringify({cases:matrix.results.length,affectedCases:matrix.results.filter(row=>row.issues.length).length,singleLineChecks:matrix.results.reduce((sum,row)=>sum+row.singleLineChecks,0),counts},null,2));
  if(!baseline)assert.equal(matrix.results.filter(row=>row.issues.length).length,0);
  }
  if(!baseline){
    const desktopQa=resolve(temporary,'desktop-qa');
    await run('qa-desktop',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',desktopQa,'--emptyOutDir']);
    await singleLineCaptures(desktopQa,qa,output);
    if(!capturesOnly&&!process.argv.includes('--skip-local'))await run('local-edge',['node_modules/tsx/dist/cli.mjs','scripts/v3-integration.mjs','--memory-backend'],{KJ_EVIDENCE:output+'/local',KJ_TEST_ROOT:resolve(temporary,'integration')});
    const ready=await readFile('dist-android/READY.md','utf8');
    const artifacts={version:'2.3.3',zip:'release/kongjing-2.3.3.zip',zipSha256:createHash('sha256').update(await readFile('../release/kongjing-2.3.3.zip')).digest('hex'),androidBuildTime:/构建时间：([^\n]+)/.exec(ready)[1],extensionId:'agijcmabomapmbobdgblmckibkpobdij'};
    await writeFile(output+'/artifacts.json',JSON.stringify(artifacts,null,2));console.log(JSON.stringify(artifacts,null,2));
  }
}catch(error){failed=error;}
finally{
  const after=await inventory();await writeFile(output+'/protected-after.json',JSON.stringify(after,null,2));
  const protection={unchanged:JSON.stringify(before)===JSON.stringify(after),paths:protectedPaths,files:before.filter(row=>row.kind==='file').length};
  await writeFile(output+'/protected-outputs.json',JSON.stringify(protection,null,2));
  if(!protection.unchanged&&!failed)failed=Error('Protected outputs changed; inspect protected-before/after without reverting parallel work.');
  await writeFile(output+'/results.json',JSON.stringify({passed:!failed,baseline,capturesOnly,results,error:failed?.stack},null,2));
  const rel=relative(tmpdir(),temporary);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..')&&temporary.startsWith(resolve(tmpdir())+sep));
  await rm(temporary,{recursive:true,force:true});await writeFile(output+'/temporary-cleanup.json',JSON.stringify({temporary,removed:true},null,2));
}
if(failed)throw failed;
console.log('PASS '+(baseline?'single-line baseline collected':capturesOnly?'2.3.3 screenshot recheck and output protection':'2.3.3 regression, matrix, local Edge and output protection'));
