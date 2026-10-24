import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { solvePow } from "../../shared/protocol/src/pow.ts";
import { network } from "../scripts/network.mjs";
const vectors = JSON.parse(
  await readFile(
    new URL("../../shared/protocol/test/vectors.json", import.meta.url),
    "utf8",
  ),
);
export async function protocolSuite(base: string, proxy?: string, fetcher?: any) {
  const client = network(proxy),
    checks: string[] = [],
    created: { room: string; token: string }[] = [],
    pairs: { room: string; hostKey: string }[] = [];
  const sockets: any[] = [];
  if(fetcher)client.fetch=fetcher;
  const residualRooms: string[] = [];
  const origin = "chrome-extension://agijcmabomapmbobdgblmckibkpobdij";
  const call = async (path: string, init: any = {}): Promise<any> =>
    client.fetch(base + path, {
      ...init,
      headers: { Origin: origin, ...init.headers },
    });
  const step = async (name: string, fn: () => Promise<void>) => {
    await fn();
    checks.push(name);
    console.log("PASS " + name);
  };
  const expectError = async (r: any, status: number, code: string) => {
    assert.equal(r.status, status);
    assert.equal((await r.json()).error.code, code);
  };
  const proof = async (purpose = "group") =>
    solvePow(await (await call("/v1/pow?purpose=" + purpose)).json());
  const create = async (pow: any) => {
    const room = randomBytes(24).toString("base64url"),
      token = randomBytes(32).toString("base64url"),
      tokenHash = (await import("node:crypto"))
        .createHash("sha256")
        .update(token)
        .digest("hex");
    const r = await call("/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, tokenHash, pow }),
    });
    assert.equal(r.status, 201);
    created.push({ room, token });
    return { room, token, tokenHash };
  };
  const wsOpen = (url: string, protocols: string[]) =>
    new Promise<any>((ok, bad) => {
      const ws = new client.WebSocket(url, protocols);
      sockets.push(ws);
      (ws as any).kjMessages = [];
      ws.on('message', (data: Buffer) => {
        try { (ws as any).kjMessages.push(JSON.parse(data.toString())); } catch {}
      });
      ws.once("open", () => ok(ws));
      ws.once("error", bad);
    });
  const waitMessage = async (ws: any, type: string) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const value = ws.kjMessages.find((m: any) => m.type === type);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('WS message timeout: ' + type);
  };
  const closeCode = (ws: any, send?: () => void) =>
    new Promise<number>((ok, bad) => {
      const timer = setTimeout(() => bad(new Error("WS close timeout")), 40000);
      ws.once("close", (code: number) => {
        clearTimeout(timer);
        ok(code);
      });
      send?.();
    });
  let main: any;
  try {
    await step("health + CORS + errors", async () => {
      let r = await call("/v1/health");
      assert.equal(r.status, 200);
      assert.equal((await r.json()).service, "kongjing-relay");
      assert.equal(r.headers.get("Access-Control-Allow-Origin"), origin);
      assert.equal(r.headers.get("Cache-Control"), "no-store");
      r = await call("/v1/groups", { method: "OPTIONS" });
      assert.equal(r.status, 204);
      assert.equal(
        r.headers.get("Access-Control-Expose-Headers"),
        "ETag, Retry-After",
      );
      assert.equal(
        (
          await call("/v1/health", {
            headers: { Origin: "https://evil.example" },
          })
        ).headers.get("Access-Control-Allow-Origin"),
        null,
      );
      await expectError(await call("/v1/absent"), 404, "NOT_FOUND");
      await expectError(await call("/v1/pow?purpose=no"), 400, "BAD_REQUEST");
    });
    await step(
      "PoW required + tampered + expired + purpose + wrong nonce",
      async () => {
        const b = {
          room: randomBytes(24).toString("base64url"),
          tokenHash: "0".repeat(64),
        };
        const post = (pow?: any) =>
          call("/v1/groups", {
            method: "POST",
            body: JSON.stringify({ ...b, pow }),
          });
        await expectError(await post(), 428, "POW_REQUIRED");
        const p = await proof();
        await expectError(await post({ ...p, sig: "bad" }), 400, "POW_INVALID");
        await expectError(
          await post({ ...p, expiresAt: Date.now() - 1 }),
          400,
          "POW_INVALID",
        );
        await expectError(
          await post({ ...p, purpose: "pair" }),
          400,
          "POW_INVALID",
        );
        await expectError(
          await post({ ...p, nonce: "bad" }),
          400,
          "POW_INVALID",
        );
        main = await create(p);
        await expectError(await post(p), 400, "POW_INVALID");
        await expectError(await call('/v1/groups', { method:'POST', headers:{'X-KJ-Token':main.token}, body:JSON.stringify({room:main.room,tokenHash:main.tokenHash,rotateFrom:main.room}) }),409,'CONFLICT');
        await expectError(await call('/v1/groups', { method:'POST', headers:{'X-KJ-Token':'wrong'}, body:JSON.stringify({room:randomBytes(24).toString('base64url'),tokenHash:main.tokenHash,rotateFrom:main.room}) }),401,'UNAUTHORIZED');
      },
    );
    await step(
      "snapshot empty + unauthorized + not found + If-Match CAS",
      async () => {
        const p = "/v1/groups/" + main.room + "/snapshot",
          headers = { "X-KJ-Token": main.token };
        assert.equal((await call(p, { headers })).status, 204);
        await expectError(await call(p), 401, "UNAUTHORIZED");
        await expectError(await call(p,{method:'PUT',body:'x'}),401,'UNAUTHORIZED');
        await expectError(await call('/v1/groups/'+main.room+'/forward'),401,'UNAUTHORIZED');
        await expectError(await call('/v1/groups/'+main.room+'/forward',{method:'POST',body:'{}'}),401,'UNAUTHORIZED');
        await expectError(await call('/v1/groups/'+main.room,{method:'DELETE'}),401,'UNAUTHORIZED');
        await expectError(
          await call("/v1/groups/" + vectors.group.roomId + "/snapshot", {
            headers,
          }),
          404,
          "NOT_FOUND",
        );
        await expectError(
          await call(p, { method: "PUT", headers, body: "abc" }),
          400,
          "BAD_REQUEST",
        );
        const r = await call(p, {
          method: "PUT",
          headers: { ...headers, "If-Match": '"0"' },
          body: "ciphertext",
        });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).rev, 1);
        const conflict = await call(p, {
          method: "PUT",
          headers: { ...headers, "If-Match": '"0"' },
          body: "other",
        });
        assert.equal(conflict.status, 412);
        assert.deepEqual(await conflict.json(), { rev: 1 });
        const get = await call(p, { headers });
        assert.equal(get.headers.get("ETag"), '"1"');
        assert.equal(await get.text(), "ciphertext");
      },
    );
    await step(
      "snapshot 1 MiB boundary + forward 16 KiB boundary",
      async () => {
        const path = "/v1/groups/" + main.room,
          headers = { "X-KJ-Token": main.token, "If-Match": '"1"' };
        let r = await call(path + "/snapshot", {
          method: "PUT",
          headers,
          body: Buffer.alloc(1048576),
        });
        assert.equal(r.status, 200);
        await expectError(
          await call(path + "/snapshot", {
            method: "PUT",
            headers,
            body: Buffer.alloc(1048577),
          }),
          413,
          "PAYLOAD_TOO_LARGE",
        );
        await expectError(
          await call(path + "/forward", { headers }),
          404,
          "NOT_FOUND",
        );
        await expectError(
          await call(path + "/forward", {
            method: "POST",
            headers,
            body: JSON.stringify({ env: { bad: true } }),
          }),
          400,
          "BAD_REQUEST",
        );
        await expectError(
          await call(path + "/forward", {
            method: "POST",
            headers,
            body: "x".repeat(16385),
          }),
          413,
          "PAYLOAD_TOO_LARGE",
        );
        const env = { v: 1, iv: "A".repeat(16), ct: "A".repeat(22) },
          body = JSON.stringify({ env });
        r = await call(path + "/forward", {
          method: "POST",
          headers,
          body: body + " ".repeat(16384 - Buffer.byteLength(body)),
        });
        assert.equal(r.status, 200);
        assert.deepEqual(
          await (await call(path + "/forward", { headers })).json(),
          { env },
        );
      },
    );
    await step(
      "group WS hello + ping + relay + 64 KiB + burst limit",
      async () => {
        const url =
          base.replace(/^http/, "ws") + "/v1/groups/" + main.room + "/ws";
        await assert.rejects(wsOpen(url,['kj.v1','kjt.wrong']));
        const a = await wsOpen(url, ["kj.v1", "kjt." + main.token]);
        assert.equal(a.protocol, "kj.v1");
        assert.equal((await waitMessage(a,'hello')).rev,2);
        a.send('{"type":"ping"}');
        assert.equal((await waitMessage(a,'pong')).type,'pong');
        const b = await wsOpen(url, ["kj.v1", "kjt." + main.token]);
        const got = new Promise<any>((resolve) =>
          b.on("message", (s: Buffer) => {
            const m = JSON.parse(s.toString());
            if (m.type === "relay") resolve(m);
          }),
        );
        a.send(
          JSON.stringify({
            type: "relay",
            env: { v: 1, iv: "A".repeat(16), ct: "A".repeat(22) },
          }),
        );
        assert.equal((await got).type, "relay");
        const exact = {type:'relay',env:{v:1,iv:'A'.repeat(16),ct:'A'.repeat(22)}};
        exact.env.ct += 'A'.repeat(65536-Buffer.byteLength(JSON.stringify(exact)));
        const exactFrame = JSON.stringify(exact);
        assert.equal(Buffer.byteLength(exactFrame),65536);
        const exactGot = new Promise<number>((resolve)=>b.on('message',(data:Buffer)=>{const m=JSON.parse(data.toString());if(m.type==='relay'&&m.env.ct===exact.env.ct)resolve(m.env.ct.length);}));
        a.send(exactFrame);assert.equal(await exactGot,exact.env.ct.length);
        assert.equal(await closeCode(a, () => a.send("x".repeat(65537))), 4429);
        assert.equal(
          await closeCode(b, () => {
            for (let i = 0; i < 11; i++) b.send('{"type":"ping"}');
          }),
          4429,
        );
      },
    );
    await step("retirement 410 + retained forward", async () => {
      const path = "/v1/groups/" + main.room,
        headers = { "X-KJ-Token": main.token };
      assert.equal(
        (await call(path, { method: "DELETE", headers })).status,
        204,
      );
      await expectError(
        await call(path + "/snapshot", { headers }),
        410,
        "GONE",
      );
      assert.equal((await call(path + "/forward", { headers })).status, 200);
    });
    await step(
      "pair create + host auth + single guest + 16 KiB + missing close4404",
      async () => {
        const p = await proof("pair"),
          room = randomBytes(24).toString("base64url"),
          r = await call("/v1/pair", {
            method: "POST",
            body: JSON.stringify({ room, pow: p }),
          });
        assert.equal(r.status, 201);
        const { hostKey } = await r.json();
        pairs.push({ room, hostKey });
        await expectError(await call('/v1/pair',{method:'POST',body:JSON.stringify({room:randomBytes(24).toString('base64url')})}),428,'POW_REQUIRED');
        await expectError(await call('/v1/pair',{method:'POST',body:JSON.stringify({room,pow:await proof('pair')})}),409,'CONFLICT');
        const url = base.replace(/^http/, "ws") + "/v1/pair/" + room + "/ws";
        await assert.rejects(wsOpen(url,['kj.v1','kjh.wrong']));
        const host = await wsOpen(url, ["kj.v1", "kjh." + hostKey]),
          guest = await wsOpen(url, ["kj.v1"]);
        await assert.rejects(wsOpen(url,['kj.v1','kjh.'+hostKey]));
        await assert.rejects(wsOpen(url, ["kj.v1"]));
        const message = new Promise<string>((resolve) =>
          host.once("message", (s: Buffer) => resolve(s.toString())),
        );
        guest.send('{"t":"hello-j","test":true}');
        assert.equal(JSON.parse(await message).t, "hello-j");
        assert.equal(
          await closeCode(guest, () => guest.send("x".repeat(16385))),
          4429,
        );
        host.send('{"t":"close"}');
        const missing = await wsOpen(
          base.replace(/^http/, "ws") +
            "/v1/pair/" +
            randomBytes(24).toString("base64url") +
            "/ws",
          ["kj.v1"],
        );
        assert.equal(await closeCode(missing), 4404);
      },
    );
    await step("icon SSRF rejects IP localhost private names", async () => {
      for (const host of [
        "127.0.0.1",
        "[::1]",
        "localhost",
        "printer",
        "x.local",
        "a.internal",
        "x.lan",
        "2130706433",
        "0x7f000001",
      ])
        await expectError(
          await call("/v1/icon?host=" + encodeURIComponent(host)),
          400,
          "BAD_REQUEST",
        );
      await expectError(await call('/v1/icon?host=missing-icon.example'),404,'NOT_FOUND');
    });
    return {
      timestamp: new Date().toISOString(),
      base,
      mode: proxy ? "proxy" : "direct",
      checks,
      result: "passed",
      residualRooms,
    };
  } finally {
    for (const ws of sockets) if (ws.readyState < 3) ws.terminate();
    for (const p of pairs)
      try {
        const ws = await wsOpen(
          base.replace(/^http/, "ws") + "/v1/pair/" + p.room + "/ws",
          ["kj.v1", "kjh." + p.hostKey],
        );
        ws.send('{"t":"close"}');
        ws.close();
      } catch {}
    try {
      for (const c of created) {
        try {
          const response = await call('/v1/groups/'+c.room,{method:'DELETE',headers:{'X-KJ-Token':c.token}});
          await response.text();
          if (![204,404].includes(response.status)) residualRooms.push(c.room);
        } catch { residualRooms.push(c.room); }
      }
      if (base === 'https://kongjing.inc.re' && created.length) {
        const { cleanR2 } = await import('../scripts/r2.mjs');
        await cleanR2(created.map(c=>c.room));
      }
      assert.deepEqual(residualRooms,[], 'Test room cleanup failed');
    } finally { await client.close(); }
  }
}
if (process.argv[1]?.endsWith("protocol.ts")) {
  const base = process.argv[2] ?? "http://127.0.0.1:8790",
    proxy = process.argv.includes("--proxy")
      ? process.argv[process.argv.indexOf("--proxy") + 1]
      : undefined;
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  try {
    const result = await protocolSuite(base, proxy);
    await writeFile(
      new URL(
        "../artifacts/protocol-" +
          (!base.includes("kongjing.inc.re") && !base.includes("8791")
            ? "local"
            : base.includes("8791")
              ? "worker"
              : "online") +
          ".json",
        import.meta.url,
      ),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(`PASSED ${result.checks.length} protocol groups`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Protocol suite failed");
    process.exitCode = 1;
  }
}
