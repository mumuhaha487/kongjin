import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, readdir, rm, stat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
const digest = b => createHash('sha256').update(b).digest('hex');
export class MemoryStorage {
  objects = new Map(); counts = { get: 0, set: 0, list: 0, head: 0, delete: 0 };
  constructor(now = Date.now) { this.now = now; }
  async get(key) { this.counts.get++; return this.objects.get(key)?.bytes.slice() ?? null; }
  async set(key, data) { this.counts.set++; const bytes = Buffer.from(data); this.objects.set(key, { bytes, key, size: bytes.length, etag: digest(bytes), modified: this.now() }); }
  async head(key) { this.counts.head++; const o = this.objects.get(key); return o ? { key, size: o.size, etag: o.etag, modified: o.modified } : null; }
  async list(prefix = '', limit = Infinity) { this.counts.list++; return [...this.objects.values()].filter(o => o.key.startsWith(prefix)).sort((a,b) => a.key.localeCompare(b.key)).slice(0,limit).map(({key,size,etag,modified}) => ({key,size,etag,modified})); }
  async delete(key) { this.counts.delete++; this.objects.delete(key); }
}
export class FileStorage {
  constructor(root, { renameFile = rename, writeTemp = writeFile, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.root = resolve(root); this.renameFile = renameFile; this.writeTemp = writeTemp; this.sleep = sleep;
  }
  async retryBusy(task) {
    for (let attempt = 0;; attempt++) {
      try { return await task(); }
      catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
        await this.sleep(25 * 2 ** attempt);
      }
    }
  }
  path(key) { const p = resolve(this.root, key); if (!p.startsWith(this.root + sep) || key.includes('\\')) throw new Error('Invalid storage key'); return p; }
  async get(key) { try { return new Uint8Array(await readFile(this.path(key))); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
  async set(key, bytes) {
    const p = this.path(key); await mkdir(dirname(p), {recursive:true});
    const temp = p + '.' + randomUUID() + '.tmp';
    try {
      await this.writeTemp(temp, bytes, {mode:0o600});
      // Never unlink the destination: readers must see either the old or new file.
      await this.retryBusy(() => this.renameFile(temp, p));
    } finally {
      await this.retryBusy(() => rm(temp, {force:true}));
    }
  }
  async head(key) { try { const bytes = await this.get(key); if (!bytes) return null; return {key,etag:digest(bytes),size:bytes.length,modified:(await stat(this.path(key))).mtimeMs}; } catch(e) { if(e.code==='ENOENT')return null;throw e; } }
  async list(prefix='',limit=Infinity) {
    const out=[]; const walk=async(dir,parent='')=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
      for(const entry of entries){if(out.length>=limit)return;const key=parent+entry.name;if(entry.isDirectory())await walk(resolve(dir,entry.name),key+'/');else if(!key.endsWith('.tmp')&&key.startsWith(prefix)){const info=await this.head(key);if(info)out.push(info);}}};
    await walk(this.root);return out.sort((a,b)=>a.key.localeCompare(b.key));
  }
  async delete(key) { await rm(this.path(key),{force:true}); }
}
export class BlobStorage {
  constructor(store) { this.store = store; }
  async get(key) { const b=await this.store.get(key,{type:'arrayBuffer',consistency:'strong'});return b===null?null:new Uint8Array(b); }
  async set(key, bytes) { await this.store.set(key, Uint8Array.from(bytes).buffer, {cacheControl:'no-store'}); }
  async head(key) {
    const m=await this.store.getMetadata(key,{consistency:'strong'});if(!m)return null;
    const h=new Headers(m.headers);return {key,etag:m.etag??h.get('etag')??'',size:Number(h.get('content-length')??0),modified:Date.parse(h.get('last-modified')??'')||0};
  }
  async list(prefix='',limit=Infinity) {const {blobs}=await this.store.list({prefix,limit,consistency:'strong'});return blobs.map(b=>({key:b.key,etag:b.etag}));}
  async delete(key) { await this.store.delete(key); }
}
