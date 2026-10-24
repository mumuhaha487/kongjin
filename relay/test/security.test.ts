import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Guard, guard } from "../src/guard.mjs";
import { GroupRoom, PairRoom } from "../src/rooms.mjs";
import { handle } from "../src/worker.mjs";
import {
  publicHost,
  imageType,
  safeFetch,
  fetchIcon,
  icon,
} from "../src/icon.mjs";
import { hash, mac, b64, random } from "../src/common.mjs";
import { solvePow } from "../../shared/protocol/src/pow.ts";
import { publicAddress } from "../local/public-fetch.mjs";
function fixture() {
  let clock = 1000000;
  const files = new Map<string, any>(),
    objects = new Map<string, any>(),
    contexts = new Map<string, any>();
  const env: any = {
    TESTING: "true",
    testClock: () => clock,
    POW_SECRET: "unit-proof",
    IP_HASH_SALT: "unit-salt",
    LOCAL: true,
    testConfig: { difficulty: 0 },
    EXTRA_ORIGINS: "http://localhost:*",
    BUCKET: {
      put: async (k: string, v: any, options: any = {}) =>
        files.set(k, {
          data: typeof v === "string" ? new TextEncoder().encode(v) : v,
          customMetadata: options.customMetadata,
        }),
      get: async (k: string) => {
        const f = files.get(k);
        return f
          ? {
              ...f,
              body: f.data,
              arrayBuffer: async () => f.data,
              json: async () => JSON.parse(new TextDecoder().decode(f.data)),
            }
          : null;
      },
      delete: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) files.delete(key);
      },
    },
    localUpgrade: (ctx: any, req: any, a: any) => {
      const ws: any = {
        attachment: a,
        sent: [],
        closed: undefined,
        send(s: string) {
          this.sent.push(JSON.parse(s));
        },
        close(code: number) {
          this.closed = code;
        },
        serializeAttachment(a: any) {
          this.attachment = structuredClone(a);
        },
        deserializeAttachment() {
          return structuredClone(this.attachment);
        },
      };
      ctx.sockets.push(ws);
      return { status: 101, localSocket: ws };
    },
  };
  const ns = (name: string, Class: any) => ({
    idFromName: (id: string) => id,
    get: (id: string) => ({
      fetch: async (req: any) => {
        const key = name + ":" + id;
        if (!objects.has(key)) {
          const values = new Map<string, any>(),
            ctx: any = {
              sockets: [],
              storage: {
                get: async (k: string) => structuredClone(values.get(k)),
                put: async (k: string, v: any) =>
                  values.set(k, structuredClone(v)),
                delete: async (k: string) => values.delete(k),
                deleteAll: async () => values.clear(),
                list: async ({ prefix = "", limit = Infinity }: any = {}) =>
                  new Map(
                    [...values]
                      .filter(([k]) => k.startsWith(prefix))
                      .slice(0, limit),
                  ),
                setAlarm: async (t: number) => {
                  ctx.alarm = t;
                },
              },
              getWebSockets: () => ctx.sockets.filter((s: any) => !s.closed),
            };
          contexts.set(key, ctx);
          objects.set(key, new Class(ctx, env));
        }
        return objects.get(key).fetch(req);
      },
    }),
  });
  env.GUARDS = ns("guard", Guard);
  env.GROUPS = ns("group", GroupRoom);
  env.PAIRS = ns("pair", PairRoom);
  const request = (path: string, init: any = {}, ip = "1.2.3.4") =>
    handle(
      new Request("https://relay.test" + path, {
        ...init,
        headers: { "CF-Connecting-IP": ip, ...init.headers },
      }),
      env,
    );
  return {
    env,
    files,
    objects,
    contexts,
    request,
    set: (t: number) => {
      clock = t;
    },
    get time() {
      return clock;
    },
  };
}
describe("CORS origins", () => {
  it("allows Android WebView preflight and GET while rejecting unlisted origins", async () => {
    const f = fixture();
    const androidOrigin = "https://appassets.androidplatform.net";
    const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    f.env.EXTRA_ORIGINS = /^EXTRA_ORIGINS = "([^"]*)"/m.exec(config)?.[1];
    expect(f.env.EXTRA_ORIGINS).toBe(androidOrigin);
    const extensionOrigin = "chrome-extension://agijcmabomapmbobdgblmckibkpobdij";
    for (const origin of [
      androidOrigin,
      extensionOrigin,
      "https://untrusted.example",
      androidOrigin + ".untrusted.example",
      "https://sub.appassets.androidplatform.net",
      "http://appassets.androidplatform.net",
      androidOrigin + ":8443",
      "http://localhost:8790",
      "null",
    ]) {
      const allowed = origin === androidOrigin || origin === extensionOrigin;
      const preflight = await f.request("/v1/health", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "X-KJ-Token, If-Match",
        },
      });
      const get = await f.request("/v1/health", { headers: { Origin: origin } });
      expect(preflight.status).toBe(204);
      expect(await preflight.text()).toBe("");
      expect(preflight.headers.get("Access-Control-Allow-Methods")?.split(/,\s*/)).toContain("GET");
      expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-KJ-Token, If-Match");
      expect(get.status).toBe(200);
      expect(await get.json()).toMatchObject({ ok: true, service: "kongjing-relay" });
      for (const response of [preflight, get]) {
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(allowed ? origin : null);
        expect(response.headers.get("Vary")).toBe("Origin");
      }
    }
  });
});
describe("static assets", () => {
  it("resolves static HEAD through GET metadata without changing API routing", async () => {
    const f = fixture();
    const assets = new Map([
      ["/", { status: 200, type: "text/html; charset=utf-8", body: "Home" }],
      ["/privacy", { status: 200, type: "text/html; charset=utf-8", body: "Privacy" }],
      ["/download/kongjing-2.0.0.zip", { status: 200, type: "application/zip", body: "ZIP" }],
      ["/logo.svg", { status: 200, type: "image/svg+xml", body: "<svg/>" }],
      ["/redirect", { status: 301, type: "text/html", body: "Moved" }],
      ["/missing", { status: 404, type: "text/html", body: "Not found" }],
    ]);
    const fetchAsset = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      const asset = assets.get(path);
      if (!asset) throw new Error("Unexpected asset request: " + path);
      return new Response(request.method === "HEAD" ? null : asset.body, {
        status: asset.status,
        headers: {
          "Content-Type": asset.type,
          ...(request.method === "HEAD"
            ? {}
            : { "Content-Length": String(new TextEncoder().encode(asset.body).length) }),
          "Cache-Control": "public, max-age=60",
          ETag: '"asset-version"',
          ...(asset.status === 301 ? { Location: "/privacy" } : {}),
        },
      });
    });
    f.env.ASSETS = { fetch: fetchAsset };
    for (const [path, asset] of assets) {
      const headers = { Origin: "http://localhost:8790" };
      const get = await f.request(path, { headers });
      const head = await f.request(path, { method: "HEAD", headers });
      expect(get.status).toBe(asset.status);
      expect(head.status).toBe(get.status);
      expect([...head.headers]).toEqual([...get.headers]);
      expect(head.headers.get("Content-Type")).toBe(asset.type);
      expect(await get.text()).toBe(asset.body);
      expect(head.body).toBeNull();
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      expect(fetchAsset.mock.calls.at(-1)?.[0].method).toBe("GET");
    }
    fetchAsset.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    }), { headers: { "Content-Type": "image/png" } }));
    const streamedHead = await f.request("/streamed.png", { method: "HEAD" });
    expect(streamedHead.status).toBe(200);
    expect(streamedHead.headers.get("Content-Length")).toBe("3");
    expect(streamedHead.body).toBeNull();
    expect((await streamedHead.arrayBuffer()).byteLength).toBe(0);
    expect((await f.request("/v1/health")).status).toBe(200);
    const apiHead = await f.request("/v1/health", { method: "HEAD" });
    expect(apiHead.status).toBe(404);
    expect(await apiHead.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect((await f.request("/privacy", { method: "POST" })).status).toBe(404);
    expect(fetchAsset).toHaveBeenCalledTimes(assets.size * 2 + 1);
  });
});
describe("all anti-abuse boundaries", () => {
  for (const [op, limit, period] of [
    ["global", 300, 60000],
    ["pow", 30, 60000],
    ["group", 5, 3600000],
    ["rotate", 10, 3600000],
    ["pair", 10, 3600000],
    ["icon", 60, 60000],
  ] as const)
    it(`${op} exact production quota ${limit}`, async () => {
      const f = fixture();
      for (let i = 0; i < limit; i++)
        await guard(f.env, "ab00", "rate", { op, purpose: "group" });
      await expect(
        guard(f.env, "ab00", "rate", { op, purpose: "group" }),
      ).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
      f.set(f.time + period);
      await expect(
        guard(f.env, "ab00", "rate", { op, purpose: "group" }),
      ).resolves.toMatchObject({ ok: true });
    });
  it("daily group20 and icon2000 quotas survive hourly/minute resets", async () => {
    for (const [op, count, batch, period] of [
      ["group", 20, 5, 3600000],
      ["icon", 2000, 60, 60000],
    ] as const) {
      const f = fixture();
      for (let i = 0; i < count; i++) {
        if (i && i % batch === 0) f.set(f.time + period);
        await guard(f.env, "ab00", "rate", { op });
      }
      f.set(f.time + period);
      await expect(guard(f.env, "ab00", "rate", { op })).rejects.toMatchObject({
        status: 429,
      });
    }
  });
  it("pair guest weighted failures and 30 minute lock", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++)
      await guard(f.env, "ab00", "rate", { op: "guest", missing: true });
    await expect(
      guard(f.env, "ab00", "rate", { op: "guest" }),
    ).rejects.toMatchObject({ retryAfter: 1800 });
    f.set(f.time + 600001);
    await expect(
      guard(f.env, "ab00", "rate", { op: "guest" }),
    ).rejects.toMatchObject({ status: 429 });
    f.set(f.time + 1200000);
    await expect(
      guard(f.env, "ab00", "rate", { op: "guest" }),
    ).resolves.toMatchObject({ ok: true });
  });
  it("PoW issuance, wrong purpose, signature, replay, cross-IP replay, expiry", async () => {
    const f = fixture();
    const r = await f.request("/v1/pow?purpose=group"),
      challenge = await r.json(),
      p = { ...challenge, nonce: "AAAAAAAAAAA" };
    const args = { purpose: "group", proof: p };
    const ip = await hash("1.2.3.4|unit-salt");
    await expect(
      guard(f.env, ip, "proof", { ...args, purpose: "pair" }),
    ).rejects.toMatchObject({ code: "POW_INVALID" });
    await expect(
      guard(f.env, "different", "proof", args),
    ).rejects.toMatchObject({ code: "POW_INVALID" });
    await guard(f.env, ip, "proof", args);
    await expect(guard(f.env, ip, "proof", args)).rejects.toMatchObject({
      code: "POW_INVALID",
    });
    f.set(f.time + 120001);
    await expect(guard(f.env, ip, "proof", args)).rejects.toMatchObject({
      code: "POW_INVALID",
    });
  });
  it("adaptive difficulty 18 to22 beyond half of hourly quota", async () => {
    const f = fixture();
    delete f.env.testConfig.difficulty;
    expect(
      (await guard(f.env, "ab00", "rate", { op: "pow", purpose: "group" }))
        .difficulty,
    ).toBe(18);
    for (let i = 0; i < 3; i++)
      await guard(f.env, "ab00", "rate", { op: "group" });
    expect(
      (await guard(f.env, "ab00", "rate", { op: "pow", purpose: "group" }))
        .difficulty,
    ).toBe(22);
  });
  it("global capacity50000 and release", async () => {
    const f = fixture();
    await guard(f.env, "", "capacity", { room: "first", op: "reserve" });
    const ctx = f.contexts.get("guard:kongjing-capacity");
    await ctx.storage.put("count", 50000);
    await expect(
      guard(f.env, "", "capacity", { room: "next", op: "reserve" }),
    ).rejects.toMatchObject({ status: 503, message: "服务容量已满" });
    await guard(f.env, "", "capacity", { room: "first", op: "release" });
    await expect(
      guard(f.env, "", "capacity", { room: "next", op: "reserve" }),
    ).resolves.toMatchObject({ ok: true });
  });
  it('duplicate active or retired room creation does not corrupt capacity reservations',async()=>{
    const f=fixture(),room='V'.repeat(32),token='capacity-test';
    const create=async()=>{
      const proof={...await(await f.request('/v1/pow?purpose=group')).json(),nonce:'AAAAAAAAAAA'};
      return f.request('/v1/groups',{method:'POST',body:JSON.stringify({room,tokenHash:await hash(token),pow:proof})});
    };
    expect((await create()).status).toBe(201);
    const capacity=f.contexts.get('guard:kongjing-capacity');
    expect(await capacity.storage.get('count')).toBe(1);
    expect((await create()).status).toBe(409);
    expect(await capacity.storage.get('count')).toBe(1);
    expect((await f.request('/v1/groups/'+room,{method:'DELETE',headers:{'X-KJ-Token':token}})).status).toBe(204);
    expect(await capacity.storage.get('count')).toBe(0);
    expect((await create()).status).toBe(409);
    expect(await capacity.storage.get('count')).toBe(0);
  });
  it("room GET120 PUT60, serialized CAS, 12 peers and WS30/burst10", async () => {
    const f = fixture(),
      room = "A".repeat(32),
      token = "capability",
      tokenHash = await hash(token),
      stub = f.env.GROUPS.get(room);
    const call = (op: string, method = "GET", body?: any, headers: any = {}) =>
      stub.fetch(
        new Request("https://internal/" + op, {
          method,
          headers: { "X-KJ-Token": token, ...headers },
          body,
        }),
      );
    await call("create", "POST", JSON.stringify({ room, tokenHash }));
    const results = await Promise.all([
      call("snapshot", "PUT", "a", { "If-Match": '"0"' }),
      call("snapshot", "PUT", "b", { "If-Match": '"0"' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
    for (let i = 0; i < 58; i++)
      expect(
        (await call("snapshot", "PUT", "a", { "If-Match": '"0"' })).status,
      ).toBe(412);
    expect(
      (await call("snapshot", "PUT", "a", { "If-Match": '"0"' })).status,
    ).toBe(429);
    for (let i = 0; i < 120; i++)
      expect((await call("snapshot")).status).toBe(200);
    expect((await call("snapshot")).status).toBe(429);
    for (let i = 0; i < 12; i++)
      expect(
        (
          await call("ws", "GET", undefined, {
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": "kj.v1,kjt." + token,
          })
        ).status,
      ).toBe(101);
    expect(
      (
        await call("ws", "GET", undefined, {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "kj.v1,kjt." + token,
        })
      ).status,
    ).toBe(429);
    const object = f.objects.get("group:" + room),
      ws = f.contexts.get("group:" + room).sockets[0];
    for (let i = 0; i < 10; i++)
      await object.webSocketMessage(ws, '{"type":"ping"}');
    await object.webSocketMessage(ws, '{"type":"ping"}');
    expect(ws.closed).toBe(4429);
  });
  it("WS sustained30, snapshot64KiB frame cap and pair40 frame cap", async () => {
    const f = fixture(),
      room = "A".repeat(32),
      token = "cap",
      stub = f.env.GROUPS.get(room);
    await stub.fetch(
      new Request("https://i/create", {
        method: "POST",
        body: JSON.stringify({ room, tokenHash: await hash(token) }),
      }),
    );
    const ctx = f.contexts.get("group:" + room),
      o = f.objects.get("group:" + room);
    await stub.fetch(
      new Request("https://i/ws", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "kj.v1,kjt." + token,
        },
      }),
    );
    const ws = ctx.sockets[0];
    for (let i = 0; i < 30; i++) {
      await o.webSocketMessage(ws, '{"type":"ping"}');
      f.set(f.time + 1800);
    }
    await o.webSocketMessage(ws, '{"type":"ping"}');
    expect(ws.closed).toBe(4429);
  });
  it("10 minute pair expiry, single guest, 40frames and 16KiB", async () => {
    const f = fixture(),
      room = "P".repeat(32),
      stub = f.env.PAIRS.get(room);
    const p = await (
      await stub.fetch(
        new Request("https://i/create", {
          method: "POST",
          body: JSON.stringify({ room }),
        }),
      )
    ).json();
    const connect = (host = false) =>
      stub.fetch(
        new Request("https://i/ws", {
          headers: {
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol":
              "kj.v1" + (host ? ",kjh." + p.hostKey : ""),
          },
        }),
      );
    await connect(true);
    await connect();
    expect((await connect()).status).toBe(429);
    const ctx = f.contexts.get("pair:" + room),
      o = f.objects.get("pair:" + room),
      ws = ctx.sockets[1];
    for (let i = 0; i < 40; i++) await o.webSocketMessage(ws, '{"t":"hello"}');
    await o.webSocketMessage(ws, '{"t":"hello"}');
    expect(ws.closed).toBe(4429);
    f.set(f.time + 600001);
    await o.alarm();
    expect(await ctx.storage.get("meta")).toBeUndefined();
    expect(ctx.sockets[0].closed).toBe(4404);
  });
  it("forward expires30days; group idle180days deletes R2 and storage", async () => {
    const f = fixture(),
      room = "R".repeat(32),
      token = "cap",
      stub = f.env.GROUPS.get(room);
    const call = (op: string, method = "GET", body?: any) =>
      stub.fetch(
        new Request("https://i/" + op, {
          method,
          headers: { "X-KJ-Token": token },
          body,
        }),
      );
    await call(
      "create",
      "POST",
      JSON.stringify({ room, tokenHash: await hash(token) }),
    );
    await call(
      "forward",
      "POST",
      JSON.stringify({ env: { v: 1, iv: "A".repeat(16), ct: "A".repeat(22) } }),
    );
    f.set(f.time + 30 * 86400000 + 1);
    await f.objects.get("group:" + room).alarm();
    expect(f.files.has("g/" + room + "/forward")).toBe(false);
    f.set(f.time + 180 * 86400000);
    await f.objects.get("group:" + room).alarm();
    expect(
      await f.contexts.get("group:" + room).storage.get("meta"),
    ).toBeUndefined();
    expect(f.files.size).toBe(0);
  });
});
describe("icon SSRF, decoding and caches", () => {
  it("local DNS pinning rejects private, mapped and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.2.1",
      "192.168.2.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ])
      expect(publicAddress(address)).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects IPs and forbidden hostnames including redirected destinations", async () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "printer",
      "x.local",
      "a.internal",
      "x.lan",
      "10.0.0.1",
      "2130706433",
      "0x7f000001",
      "x".repeat(254),
    ])
      expect(publicHost(h)).toBe(false);
    expect(publicHost("example.com")).toBe(true);
    for (const location of [
      "http://127.0.0.1/x",
      "http://localhost/",
      "http://a.internal/",
      "http://x.lan/",
    ]) {
      let calls = 0;
      await expect(
        safeFetch("https://example.com/", 100, async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { Location: location },
          });
        }),
      ).rejects.toThrow("Unsafe");
      expect(calls).toBe(1);
    }
  });
  it("3redirect maximum and exact byte limits", async () => {
    let count = 0;
    await expect(
      safeFetch("https://example.com/", 10, async () => {
        count++;
        return new Response(null, {
          status: 302,
          headers: { Location: "/next" },
        });
      }),
    ).rejects.toThrow("Redirect");
    expect(count).toBe(4);
    await expect(
      safeFetch(
        "https://example.com/",
        10,
        async () => new Response(new Uint8Array(11)),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("magic types only, SVG sandbox and R2 positive/negative cache expiry", async () => {
    expect(imageType(new TextEncoder().encode("<html>bad"))).toBeNull();
    expect(imageType(new TextEncoder().encode('<svg xmlns="x">'))).toBe(
      "image/svg+xml",
    );
    const f = fixture();
    let calls = 0;
    f.env.iconFetch = async () => {
      calls++;
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>');
    };
    let r = await icon(
      new Request("https://relay.test/v1/icon?host=example.com"),
      f.env,
    );
    expect(r.headers.get("Content-Security-Policy")).toBe("sandbox");
    const before = calls;
    await icon(
      new Request("https://relay.test/v1/icon?host=example.com"),
      f.env,
    );
    expect(calls).toBe(before);
    f.env.iconFetch = async () => {
      calls++;
      return new Response(null, { status: 404 });
    };
    r = await icon(
      new Request("https://relay.test/v1/icon?host=missing.example"),
      f.env,
    );
    expect(r.status).toBe(404);
    const failCount = calls;
    await icon(
      new Request("https://relay.test/v1/icon?host=missing.example"),
      f.env,
    );
    expect(calls).toBe(failCount);
    f.set(f.time + 86400001);
    await icon(
      new Request("https://relay.test/v1/icon?host=missing.example"),
      f.env,
    );
    expect(calls).toBeGreaterThan(failCount);
  });
});

describe('v2.2.1 write amplification and restart boundaries',()=>{
 it('minute counters do not write storage; long quotas and used PoW survive a Guard restart',async()=>{
  const f=fixture(),ip='198.51.100.77';
  const call=(op:string)=>f.request('/v1/health',{},ip);
  await call('global');const key=[...f.objects.keys()].find(k=>k.startsWith('guard:'))!,ctx=f.contexts.get(key);
  const put=vi.spyOn(ctx.storage,'put'),alarm=vi.spyOn(ctx.storage,'setAlarm');
  for(let i=0;i<20;i++)await call('global');expect(put).not.toHaveBeenCalled();expect(alarm).not.toHaveBeenCalled();
  const pow=await(await f.request('/v1/pow?purpose=group',{},ip)).json();
  const body={room:'Y'.repeat(32),tokenHash:await hash('token'),pow:{...pow,nonce:'AAAAAAAAAAA'}};
  expect((await f.request('/v1/groups',{method:'POST',body:JSON.stringify(body)},ip)).status).toBe(201);
  f.objects.set(key,new Guard(ctx,f.env));
  expect((await f.request('/v1/groups',{method:'POST',body:JSON.stringify({...body,room:'Z'.repeat(32)})},ip)).status).toBe(400);
  const hashed=await hash(ip+'|unit-salt');
  for(let i=0;i<4;i++)await guard(f.env,hashed,'rate',{op:'group'});
  f.objects.set(key,new Guard(ctx,f.env));
  await expect(guard(f.env,hashed,'rate',{op:'group'})).rejects.toMatchObject({status:429});
 });
});
