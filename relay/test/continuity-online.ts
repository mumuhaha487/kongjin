// One invocation = one online writing acceptance round; never rerun automatically.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {continuityE2E} from './continuity-e2e.ts';
import {network} from '../scripts/network.mjs';
import {checkR2,checkContinuityR2} from '../scripts/r2.mjs';
const base='https://kongjing.inc.re',proxy='http://127.0.0.1:10808',net=network(proxy),roomsSeen:string[]=[];
try{
 await continuityE2E(base,proxy,async(rooms,needles)=>{
  roomsSeen.push(...rooms.keys());let journalRows=0,slotRows=0;
  // Authenticated read routes SELECT the actual SQLite env BLOB and return its exact envelope fields.
  // No production debug route, DO export, or access to any customer room is introduced.
  for(const[room,token]of rooms){
   for(const channel of ['journal','slots']){
    const r=await net.fetch(base+'/v1/groups/'+room+'/'+channel,{headers:{'X-KJ-Token':token}});
    if(r.status===410){await r.text();continue;}assert.equal(r.status,200);
    const data:any=await r.json();for(const row of channel==='journal'?data.items:data.slots){
     const raw=Buffer.concat([Buffer.from(row.env.iv,'base64url'),Buffer.from(row.env.ct,'base64url')]);
     for(const n of needles)assert.equal(raw.includes(Buffer.from(n)),false);
     if(channel==='journal')journalRows++;else slotRows++;
    }
   }
  }
  assert.ok(journalRows>0&&slotRows>0);
  return{journalRows,slotRows,containsPlaintext:false,doSource:'authenticated SELECT env responses (no physical SQLite file export)',r2Snapshots:await checkR2([...rooms.keys()],needles),r2Blobs:await checkContinuityR2([...rooms.keys()],needles)};
 },'online-v221');
 for(const room of roomsSeen){const r=await net.fetch(base+'/v1/groups/'+room+'/journal');assert.equal(r.status,401);await r.text();}
 console.log('One online round complete; test rooms retired and R2 snapshot/forward cleanup complete.');
}finally{await net.close();}
