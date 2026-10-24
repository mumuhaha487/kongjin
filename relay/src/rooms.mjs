import {
  Serialized,
  now,
  config,
  hit,
  error,
  json,
  failure,
  bodyBytes,
  bodyJson,
  hash,
  validEnv,
  upgrade,
  protocols,
  broadcast,
  closeAll,
  b64,
  random,
} from "./common.mjs";
import { guard } from "./guard.mjs";
import { ContinuityRoom } from "./continuity.mjs";
const DAY = 86400000;
export class GroupRoom extends Serialized {
  constructor(ctx, env) {
    super();
    this.ctx = ctx;
    this.env = env;
    this.channels = new ContinuityRoom(ctx, env);
    this.minuteLimits = {};
  }
  async meta() { if(this.cachedMeta===undefined)this.cachedMeta=(await this.ctx.storage.get('meta'))??null; return this.cachedMeta; }
  async saveMeta(meta) { this.cachedMeta=meta; await this.ctx.storage.put('meta',meta); }
  async touch(meta,time) {
    // Hourly activity lease prevents per-read/WS writes; rounds up, never expires active data early.
    if(time>meta.last){meta.last=Math.ceil(time/3600000)*3600000;await this.saveMeta(meta);}
  }
  fetch(request) {
    return this.serial(async () => {
      try {
        return await this.handle(request);
      } catch (e) {
        return failure(e);
      }
    });
  }
  async handle(request) {
    const url = new URL(request.url),
      [op, channelId] = url.pathname.slice(1).split("/"),
      time = now(this.env);
    let meta = await this.meta();
    if (request.method === "POST" && op === "create") {
      const b = await bodyJson(request);
      if (meta) error(409, "CONFLICT");
      meta = {
        room: b.room,
        tokenHash: b.tokenHash,
        createdAt: time,
        last: time,
        rev: 0,
        retired: false,
        limits: {},
      };
      await this.saveMeta(meta);
      await this.channels.prepare(time);
      await this.channels.schedule(meta,time);
      return json({ room: b.room, createdAt: time }, 201);
    }
    if (!meta) error(404, "NOT_FOUND");
    let token = request.headers.get("X-KJ-Token");
    if (op === "ws")
      token = protocols(request)
        .find((s) => s.startsWith("kjt."))
        ?.slice(4);
    if (!token || (await hash(token)) !== meta.tokenHash)
      error(401, "UNAUTHORIZED");
    await this.touch(meta,time);
    await this.channels.prepare(time);
    await this.channels.store.save();
    await this.channels.schedule(meta, time);
    const key = "g/" + meta.room + "/";
    if (op === "authorize") return json({ ok: true, retired: meta.retired });
    if (op === "forward") {
      if (request.method === "POST") {
        if (meta.retired) error(410, "GONE");
        const b = await bodyJson(request, 16384);
        if (!validEnv(b.env)) error(400, "BAD_REQUEST");
        meta.forwardExpires = time + 30 * DAY;
        await this.env.BUCKET.put(
          key + "forward",
          JSON.stringify({ env: b.env }),
        );
        await this.saveMeta(meta);
        await this.channels.schedule(meta, time);
        return json({ ok: true });
      }
      if (request.method === "GET") {
        if (!meta.forwardExpires || meta.forwardExpires <= time)
          error(404, "NOT_FOUND");
        const f = await this.env.BUCKET.get(key + "forward");
        if (!f) error(404, "NOT_FOUND");
        return json(await f.json());
      }
      error(400, "BAD_REQUEST");
    }
    if (["journal", "slots", "blobs"].includes(op))
      return this.channels.handle(request, meta, time, op, channelId);
    if (request.method === "DELETE") {
      await this.channels.prepare(time);
      await this.channels.clear(meta);
      await this.env.BUCKET.delete(key + "snapshot");
      meta.retired = true;
      await this.saveMeta(meta);
      broadcast(this.ctx, { type: "retired" });
      closeAll(this.ctx, 1000, "retired");
      await guard(this.env, "", "capacity", { room: meta.room, op: "release" });
      return json(null, 204);
    }
    if (meta.retired) error(410, "GONE");
    if (op === "snapshot") {
      const put = request.method === "PUT";
      if (!put && request.method !== "GET") error(400, "BAD_REQUEST");
        hit(
          this.minuteLimits,
          put ? "put" : "get",
          config(this.env, put ? "snapshotPut" : "snapshotGet", put ? 60 : 120),
          60000,
          time,
        );
      if (!put) {
        const r = await this.env.BUCKET.get(key + "snapshot");
        if (!r) return json(null, 204);
        return new Response(r.body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
            ETag: '"' + meta.rev + '"',
          },
        });
      }
      const raw = await bodyBytes(request, 1048576),
        match = request.headers.get("If-Match");
      if (!/^"\d+"$/.test(match ?? ""))
        error(400, "BAD_REQUEST", "If-Match required");
      if (match !== '"' + meta.rev + '"') return json({ rev: meta.rev }, 412);
      await this.env.BUCKET.put(key + "snapshot", raw);
      meta.rev++;
      await this.saveMeta(meta);
      broadcast(this.ctx, { type: "snapshot", rev: meta.rev });
      return json({ rev: meta.rev });
    }
    if (op === "ws") {
      if (
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
        !protocols(request).includes("kj.v1")
      )
        error(400, "BAD_REQUEST");
      if (this.ctx.getWebSockets().length >= config(this.env, "groupPeers", 12))
        error(429, "ROOM_FULL");
      return upgrade(
        this.ctx,
        this.env,
        request,
        { kind: "group", tokens: 10, at: time, frames: [] },
        (ws) => {
          ws.send(
            JSON.stringify({
              type: "hello",
              rev: meta.rev,
              peers: this.ctx.getWebSockets().length,
            }),
          );
          broadcast(
            this.ctx,
            { type: "peers", count: this.ctx.getWebSockets().length },
            ws,
          );
        },
      );
    }
    error(404, "NOT_FOUND");
  }
  async webSocketMessage(ws, message) {
    await this.serial(async () => {
      const time = now(this.env),
        a = ws.deserializeAttachment();
      const size =
        typeof message === "string"
          ? new TextEncoder().encode(message).length
          : message.byteLength;
      if (size > 65536) {
        ws.close(4429, "frame too large");
        return;
      }
      a.tokens = Math.min(10, a.tokens + (time - a.at) / 2000);
      a.at = time;
      a.frames = (a.frames ?? []).filter((t) => t > time - 60000);
      if (a.tokens < 1 || a.frames.length >= config(this.env, "wsFrames", 30)) {
        ws.close(4429, "rate limited");
        return;
      }
      a.tokens--;
      a.frames.push(time);
      ws.serializeAttachment(a);
      try {
        const m = JSON.parse(
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message),
        );
        if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        else if (m.type === "relay" && validEnv(m.env))
          broadcast(this.ctx, { type: "relay", env: m.env }, ws);
        else ws.close(4400, "bad message");
        const meta = await this.meta();
        if (meta) {
          await this.touch(meta,time);
          await this.channels.prepare(time);
          await this.channels.store.save();
          await this.channels.schedule(meta, time);
        }
      } catch {
        ws.close(4400, "bad message");
      }
    });
  }
  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
    broadcast(
      this.ctx,
      {
        type: "peers",
        count: this.ctx.getWebSockets().filter((x) => x !== ws).length,
      },
      ws,
    );
  }
  webSocketError(ws) {
    try {
      ws.close(1011);
    } catch {}
  }
  async alarm() {
    await this.serial(async () => {
      this.channels.alarmAt=Infinity;
      const m = await this.meta();
      if (!m) return;
      const time = now(this.env);
      await this.channels.prepare(time);
      if (m.forwardExpires && m.forwardExpires <= time) {
        await this.env.BUCKET.delete("g/" + m.room + "/forward");
        delete m.forwardExpires;
        await this.saveMeta(m);
      }
      if (m.last + 180 * DAY <= time) {
        await this.channels.clear(m);
        await this.env.BUCKET.delete([
          "g/" + m.room + "/snapshot",
          "g/" + m.room + "/forward",
        ]);
        await guard(this.env, "", "capacity", { room: m.room, op: "release" });
        closeAll(this.ctx);
        await this.ctx.storage.deleteAll();
        this.cachedMeta=null;
      } else {
        await this.channels.store.save();
        await this.channels.schedule(m, time);
      }
    });
  }
}
export class PairRoom extends Serialized {
  constructor(ctx, env) {
    super();
    this.ctx = ctx;
    this.env = env;
  }
  fetch(request) {
    return this.serial(async () => {
      try {
        const op = new URL(request.url).pathname.split("/").pop(),
          time = now(this.env);
        let meta = await this.ctx.storage.get("meta");
        if (op === "create") {
          if (meta && meta.expiresAt > time) error(409, "CONFLICT");
          const b = await bodyJson(request);
          const hostKey = b64(random(32));
          meta = {
            room: b.room,
            hostHash: await hash(hostKey),
            expiresAt: time + config(this.env, "pairTtl", 600000),
            guestUsed: false,
          };
          await this.ctx.storage.put("meta", meta);
          await this.ctx.storage.setAlarm(meta.expiresAt);
          return json({ hostKey, expiresAt: meta.expiresAt }, 201);
        }
        if (op === "exists")
          return json({ exists: !!meta && meta.expiresAt > time });
        if (
          op !== "ws" ||
          request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
          !protocols(request).includes("kj.v1")
        )
          error(400, "BAD_REQUEST");
        if (!meta || meta.expiresAt <= time) {
          return upgrade(
            this.ctx,
            this.env,
            request,
            { kind: "missing" },
            (ws) => ws.close(4404, "not found"),
          );
        }
        const hostKey = protocols(request)
            .find((p) => p.startsWith("kjh."))
            ?.slice(4),
          host = !!hostKey;
        if (host && (await hash(hostKey)) !== meta.hostHash)
          error(401, "UNAUTHORIZED");
        if (
          host
            ? this.ctx
                .getWebSockets()
                .some((ws) => ws.deserializeAttachment()?.host)
            : meta.guestUsed
        )
          error(429, "ROOM_FULL");
        if (!host) {
          meta.guestUsed = true;
          await this.ctx.storage.put("meta", meta);
        }
        return upgrade(this.ctx, this.env, request, {
          kind: "pair",
          host,
          frames: 0,
        });
      } catch (e) {
        return failure(e);
      }
    });
  }
  async webSocketMessage(ws, message) {
    await this.serial(async () => {
      const meta = await this.ctx.storage.get("meta");
      if (!meta || meta.expiresAt <= now(this.env)) {
        closeAll(this.ctx, 4404, "expired");
        return;
      }
      const a = ws.deserializeAttachment();
      if (
        typeof message !== "string" ||
        new TextEncoder().encode(message).length > 16384 ||
        ++a.frames > 40
      ) {
        ws.close(4429, "pair limit");
        return;
      }
      ws.serializeAttachment(a);
      let m;
      try {
        m = JSON.parse(message);
      } catch {
        ws.close(4400);
        return;
      }
      for (const peer of this.ctx.getWebSockets())
        if (peer !== ws && peer.deserializeAttachment()?.host !== a.host)
          try {
            peer.send(message);
          } catch {}
      if (m.t === "close" && a.host) {
        closeAll(this.ctx);
        await this.ctx.storage.deleteAll();
      }
      if (m.t === "abort") {
        closeAll(this.ctx);
        await this.ctx.storage.deleteAll();
      }
    });
  }
  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }
  webSocketError(ws) {
    try {
      ws.close(1011);
    } catch {}
  }
  async alarm() {
    closeAll(this.ctx, 4404, "expired");
    await this.ctx.storage.deleteAll();
  }
}
