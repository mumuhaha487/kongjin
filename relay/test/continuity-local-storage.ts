import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {continuityE2E} from './continuity-e2e.ts';
const base=process.argv[2]??'http://127.0.0.1:8793',data=resolve(process.argv[3]??'.data/continuity-development');
await continuityE2E(base,undefined,async(rooms,needles)=>{
  let journalRows=0,slotRows=0,blobs=0;
  const inspect=(bytes:Uint8Array)=>{for(const needle of needles)assert.equal(Buffer.from(bytes).includes(Buffer.from(needle)),false);};
  for(const room of rooms.keys()) {
    const raw=await readFile(resolve(data,'do/groups',Buffer.from(room).toString('hex')+'.json'));
    inspect(raw);const state=JSON.parse(raw.toString()).continuity;
    for(const row of state?.journal??[]){inspect(Buffer.from(row.env.ct,'base64url'));journalRows++;}
    for(const row of Object.values(state?.slots??{}) as any[]){inspect(Buffer.from(row.env.ct,'base64url'));slotRows++;}
    const dir=resolve(data,'r2/g',room,'b');
    let entries:string[]=[];
    try{entries=await readdir(dir);}catch(e){if((e as any).code!=='ENOENT')throw e;}
    for(const id of entries.filter(id=>!id.endsWith('.meta'))){inspect(await readFile(resolve(dir,id)));blobs++;}
  }
  assert.ok(journalRows>0&&slotRows>0&&blobs>0);
  return {journalRows,slotRows,blobs,containsPlaintext:false,source:'actual local DO files and R2 adapter files'};
},'local-storage');
