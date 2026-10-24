import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rename,readdir,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FileStorage} from '../lib/storage.mjs';

async function fixture(task) {
  const parent=fileURLToPath(new URL('../artifacts/',import.meta.url));
  await mkdir(parent,{recursive:true});const dir=await mkdtemp(resolve(parent,'atomic-file-'));
  assert.ok(dir.startsWith(resolve(parent)+sep));
  try { await task(dir); } finally { await rm(dir,{recursive:true,force:true}); }
}
for(const code of ['EPERM','EBUSY'])test('atomic replacement retries transient '+code+' without unlinking the old file',()=>fixture(async dir=>{
  const first=new FileStorage(dir);await first.set('state',Buffer.from('old complete state'));
  let attempts=0;const sleeps=[];
  const storage=new FileStorage(dir,{sleep:async ms=>{sleeps.push(ms);},renameFile:async(a,b)=>{
    attempts++;assert.equal(await readFile(b,'utf8'),'old complete state');
    if(attempts<=5)throw Object.assign(new Error('busy'),{code});await rename(a,b);
  }});
  await storage.set('state',Buffer.from('new complete state'));
  assert.equal(attempts,6);assert.deepEqual(sleeps,[25,50,100,200,400]);
  assert.equal(await readFile(resolve(dir,'state'),'utf8'),'new complete state');assert.deepEqual(await readdir(dir),['state']);
}));
test('exhausted EPERM retries preserve destination and clean the temporary file',()=>fixture(async dir=>{
  await new FileStorage(dir).set('state',Buffer.from('retained'));
  let attempts=0;const storage=new FileStorage(dir,{sleep:async()=>{},renameFile:async()=>{attempts++;throw Object.assign(new Error('locked'),{code:'EPERM'});}});
  await assert.rejects(storage.set('state',Buffer.from('new')), {code:'EPERM'});
  assert.equal(attempts,6);assert.equal(await readFile(resolve(dir,'state'),'utf8'),'retained');assert.deepEqual(await readdir(dir),['state']);
}));
test('non-busy rename errors fail immediately and partial write errors also clean temporary files',()=>fixture(async dir=>{
  let attempts=0;const storage=new FileStorage(dir,{renameFile:async()=>{attempts++;throw Object.assign(new Error('denied'),{code:'EACCES'});}});
  await assert.rejects(storage.set('state',Buffer.from('data')),{code:'EACCES'});assert.equal(attempts,1);assert.deepEqual(await readdir(dir),[]);
  const partial=new FileStorage(dir,{writeTemp:async(p,b,opts)=>{await writeFile(p,b.subarray(0,2),opts);throw Object.assign(new Error('full'),{code:'ENOSPC'});}});
  await assert.rejects(partial.set('state',Buffer.from('data')),{code:'ENOSPC'});assert.deepEqual(await readdir(dir),[]);
}));
