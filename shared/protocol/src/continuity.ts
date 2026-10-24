import { ProtocolError, type Envelope, type JournalRecord, type QueueStore, type Slot, type Incoming } from "./types.ts";
import { b64url, random, unb64, deriveGroup, utf8, sha256 } from "./crypto.ts";
import { deriveSlotId, sealJournal, openJournal, sealSlot, openSlot, sealBlob, openBlob, bytesEnvelope, envelopeBytes } from "./continuity-crypto.ts";
import { IndexedDBQueueStore, MemoryQueueStore } from "./queue-store.ts";
import { materializeJournal } from "./migration.ts";

export type ChannelContext = Awaited<ReturnType<typeof deriveGroup>> & { gk: string; epoch: number; deviceId: string };
type Entry = { id: string; env: Envelope; seq: number };
type State = { room: string; cursor: number; pending: Entry[]; archive: Entry[]; slot?: Envelope; slotDirty?: boolean; slotDigest?: string; blobs: string[]; gap: boolean; notified: string[] };
type Host = {
  context(): ChannelContext | undefined;
  request(path: string, init?: RequestInit, token?: string): Promise<Response>;
  local(): Promise<unknown>;
  fail(e: unknown): void;
  gap(value: boolean): void;
};
const DAY = 86400000;
const fresh = (room: string): State => ({ room, cursor: 0, pending: [], archive: [], blobs: [], gap: false, notified: [] });
const allowedTypes = new Set(["hv", "hd", "sh", "sd", "snd", "ack", "cfg"]);

