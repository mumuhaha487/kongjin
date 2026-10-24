import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {unzipSync} from 'fflate';
import {check} from './check.mjs';

const output=resolve('../docs/v6/v332-evidence/build');
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(resolve(tmpdir(),'kongjing-release-232-'));
const protectedPaths=[resolve('../release/kongjing-2.3.1.zip'),resolve('../release/android'),resolve('../release/store'),resolve('dist-store')];
const npm=resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const env={...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',KJ_PLATFORM:'desktop',KJ_STORE:'0',KJ_PROFILE:'0',KJ_PERF_MAP:'0',KJ_SMOKE_CAPTURE:'0'};
const results=[];
let failed;
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
    const child=spawn(process.execPath,args,{windowsHide:true,env:{...env,...extra}});
    let log='';
    child.stdout.on('data',b=>{log+=b;if(name==='local-upgrade-sync')process.stdout.write(b);});
    child.stderr.on('data',b=>log+=b);
    child.on('error',reject);
    child.on('close',async code=>{
      await writeFile(output+'/'+name+'.log',log);
      results.push({name,passed:code===0});
      if(code!==0)reject(Error(name+' failed:\n'+log.slice(-8000)));
      else{console.log('PASS '+name);resolveRun();}
    });
  });
}
try{
  await cp(process.env.KJ_232_OLD_ANDROID_DIR||'dist-android',resolve(temporary,'old-android'),{recursive:true});
  assert.match(await readFile(resolve(temporary,'old-android/READY.md'),'utf8'),/主页版本：2\.3\.1/);
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
  // The store's existing build and archive remain byte-for-byte untouched.
  await check([resolve('dist-store')],true);
  const frozenStore=resolve(temporary,'frozen-store');
  for(const [name,data]of Object.entries(unzipSync(await readFile('../release/store/kongjing-2.0.7-store.zip')))){
    const path=resolve(frozenStore,name);assert.ok(path.startsWith(frozenStore+sep));
    await mkdir(dirname(path),{recursive:true});await writeFile(path,data);
  }
  await check([frozenStore],true);
  results.push({name:'frozen-store-check',passed:true});
  const androidChecks=await Promise.allSettled([
    run('check-android',[npm,'run','check:android']),
    run('legacy-android',[npm,'run','smoke:legacy:android']),
    run('smoke-self',[npm,'run','smoke']),
  ]);
  for(const check of androidChecks)if(check.status==='rejected')throw check.reason;
  const qa=resolve(temporary,'android-qa');
  await run('build-qa-android',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',qa,'--emptyOutDir'],{KJ_PLATFORM:'android'});
  await run('overflow-full',['node_modules/tsx/dist/cli.mjs','scripts/overflow-v3.mjs'],{KJ_PLATFORM:'android',KJ_QA_ANDROID_DIR:qa,KJ_EVIDENCE:output+'/overflow',KJ_AUDIT_QUICK:'0'});
  const matrix=JSON.parse(await readFile(output+'/overflow/overflow-results.json','utf8'));
  assert.equal(matrix.results.length,1176);
  assert.equal(matrix.results.filter(row=>row.issues.length).length,0);
  assert.deepEqual(matrix.errors,[]);
  await run('local-upgrade-sync',['node_modules/tsx/dist/cli.mjs','scripts/v3-integration.mjs','--upgrade-from-231','--memory-backend'],{KJ_EVIDENCE:output+'/local-upgrade',KJ_TEST_ROOT:resolve(temporary,'integration'),KJ_OLD_ANDROID_DIR:resolve(temporary,'old-android')});
  const zip=await readFile('../release/kongjing-2.3.2.zip');
  const manifest=JSON.parse(Buffer.from(unzipSync(zip)['manifest.json']).toString());
  assert.equal(manifest.version,'2.3.2');
  const ready=await readFile('dist-android/READY.md','utf8');
  assert.match(ready,/主页版本：2\.3\.2/);assert.match(ready,/2\.3\.2 已包含设备行间距/);
  const protocol=Object.fromEntries(await Promise.all(
    ['sync.ts','sync-edge.ts','peer-mesh.ts'].map(async name=>
      [name,createHash('sha256').update(await readFile('../shared/protocol/src/'+name)).digest('hex')]
    )
  ));
  const artifacts={version:'2.3.2',zip:'release/kongjing-2.3.2.zip',zipSha256:createHash('sha256').update(zip).digest('hex'),crxSha256:createHash('sha256').update(await readFile('../release/kongjing-2.3.2.crx')).digest('hex'),androidBuildTime:/构建时间：([^\n]+)/.exec(ready)[1],protocol};
  await writeFile(output+'/artifacts.json',JSON.stringify(artifacts,null,2));
  console.log(JSON.stringify(artifacts,null,2));
}catch(error){failed=error;}
finally{
  const after=await inventory();
  const protection={unchanged:JSON.stringify(before)===JSON.stringify(after),paths:protectedPaths,files:before.filter(row=>row.kind==='file').length,checks:['SHA-256','size','file mtime','directory mtime']};
  await writeFile(output+'/protected-outputs.json',JSON.stringify(protection,null,2));
  await writeFile(output+'/results.json',JSON.stringify({passed:!failed,results,failure:failed?.stack},null,2));
  const rel=relative(tmpdir(),temporary);
  assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..')&&temporary.startsWith(resolve(tmpdir())+sep),'cleanup must stay inside OS temp');
  if(!failed)await rm(temporary,{recursive:true,force:true});
  await writeFile(output+'/temporary-cleanup.json',JSON.stringify({temporary,removed:!failed,preservedForRetry:!!failed},null,2));
  assert.equal(protection.unchanged,true,'protected release/store/android/2.3.1 outputs changed');
}
if(failed)throw failed;
console.log('PASS 2.3.2 production build, regression, upgrade and output protection');
