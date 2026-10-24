import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,sep} from 'node:path';
import {unzipSync} from 'fflate';
import {check} from './check.mjs';
const archive='../release/store/kongjing-2.0.7-store.zip';
const bytes=await readFile(archive),sha256=createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256,'e3efd292a278914f982ce4161877da755658c669f47c759ea9a3bad290b3058c','frozen store ZIP must remain unchanged');
const root=await mkdtemp(resolve('tests/.store-frozen-check-'));
for(const [name,data]of Object.entries(unzipSync(bytes))){
 const path=resolve(root,name);assert.ok(path.startsWith(root+sep));await mkdir(dirname(path),{recursive:true});await writeFile(path,data);
}
await check([resolve('dist-store'),root],true);
const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
const result={passed:true,archive,sha256,permissions:manifest.permissions,host_permissions:manifest.host_permissions,keyPresent:'key'in manifest,method:'current store build + frozen original ZIP structural, CSP, isolation, worker and sensitive-value checks; original ZIP exact hash preserved'};
await mkdir('../docs/v6/v331-evidence',{recursive:true});await writeFile('../docs/v6/v331-evidence/store-frozen-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