export class ContinuityClient {
  private store: QueueStore;
  private state?: State;
  private owner?: string;
  private ready: Promise<void> = Promise.resolve();
  private saves = Promise.resolve();
  private enqueues = Promise.resolve();
  private flushTask?: Promise<void>;
  private pullTask?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private noticeTask = Promise.resolve();
  private slotTimer?: ReturnType<typeof setTimeout>;
  private slotAttemptAt = -Infinity;
  private noticeHead = 0;
  private slotNotices = new Map<string, any>();
  private slotCache = new Map<string, { updatedAt:number; slot:Slot }>();
  private slotTimes = new Map<string,number>();
  private slotVersion = 0;
  private slotCacheReady = false;
  private commits = Promise.resolve();
  private stopped = false;
  private active: boolean;
  private journalListeners = new Set<(records: JournalRecord[], info: { replay: boolean }) => void>();
  private slotListeners = new Set<(slots: Slot[]) => void>();
  private incomingListeners = new Set<(item: Incoming) => void>();
  constructor(private host: Host, store?: QueueStore) {
    this.store = store ?? (typeof indexedDB === "undefined" ? new MemoryQueueStore() : new IndexedDBQueueStore());
    this.active = !!store;
  }
  private enable() {
    this.active = true;
    if (this.host.context()) void this.catchUp().catch(e => this.host.fail(e));
  }
  private key(room: string) { return "continuity/" + this.owner + "/" + room; }
  private async ensure() {
    const ctx = this.host.context();
    if (!ctx) throw new ProtocolError("CONFLICT", "Device is not paired");
    if (this.state?.room === ctx.roomId) { await this.ready; return ctx; }
    this.owner = ctx.deviceId;
    this.slotCache.clear();this.slotTimes.clear();this.slotCacheReady=false;this.slotAttemptAt=-Infinity;
    this.ready = (async () => {
      await this.saves;
      const state = await this.store.get<State>(this.key(ctx.roomId));
      this.state = state ?? fresh(ctx.roomId);
      this.host.gap(this.state.gap);
    })();
    // Install a room marker before yielding so concurrent triggers share one load.
    this.state = fresh(ctx.roomId);
    await this.ready;
    return ctx;
  }
  private save() {
    const state = structuredClone(this.state!), key = this.key(state.room);
    const p = this.saves.then(() => this.store.set(key, state));
    this.saves = p.catch(e => this.host.fail(e));
    return p;
  }
  private schedule(ms = 10000) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(e => {
      this.host.fail(e);
      this.schedule(Math.max(10000, (e instanceof ProtocolError ? e.retryAfter ?? 0 : 0) * 1000));
    }); }, ms);
  }
  append(t: string, payload: object): string {
    if (!this.host.context()) throw new ProtocolError("CONFLICT");
    if (!allowedTypes.has(t) || !payload || Array.isArray(payload)) throw new ProtocolError("BAD_REQUEST");
    const p = payload as any;
    if ((t === "hv" && (!Array.isArray(p.v) || p.v.length > 200)) ||
        (t === "sh" && !Array.isArray(p.q)) ||
        (t === "cfg" && ![30, 90].includes(p.retentionDays)) ||
        (t === "snd" && (!["url", "text"].includes(p.k) || typeof p.to !== "string" || (p.tx != null && (typeof p.tx !== "string" || [...p.tx].length > 4000)))))
      throw new ProtocolError("BAD_REQUEST");
    this.active = true;
    const id = b64url(random(16)), at = Date.now(), captured = structuredClone(payload);
    const task = this.enqueues.then(async () => {
      const ctx = await this.ensure();
      const env = await sealJournal(ctx.encKey, ctx.roomId, id, { ...captured, t, dev: ctx.deviceId, at });
      if (utf8(JSON.stringify({ items: [{ id, env }] })).length > 262144) throw new ProtocolError("PAYLOAD_TOO_LARGE");
      this.state!.pending.push({ id, env, seq: 0 });
      await this.save();
      if (this.state!.pending.length >= 50) { clearTimeout(this.timer); this.timer = undefined; this.schedule(0); }
      else this.schedule();
    });
    this.enqueues = task.catch(e => this.host.fail(e));
    return id;
  }
  onJournal(cb: (records: JournalRecord[], info: { replay: boolean }) => void) {
    this.journalListeners.add(cb); this.enable(); return () => { this.journalListeners.delete(cb); };
  }
  onSlots(cb: (slots: Slot[]) => void) { this.slotListeners.add(cb); this.enable(); return () => { this.slotListeners.delete(cb); }; }
  onIncoming(cb: (item: Incoming) => void) { this.incomingListeners.add(cb); this.enable(); return () => { this.incomingListeners.delete(cb); }; }
  cursor() { return this.state?.cursor ?? 0; }
  notify(message: any) {
    if(message.type==='journal')this.noticeHead=Math.max(this.noticeHead,Number(message.head)||0);
    if(message.type==='slot')this.slotNotices.set(message.slotId,message);
    if(this.noticeTimer||this.stopped)return;
    this.noticeTimer=setTimeout(()=>{this.noticeTimer=undefined;this.noticeTask=this.noticeTask.then(()=>this.drainNotices()).catch(e=>this.host.fail(e));},1000);
  }
  private async drainNotices() {
    const head=this.noticeHead,notices=[...this.slotNotices.values()];this.noticeHead=0;this.slotNotices.clear();
    if(head>this.cursor())await this.pullJournal();
    if(!notices.length||!this.slotListeners.size)return;
    if(!this.slotCacheReady||notices.some(n=>n.env===undefined)){await this.refreshSlots();return;}
    const ctx=await this.ensure();
    for(const row of notices){
      if(row.updatedAt<(this.slotTimes.get(row.slotId)??0))continue;
      this.slotVersion++;
      this.slotTimes.set(row.slotId,row.updatedAt);
      if(row.env===null)this.slotCache.delete(row.slotId);
      else this.slotCache.set(row.slotId,{updatedAt:row.updatedAt,slot:await this.decodeSlot(ctx,row)});
    }
    for(const cb of this.slotListeners)await cb(this.cachedSlots());
  }
  private cachedSlots(){return [...this.slotCache.values()].filter(r=>r.updatedAt>Date.now()-30*DAY).map(r=>r.slot);}
  private async commit(ctx:ChannelContext,items:Entry[],head:number,replay:boolean,contiguous=false) {
    let accepted=false;
    const task=this.commits.then(async()=>{
      if(this.state?.room!==ctx.roomId||this.stopped)return;
      const fresh=items.filter(r=>r.seq>this.state!.cursor);
      if(contiguous&&fresh.some((r,i)=>r.seq!==this.state!.cursor+i+1))return;
      const records:JournalRecord[]=[];
      let cursor=this.state!.cursor;
      for(const row of fresh){
        if(!Number.isSafeInteger(row.seq)||row.seq<=cursor||row.seq>head)throw new ProtocolError('BAD_REQUEST','Unordered journal');
        const p=await openJournal(ctx.encKey,ctx.roomId,row.id,row.env);
        if(!allowedTypes.has(p.t)||typeof p.dev!=='string'||!Number.isFinite(p.at))throw new ProtocolError('BAD_REQUEST','Invalid journal record');
        records.push({...p,id:row.id,seq:row.seq});cursor=row.seq;
      }
      if(records.length)for(const cb of this.journalListeners)await cb(records,{replay});
      const oldCursor=this.state!.cursor,oldArchive=this.state!.archive;
      this.state!.archive=[...oldArchive,...fresh];this.state!.cursor=Math.max(cursor,items.length?cursor:head);
      try{await this.save();}catch(e){this.state!.archive=oldArchive;this.state!.cursor=oldCursor;throw e;}
      accepted=true;
    });
    this.commits=task.catch(()=>{});await task;return accepted;
  }
  async flush() {
    if (!this.active || this.stopped || !this.host.context()) return;
    if (this.flushTask) return this.flushTask;
    this.flushTask = this.flushLoop();
    try { await this.flushTask; } finally { this.flushTask = undefined; }
  }
  private async flushLoop() {
    await this.enqueues;
    const ctx = await this.ensure();
    let lastHead:number|undefined;
    while (!this.stopped && this.state!.pending.length && this.host.context()?.roomId === ctx.roomId) {
      const batch: Entry[] = [];
      for (const item of this.state!.pending.slice(0, 50)) {
        if (batch.length && utf8(JSON.stringify({ items: [...batch, item].map(({ id, env }) => ({ id, env })) })).length > 262144) break;
        batch.push(item);
      }
      const response=await this.host.request("/v1/groups/" + ctx.roomId + "/journal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: batch.map(({ id, env }) => ({ id, env })) }),
      }, ctx.roomToken);
      if (this.state!.room !== ctx.roomId) return;
      const ack=await response.json();
      if(Array.isArray(ack.seqs)&&ack.seqs.length===batch.length&&Number.isSafeInteger(ack.head)){
        lastHead=ack.head;
        const accepted=await this.commit(ctx,batch.map((r,i)=>({...r,seq:ack.seqs[i]})),ack.head,false,true);
        if(!accepted||this.state!.cursor<ack.head)await this.pullJournal();
      }else await this.pullJournal();
      const ids = new Set(batch.map(r => r.id));
      this.state!.pending = this.state!.pending.filter(r => !ids.has(r.id));
      await this.save();
    }
    if (this.state!.room !== ctx.roomId || this.host.context()?.roomId !== ctx.roomId) return;
    if (this.state!.slotDirty) await this.uploadSlot(ctx);
    if(lastHead===undefined&&this.state!.pending.length)await this.pullJournal();
    await this.deliverIncoming(ctx);
  }
  async catchUp() {
    if (!this.active || this.stopped || !this.host.context()) return;
    await this.pullJournal();
    await this.refreshSlots();
    await this.flush();
  }
  async refreshSlots() {
    if (!this.active || this.stopped || !this.host.context() || !this.slotListeners.size) return;
    const slots = await this.getSlots();
    for (const cb of this.slotListeners) await cb(slots);
  }
  async pullJournal() {
    if (!this.active || this.stopped || !this.host.context()) return;
    if (this.pullTask) return this.pullTask;
    this.pullTask = this.pullLoop();
    try { await this.pullTask; } finally { this.pullTask = undefined; }
  }
  private async pullLoop() {
    const ctx = await this.ensure();
    let replay = this.state!.cursor === 0;
    for (;;) {
      const r = await this.host.request("/v1/groups/" + ctx.roomId + "/journal?after=" + this.state!.cursor + "&limit=500", {}, ctx.roomToken);
      const page = await r.json();
      if (this.host.context()?.roomId !== ctx.roomId || this.stopped) return;
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.head) || !Number.isSafeInteger(page.floor)) throw new ProtocolError("BAD_REQUEST", "Invalid journal page");
      if (page.gap && !this.state!.gap) {
        this.state!.gap = true; this.host.gap(true);
        for (const cb of this.journalListeners) await cb([], { replay: true });
        await this.save();
      }
      await this.commit(ctx,page.items.map(({id,seq,env}:Entry)=>({id,seq,env})),page.head,replay);
      if (this.state!.cursor >= page.head) break;
      if (!page.items.length) throw new ProtocolError("BAD_REQUEST", "Journal pagination stalled");
      replay = true;
    }
    await this.deliverIncoming(ctx);
  }
  private async deliverIncoming(ctx:ChannelContext) {
    const incoming:JournalRecord[]=[],acks=new Set<string>();
    if (this.incomingListeners.size) {
      // Include durable acknowledgements from earlier pages/sessions before notifying.
      for (const row of this.state!.archive) {
        const p = await openJournal(ctx.encKey, ctx.roomId, row.id, row.env);
        if (p.t === "ack") acks.add(p.ref);
        if (p.t === "snd" && p.at > Date.now() - 7 * DAY) incoming.push({ ...p, id: row.id, seq: row.seq });
      }
      for (const record of incoming) if (record.to === ctx.deviceId && !acks.has(record.id) && !this.state!.notified.includes(record.id)) {
        const item: Incoming = { id: record.id, from: record.dev, at: record.at, k: String(record.k),
          ...(typeof record.u === "string" ? { u: record.u } : {}), ...(typeof record.ti === "string" ? { ti: record.ti } : {}), ...(typeof record.tx === "string" ? { tx: record.tx } : {}) };
        for (const cb of this.incomingListeners) await cb(item);
        this.state!.notified.push(record.id);
        await this.save();
      }
    }
  }
  async putSlot(payload: object) {
    this.active = true;
    const ctx = await this.ensure(), p = payload as any;
    if ((p.windows ?? []).reduce((n: number, w: any) => n + (w.tabs?.length ?? 0), 0) > 200) throw new ProtocolError("BAD_REQUEST");
    const {dev:ignoredDev,at:ignoredAt,...content}=p;
    const digest=b64url(await sha256(utf8(JSON.stringify(content))));
    if(this.state!.slot&&this.state!.slotDigest===digest)return;
    const plain = { ...payload, dev: ctx.deviceId, at: Date.now() }, id = await deriveSlotId(unb64(ctx.gk), ctx.epoch, ctx.deviceId);
    const bytes = await sealSlot(ctx.encKey, ctx.roomId, id, plain);
    if (bytes.length > 65536) throw new ProtocolError("PAYLOAD_TOO_LARGE");
    this.state!.slot = bytesEnvelope(bytes); this.state!.slotDirty = true;this.state!.slotDigest=digest; await this.save();
    try { await this.uploadSlot(ctx); } catch(e) { this.schedule(); throw e; }
  }
  private async uploadSlot(ctx: ChannelContext) {
    const wait=this.slotAttemptAt+10000-Date.now();
    if(wait>0){
      if(!this.slotTimer)this.slotTimer=setTimeout(()=>{this.slotTimer=undefined;void this.flush().catch(e=>{this.host.fail(e);this.schedule(Math.max(10000,(e instanceof ProtocolError?e.retryAfter??0:0)*1000));});},wait);
      return;
    }
    this.slotAttemptAt=Date.now();
    const slot = this.state!.slot;
    const id = await deriveSlotId(unb64(ctx.gk), ctx.epoch, ctx.deviceId);
    await this.host.request("/v1/groups/" + ctx.roomId + "/slots/" + id, slot
      ? { method: "PUT", body: envelopeBytes(slot).slice().buffer as ArrayBuffer }
      : { method: "DELETE" }, ctx.roomToken);
    // Preserve a newer overwrite while this request was in flight.
    if (this.state!.room === ctx.roomId && this.state!.slot === slot) {
      this.state!.slotDirty = false; await this.save();
    }
  }
  async getSlots(): Promise<Slot[]> {
    this.active = true;
    const ctx = await this.ensure();
    const version=this.slotVersion;
    const body = await (await this.host.request("/v1/groups/" + ctx.roomId + "/slots", {}, ctx.roomToken)).json();
    if(!this.slotCacheReady){this.slotCache.clear();}
    const seen=new Set<string>();
    for (const row of body.slots ?? []) {
      seen.add(row.slotId);
      if(row.updatedAt<(this.slotTimes.get(row.slotId)??0))continue;
      const slot=await this.decodeSlot(ctx,row);
      if(row.updatedAt<(this.slotTimes.get(row.slotId)??0))continue;
      this.slotCache.set(row.slotId,{updatedAt:row.updatedAt,slot});
      this.slotTimes.set(row.slotId,row.updatedAt);
    }
    // An in-flight GET may predate a pushed update/deletion. Never erase newer cache entries.
    if(version===this.slotVersion)for(const id of this.slotCache.keys())if(!seen.has(id))this.slotCache.delete(id);
    this.slotCacheReady=true;return this.cachedSlots();
  }
  private async decodeSlot(ctx:ChannelContext,row:any):Promise<Slot>{
    const p=await openSlot(ctx.encKey,ctx.roomId,row.slotId,row.env);
    if(await deriveSlotId(unb64(ctx.gk),ctx.epoch,p.dev)!==row.slotId)throw new ProtocolError('BAD_REQUEST','Slot identity mismatch');
    return {dev:p.dev,at:p.at,payload:p};
  }
  async deleteSlot() {
    this.active = true;
    const ctx = await this.ensure(), id = await deriveSlotId(unb64(ctx.gk), ctx.epoch, ctx.deviceId);
    delete this.state!.slot;delete this.state!.slotDigest; this.state!.slotDirty = true; await this.save();
    try { await this.uploadSlot(ctx); } catch(e) { this.schedule(); throw e; }
  }
  async putBlob(bytes: Uint8Array, _mime: string) {
    this.active = true;
    const ctx = await this.ensure(), id = b64url(random(16));
    const raw = await sealBlob(ctx.encKey, ctx.roomId, id, bytes);
    if (raw.length > 3 * 1024 * 1024) throw new ProtocolError("PAYLOAD_TOO_LARGE");
    await this.host.request("/v1/groups/" + ctx.roomId + "/blobs/" + id, { method: "PUT", body: raw.slice().buffer as ArrayBuffer }, ctx.roomToken);
    this.state!.blobs.push(id); await this.save();
    return { blobId: id, size: bytes.length };
  }
  async getBlob(id: string) {
    const ctx = await this.ensure();
    const raw = new Uint8Array(await (await this.host.request("/v1/groups/" + ctx.roomId + "/blobs/" + id, {}, ctx.roomToken)).arrayBuffer());
    return openBlob(ctx.encKey, ctx.roomId, id, raw);
  }
  async deleteBlob(id: string) {
    const ctx = await this.ensure();
    await this.host.request("/v1/groups/" + ctx.roomId + "/blobs/" + id, { method: "DELETE" }, ctx.roomToken);
    this.state!.blobs = this.state!.blobs.filter(b => b !== id); await this.save();
  }
  async switchRoom(old: ChannelContext) {
    if (!this.active) return;
    await this.enqueues; await this.saves;
    const previous = this.state;
    this.state = undefined;
    const next = await this.ensure();
    if (previous?.room === old.roomId) {
      for (const row of previous.pending) {
        const plain = await openJournal(old.encKey, old.roomId, row.id, row.env);
        this.state!.pending.push({ id: row.id, seq: 0, env: await sealJournal(next.encKey, next.roomId, row.id, plain) });
      }
      if (previous.slot) {
        const oldId = await deriveSlotId(unb64(old.gk), old.epoch, old.deviceId);
        const plain = await openSlot(old.encKey, old.roomId, oldId, previous.slot);
        const id = await deriveSlotId(unb64(next.gk), next.epoch, next.deviceId);
        this.state!.slot = bytesEnvelope(await sealSlot(next.encKey, next.roomId, id, plain));
        this.state!.slotDirty = true;
      }
      await this.save();
      if (this.state!.slotDirty) {
        try { await this.uploadSlot(next); } catch(e) { this.host.fail(e); this.schedule(); }
      }
    }
  }
  async migrate(next: ChannelContext) {
    if (!this.active) return;
    await this.flush(); await this.pullJournal();
    const old = await this.ensure(), source = this.state!;
    const plains: JournalRecord[] = [];
    for (const r of source.archive) plains.push({ ...await openJournal(old.encKey, old.roomId, r.id, r.env), id: r.id, seq: r.seq });
    const records = await materializeJournal(plains);
    const nextState = fresh(next.roomId);
    let items: Array<{ id: string; env: Envelope }> = [];
    const upload = async () => {
      if (!items.length) return;
      await this.host.request("/v1/groups/" + next.roomId + "/journal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) }, next.roomToken);
      items = [];
    };
    for (const value of records) {
        const { id: previousId, ...plain } = value;
        const id = previousId ?? b64url(random(16));
        if (!plain.dev) plain.dev = old.deviceId;
        const item = { id, env: await sealJournal(next.encKey, next.roomId, id, plain) };
        if (utf8(JSON.stringify({items: [item]})).length > 262144) throw new ProtocolError("PAYLOAD_TOO_LARGE");
        if (items.length === 50 || utf8(JSON.stringify({ items: [...items, item] })).length > 262144) await upload();
        items.push(item);
    }
    await upload();
    if (source.slot) {
      const oldId = await deriveSlotId(unb64(old.gk), old.epoch, old.deviceId);
      const plain = await openSlot(old.encKey, old.roomId, oldId, source.slot);
      const newId = await deriveSlotId(unb64(next.gk), next.epoch, next.deviceId);
      const raw = await sealSlot(next.encKey, next.roomId, newId, plain);
      await this.host.request("/v1/groups/" + next.roomId + "/slots/" + newId, { method: "PUT", body: raw.slice().buffer as ArrayBuffer }, next.roomToken);
      nextState.slot = bytesEnvelope(raw);
    }
    const data = await this.host.local() as any;
    const backgroundId = data?.settings?.background?.image?.blobId;
    for (const id of new Set([...source.blobs, ...(backgroundId ? [backgroundId] : [])])) {
      const plain = await this.getBlob(id);
      const raw = await sealBlob(next.encKey, next.roomId, id, plain);
      await this.host.request("/v1/groups/" + next.roomId + "/blobs/" + id, { method: "PUT", body: raw.slice().buffer as ArrayBuffer }, next.roomToken);
      nextState.blobs.push(id);
    }
    await this.store.set(this.key(next.roomId), nextState);
  }
  dispose() { this.stopped = true; clearTimeout(this.timer);clearTimeout(this.slotTimer);clearTimeout(this.noticeTimer); }
}
