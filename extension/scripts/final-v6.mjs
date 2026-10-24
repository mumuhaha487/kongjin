import {spawn} from 'node:child_process';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';
const npm=resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const protocolHash=async()=>createHash('sha256').update(await readFile('../shared/protocol/src/sync.ts')).digest('hex');
const before=await protocolHash();
for(const [name,script] of [
 ['pack-self','pack'],['build-android-final','build:android'],['pack-store','pack:store'],
 ['check-self','check'],['check-store','check:store'],['check-android-final','check:android'],
 ['smoke-self','smoke'],['smoke-store','smoke:store']
]) {
 console.log('RUN',name);
 const child=spawn(process.execPath,[npm,'run',script],{windowsHide:true,env:{...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',KJ_SMOKE_CAPTURE:'0'}});
 let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r)});
 await writeFile('tests/v6-'+name+'.log',log);
 if(code!==0)throw Error(name+'\n'+log.slice(-10000));
 console.log('PASS',name,log.trim().split('\n').slice(-4).join('\n'));
}
const after=await protocolHash();assert.equal(after,before,'Protocol changed while final builds ran');
await writeFile('tests/v6-pack-protocol.json',JSON.stringify({before,after},null,2));
