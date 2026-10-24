import { bodyBytes, bodyJson, broadcast, config, error, hit, json, validEnv, b64 } from "./common.mjs";
import { guard } from "./guard.mjs";

const DAY = 86400000;
const idOK = (s) => typeof s === "string" && /^[\w-]{22}$/.test(s);
const encode = (v) => new TextEncoder().encode(JSON.stringify(v));
const decode = (v) => JSON.parse(new TextDecoder().decode(v));

// SQLite in Workers; the local adapter persists the same opaque rows in its file store.
export class ContinuityStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    if (this.sql) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kj_journal (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, at INTEGER NOT NULL, size INTEGER NOT NULL, env BLOB NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS kj_journal_expiry ON kj_journal(expires_at);
        CREATE TABLE IF NOT EXISTS kj_slots (slot_id TEXT PRIMARY KEY, env BLOB NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS kj_blobs (blob_id TEXT PRIMARY KEY, size INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS kj_channel_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO kj_channel_state VALUES ('head', 0);
        CREATE TABLE IF NOT EXISTS kj_channel_stats (id INTEGER PRIMARY KEY, head INTEGER NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL);`);
      if (!this.rows("SELECT head FROM kj_channel_stats WHERE id=1").length) {
        const r = this.rows("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS size FROM kj_journal")[0];
        const head=this.rows("SELECT value FROM kj_channel_state WHERE key='head'")[0].value;
        this.sql.exec("INSERT INTO kj_channel_stats VALUES (1,?,?,?)", head,r.count,r.size);
      }
    }
  }
  async load() {
    if (!this.sql) this.data = (await this.storage.get("continuity")) ?? { head: 0, journal: [], slots: {}, blobs: {} };
  }
  async save() { if (!this.sql) await this.storage.put("continuity", this.data); }
  rows(q, ...args) { return this.sql.exec(q, ...args).toArray(); }
  head() { return this.sql ? this.rows("SELECT head FROM kj_channel_stats WHERE id=1")[0].head : this.data.head; }
  totals() {
    return this.rows("SELECT count,bytes FROM kj_channel_stats WHERE id=1")[0];
  }
  setTotals(count, bytes, head=this.head()) {
    this.sql.exec("UPDATE kj_channel_stats SET head=?,count=?,bytes=? WHERE id=1", head,count,bytes);
  }
  journal(after = 0, limit = 500) {
    const rows = this.sql
      ? this.rows("SELECT seq,id,at,env FROM kj_journal WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).map(r => ({ ...r, env: decode(r.env) }))
      : this.data.journal.filter(r => r.seq > after).slice(0, limit).map(({ size, expires_at, ...r }) => r);
    const head = this.head();
    const floor = this.sql ? this.rows("SELECT MIN(seq) AS floor FROM kj_journal")[0].floor ?? head + 1 : this.data.journal[0]?.seq ?? head + 1;
    return { items: rows, head, floor, ...(after < floor - 1 ? { gap: true } : {}) };
  }
  append(items, time, maxBytes, maxCount) {
    const seqs = [];
    let head = this.head(), added = false, addedBytes = 0, addedCount = 0;
    for (const item of items) {
      const existing = this.sql ? this.rows("SELECT seq FROM kj_journal WHERE id=?", item.id)[0] : this.data.journal.find(r => r.id === item.id);
      if (existing) { seqs.push(existing.seq); continue; }
      const env = encode(item.env), size = env.byteLength;
      const row = { seq: ++head, id: item.id, at: time, size, env: item.env, expires_at: time + 90 * DAY };
      if (this.sql) this.sql.exec("INSERT INTO kj_journal VALUES (?,?,?,?,?,?)", row.seq, row.id, row.at, size, env, row.expires_at);
      else this.data.journal.push(row);
      added = true;
      addedBytes += size; addedCount++;
      seqs.push(head);
    }
    if (this.sql) {
      const totals = this.totals();
      let count = totals.count + addedCount, size = totals.bytes + addedBytes;
      if (count > maxCount || size > maxBytes) {
        let cutoff = 0;
        while (count > maxCount || size > maxBytes) {
          const rows = this.rows("SELECT seq,size FROM kj_journal WHERE seq>? ORDER BY seq LIMIT 500", cutoff);
          if (!rows.length) break;
          for (const r of rows) {
            if (count <= maxCount && size <= maxBytes) break;
            count--; size -= r.size; cutoff = r.seq;
          }
        }
        this.sql.exec("DELETE FROM kj_journal WHERE seq<=?", cutoff);
      }
      if(added) this.setTotals(count, size, head);
    } else {
      this.data.head = head;
      let size = this.data.journal.reduce((n, r) => n + r.size, 0);
      while (this.data.journal.length > maxCount || size > maxBytes) size -= this.data.journal.shift().size;
    }
    return { seqs, head, added };
  }
  slots() {
    return this.sql ? this.rows("SELECT slot_id,env,updated_at FROM kj_slots ORDER BY slot_id").map(r => ({ slotId: r.slot_id, env: decode(r.env), updatedAt: r.updated_at }))
      : Object.entries(this.data.slots).sort(([a], [b]) => a.localeCompare(b)).map(([slotId, r]) => ({ slotId, ...r }));
  }
  putSlot(id, env, time) {
    if (this.sql) this.sql.exec("INSERT INTO kj_slots VALUES (?,?,?) ON CONFLICT(slot_id) DO UPDATE SET env=excluded.env,updated_at=excluded.updated_at", id, encode(env), time);
    else this.data.slots[id] = { env, updatedAt: time };
  }
  deleteSlot(id) {
    if (this.sql) this.sql.exec("DELETE FROM kj_slots WHERE slot_id=?", id);
    else delete this.data.slots[id];
  }
  blobs() { return this.sql ? this.rows("SELECT blob_id AS id,size FROM kj_blobs") : Object.entries(this.data.blobs).map(([id, size]) => ({ id, size })); }
  putBlob(id, size) {
    if (this.sql) this.sql.exec("INSERT INTO kj_blobs VALUES (?,?) ON CONFLICT(blob_id) DO UPDATE SET size=excluded.size", id, size);
    else this.data.blobs[id] = size;
  }
  deleteBlob(id) {
    if (this.sql) this.sql.exec("DELETE FROM kj_blobs WHERE blob_id=?", id);
    else delete this.data.blobs[id];
  }
  prune(time) {
    if (this.sql) {
      const removed = this.rows("DELETE FROM kj_journal WHERE expires_at<=? RETURNING size", time);
      if (removed.length) {
        const totals = this.totals();
        this.setTotals(totals.count-removed.length, totals.bytes-removed.reduce((n,r)=>n+r.size,0));
      }
      this.sql.exec("DELETE FROM kj_slots WHERE updated_at<=?", time - 30 * DAY);
    } else {
      this.data.journal = this.data.journal.filter(r => r.expires_at > time);
      for (const [id, r] of Object.entries(this.data.slots)) if (r.updatedAt + 30 * DAY <= time) delete this.data.slots[id];
    }
  }
  nextExpiry() {
    if (this.sql) {
      const j = this.rows("SELECT MIN(expires_at) AS t FROM kj_journal")[0].t;
      const s = this.rows("SELECT MIN(updated_at) AS t FROM kj_slots")[0].t;
      return Math.min(j ?? Infinity, s == null ? Infinity : s + 30 * DAY);
    }
    return Object.values(this.data.slots).reduce((t, r) => Math.min(t, r.updatedAt + 30 * DAY), this.data.journal.reduce((t, r) => Math.min(t, r.expires_at), Infinity));
  }
  clear() {
    if (this.sql) { this.sql.exec("DELETE FROM kj_journal; DELETE FROM kj_slots; DELETE FROM kj_blobs;"); this.setTotals(0,0); }
    else this.data = { head: this.data.head, journal: [], slots: {}, blobs: {} };
  }
}

export class ContinuityRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.store = new ContinuityStore(ctx.storage); this.limits={}; }
  async prepare(time) { await this.store.load(); this.store.prune(time); }
  async schedule(meta, time) {
    const next=Math.max(time + 1, Math.min(meta.last + 180 * DAY, meta.forwardExpires ?? Infinity, this.store.nextExpiry()));
    if(this.alarmAt===undefined)this.alarmAt=(await this.ctx.storage.getAlarm?.())??Infinity;
    if(next<this.alarmAt){await this.ctx.storage.setAlarm(next);this.alarmAt=next;}
  }
  async clear(meta) {
    const keys = this.store.blobs().map(b => "g/" + meta.room + "/b/" + b.id);
    for (let i = 0; i < keys.length; i += 1000) await this.env.BUCKET.delete(keys.slice(i, i + 1000));
    this.store.clear(); await this.store.save();
  }
  async handle(request, meta, time, op, id) {
    if (meta.retired) error(410, "GONE");
    await this.prepare(time);
    const method = request.method, s = this.store, env = this.env;
    const limit = async (key, fallback) => hit(this.limits, key, config(env, key, fallback), 60000, time);
    try {
      if (op === "journal") {
        if (method === "GET") {
          await limit("journalGet", 120);
          const params = new URL(request.url).searchParams;
          const a = params.get("after") ?? "0", l = params.get("limit") ?? "500";
          if (!/^\d+$/.test(a) || !/^\d+$/.test(l)) error(400, "BAD_REQUEST");
          const after = Number(a), count = Number(l);
          if (!Number.isSafeInteger(after) || !Number.isSafeInteger(count) || count < 1 || count > 500) error(400, "BAD_REQUEST");
          return json(s.journal(after, count));
        }
        if (method !== "POST") error(400, "BAD_REQUEST");
        await limit("journalPut", 60);
        await guard(env, request.headers.get("X-KJ-IP-Hash") ?? "local", "rate", { op: "journal" });
        const body = await bodyJson(request, 256 * 1024);
        if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100 || body.items.some(r => !r || !idOK(r.id) || !validEnv(r.env))) error(400, "BAD_REQUEST");
        const commit = () => s.append(body.items, time, config(env, "journalBytes", 20 * 1024 * 1024), config(env, "journalCount", 60000));
        const result = this.ctx.storage.transactionSync ? this.ctx.storage.transactionSync(commit) : commit();
        if (result.added) broadcast(this.ctx, { type: "journal", head: result.head });
        return json({ seqs: result.seqs, head: result.head });
      }
      if (op === "slots") {
        await limit("slots", 30);
        if (!id && method === "GET") return json({ slots: s.slots() });
        if (!idOK(id)) error(400, "BAD_REQUEST");
        if (method === "DELETE") { s.deleteSlot(id); broadcast(this.ctx, { type: "slot", slotId: id, updatedAt: time, env:null }); return json(null, 204); }
        if (method !== "PUT") error(400, "BAD_REQUEST");
        const raw = await bodyBytes(request, 65536);
        if (raw.length < 29 || raw[0] !== 1) error(400, "BAD_REQUEST");
        if (!s.slots().some(r => r.slotId === id) && s.slots().length >= 12) error(429, "ROOM_FULL");
        const slotEnv={ v: 1, iv: b64(raw.slice(1, 13)), ct: b64(raw.slice(13)) };
        s.putSlot(id, slotEnv, time);
        const notice={ type: "slot", slotId: id, updatedAt: time };
        // Additive encrypted cache hint; old clients still fetch, large slots use the original path.
        if(encode({...notice,env:slotEnv}).length<=65536)notice.env=slotEnv;
        broadcast(this.ctx, notice);
        return json({ updatedAt: time });
      }
      if (op === "blobs") {
        if (!idOK(id)) error(400, "BAD_REQUEST");
        const key = "g/" + meta.room + "/b/" + id;
        if (method === "GET") {
          const object = await env.BUCKET.get(key);
          if (!object) error(404, "NOT_FOUND");
          return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
        }
        if (!["PUT", "DELETE"].includes(method)) error(400, "BAD_REQUEST");
        await limit("blobPut", 10);
        if (method === "DELETE") { await env.BUCKET.delete(key); s.deleteBlob(id); return json(null, 204); }
        const raw = await bodyBytes(request, 3 * 1024 * 1024);
        if (raw.length < 29 || raw[0] !== 1) error(400, "BAD_REQUEST");
        const used = s.blobs().filter(b => b.id !== id).reduce((n, b) => n + b.size, 0);
        if (used + raw.length > config(env, "blobQuota", 10 * 1024 * 1024)) error(413, "PAYLOAD_TOO_LARGE");
        // Persist the manifest first, so an interrupted R2 write remains discoverable by cleanup.
        const reserved = Math.max(raw.length, s.blobs().find(b => b.id === id)?.size ?? 0);
        s.putBlob(id, reserved); await s.save();
        await env.BUCKET.put(key, raw);
        s.putBlob(id, raw.length);
        return json({ size: raw.length });
      }
      error(404, "NOT_FOUND");
    } finally {
      await s.save();
      await this.schedule(meta, time);
    }
  }
}
