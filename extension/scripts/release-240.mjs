import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve,sep} from 'node:path';
import {unzipSync} from 'fflate';
import {check} from './check.mjs';
const output=resolve('../docs/v7/evidence');await mkdir(output,{recursive:true});
const temporary=await mkdtemp(resolve(tmpdir(),'kongjing-240-qa-'));
const npm=resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const env={...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',KJ_PLATFORM:'desktop',KJ_STORE:'0',KJ_PROFILE:'0',KJ_PERF_MAP:'0',KJ_SMOKE_CAPTURE:'0'};
const finalOnly=process.argv.includes('--final-only');
const results=finalOnly?JSON.parse(await readFile(output+'/release-results.json','utf8')).filter(r=>r.passed):[];
async function run(name,args,extra={}){console.log('RUN '+name);return new Promise((ok,no)=>{const p=spawn(process.execPath,args,{env:{...env,...extra},windowsHide:true});let log='';p.stdout.on('data',b=>{log+=b;if(name.includes('home'))process.stdout.write(b);});p.stderr.on('data',b=>log+=b);p.on('error',no);p.on('close',async code=>{await writeFile(output+'/'+name+'.log',log);results.push({name,passed:code===0});if(code)no(Error(name+' failed:\n'+log.slice(-7000)));else{console.log('PASS '+name);ok();}});});}
try{
 if(!finalOnly){
 if(!process.argv.includes('--qa-only')){
  const tests=await Promise.allSettled([
   run('lint',['node_modules/eslint/bin/eslint.js','src','tests']),
   run('unit-self',['node_modules/vitest/vitest.mjs','run']),
   run('unit-android',['node_modules/vitest/vitest.mjs','run'],{KJ_PLATFORM:'android'}),
   run('unit-store',['node_modules/vitest/vitest.mjs','run','--exclude','tests/continuity*.test.ts'],{KJ_STORE:'1'}),
  ]);for(const test of tests)if(test.status==='rejected')throw test.reason;
  await run('pack-self',[npm,'run','pack']);
  await run('build-android',[npm,'run','build:android']);
  await run('check-self',[npm,'run','check']);
  await run('check-android',['node_modules/tsx/dist/cli.mjs','scripts/android-check.mjs']);
 }
 await run('check-store-current',['scripts/check.mjs','--build-only'],{KJ_STORE:'1'});
 const archive=unzipSync(await readFile('../release/store/kongjing-2.0.7-store.zip')),store=resolve(temporary,'store');
 for(const[name,bytes]of Object.entries(archive)){const path=resolve(store,name);assert.ok(path.startsWith(store+sep));await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);}await check([store],true);results.push({name:'check-store-archive',passed:true});
 const qa=resolve(temporary,'android');await run('qa-android',['node_modules/vite/bin/vite.js','build','--mode','qa','--outDir',qa,'--emptyOutDir'],{KJ_PLATFORM:'android'});
 await run('overflow-full',['node_modules/tsx/dist/cli.mjs','scripts/overflow-v3.mjs'],{KJ_PLATFORM:'android',KJ_QA_ANDROID_DIR:qa,KJ_EVIDENCE:output+'/overflow',KJ_AUDIT_QUICK:'0'});
 await run('ui-android',['node_modules/tsx/dist/cli.mjs','scripts/android-ui.mjs'],{KJ_PLATFORM:'android',KJ_QA_ANDROID_DIR:qa});
 }
 await run('home-visual-perf',['node_modules/tsx/dist/cli.mjs','scripts/home-240.mjs']);
 const ready=await readFile('dist-android/READY.md','utf8'),zip=await readFile('../release/kongjing-2.4.0.zip'),zipped=unzipSync(zip);
 for(const[name,bytes]of Object.entries(zipped))assert.deepEqual(Buffer.from(bytes),await readFile(resolve('../release/unpacked',name)));
 await writeFile(output+'/artifacts.json',JSON.stringify({version:'2.4.0',zipSha256:createHash('sha256').update(zip).digest('hex'),androidBuildTime:/构建时间：([^\n]+)/.exec(ready)[1],extensionId:'agijcmabomapmbobdgblmckibkpobdij',zipFiles:Object.keys(zipped).length},null,2));
}finally{await writeFile(output+'/release-results.json',JSON.stringify(results,null,2));assert.ok(temporary.startsWith(resolve(tmpdir())+sep));await rm(temporary,{recursive:true,force:true});}
console.log('PASS 2.4.0 release');
