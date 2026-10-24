import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRouter,hash} from '../lib/router.mjs';
import {MemoryStorage} from '../lib/storage.mjs';
test('v3.3 all success/error/preflight responses expose numeric request-isolated Server-Timing',async()=>{
 const storage=new MemoryStorage(),router=createRouter({storage,secret:'test'}),room='A'.repeat(32),token='B'.repeat(43);
 await storage.set('g/'+room+'/meta',Buffer.from(JSON.stringify({tokenHash:hash(token),createdAt:Date.now()})));
 const paths=['/v2/health','/missing','/v2/rooms/'+room+'/list'];
 const responses=await Promise.all(paths.map(path=>router(new Request('https://test.example'+path,{headers:{'X-KJ-Token':token,Origin:'http://localhost'}}))));responses.push(await router(new Request('https://test.example/v2/health',{method:'OPTIONS'})));
 for(const r of responses){assert.match(r.headers.get('Server-Timing'),/^total;dur=\d+\.\d+, blob_read;dur=\d+\.\d+, blob_write;dur=\d+\.\d+, blob_list;dur=\d+\.\d+$/);assert(r.headers.get('Access-Control-Expose-Headers').includes('Server-Timing'));}
 assert.equal((await responses[0].json()).version,'3.0.2');assert.match(responses[0].headers.get('Server-Timing'),/blob_read;dur=0.00, blob_write;dur=0.00, blob_list;dur=0.00/);
});
