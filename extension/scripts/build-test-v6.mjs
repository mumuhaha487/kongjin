import {spawn} from 'node:child_process';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
const npm=resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const hash=async()=>createHash('sha256').update(await readFile('../shared/protocol/src/sync.ts')).digest('hex');
const protocolBefore=await hash();
for(const [name,script,env] of [
 ['lint-self','lint',{}],['lint-store','lint:store',{}],['lint-android','lint',{KJ_PLATFORM:'android'}],
 ['test-self','test',{}],['test-store','test:store',{}],['test-android','test',{KJ_PLATFORM:'android'}],
 ['build-self','build',{}],['build-store','build:store',{}],['build-android','build:android',{}]
]) {
 if(process.argv.includes('--units')&&!name.startsWith('test-'))continue;
 console.log('RUN',name);const child=spawn(process.execPath,[npm,'run',script],{windowsHide:true,env:{...process.env,KJ_BLOCK_ONLINE_RELAY:'1',KJ_STORE_OFFLINE_ONLY:'1',...env}});
 let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r)});
 await writeFile('tests/v6-'+name+'.log',log);if(code!==0)throw Error(name+'\n'+log.slice(-7000));console.log('PASS',name,log.trim().split('\n').slice(-4).join('\n'));
}
const protocolAfter=await hash();assert.equal(protocolAfter,protocolBefore,'Protocol source changed during verification');
await writeFile('tests/v6-verified-protocol.json',JSON.stringify({protocolBefore,protocolAfter},null,2));
