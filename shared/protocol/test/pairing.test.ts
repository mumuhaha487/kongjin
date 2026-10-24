import { describe, expect, it } from "vitest";
import {
  KongjingSync,
  MemorySecretStore,
  b64url,
  hmac,
  identity,
  normalizePairCode,
  pairKeys,
  verifyMac,
} from "../src/index.ts";

type Frame = Record<string, any>;
type Mutate = (frame: Frame, authKey: Uint8Array, helloJ: Frame) => void | Promise<void>;

// Run the real invite/join handlers with a relay that can alter an opaque frame.
async function handshake(options: {
  name?: string;
  platform?: string;
  renameTo?: string;
  mutate?: Mutate;
} = {}) {
  const secrets = new MemorySecretStore(), self = await identity();
  const name = options.name ?? "MacBook · Chrome",
    platform = options.platform ?? "macOS · Chrome";
  await secrets.set("identity", self);
  await secrets.set("group", {
    gk: b64url(new Uint8Array(32)), epoch: 1, rev: 0, name, platform,
    members: [{ deviceId: self.deviceId, pub: self.pub, name, platform,
      joinedAt: 1, addedBy: self.deviceId }],
  });
  const sockets = new Map<string, Socket>(), sent: Frame[] = [];
  let authKey!: Uint8Array, helloJ!: Frame, rev = 0;
  class Socket extends EventTarget {
    readyState = 0;
    role?: string;
    constructor(url: string, protocols: string[]) {
      super();
      if (new URL(url).pathname.startsWith("/v1/pair/")) {
        this.role = protocols.some(p => p.startsWith("kjh.")) ? "host" : "guest";
        sockets.set(this.role, this);
      }
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(data: string) {
      if (!this.role) return;
      const frame = JSON.parse(data);
      sent.push(structuredClone(frame));
      if (frame.t === "hello-j") helloJ = structuredClone(frame);
      const peer = sockets.get(this.role === "host" ? "guest" : "host")!;
      void Promise.resolve().then(async () => {
        await options.mutate?.(frame, authKey, helloJ);
        if (peer.readyState === 1)
          peer.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }).catch(() => this.dispatchEvent(new Event("error")));
    }
    close() { this.readyState = 3; }
  }
  const fetcher = (async (url: any, init: any = {}) => {
    if (String(url).includes("/pow?")) return Response.json({
      challenge: b64url(new Uint8Array(16)), difficulty: 0,
      expiresAt: Date.now() + 120000, purpose: "pair", sig: "test",
    });
    if (init.method === "POST") return Response.json({
      hostKey: "test-host", expiresAt: Date.now() + 600000,
    }, { status: 201 });
    if (init.method === "PUT") return Response.json({ rev: ++rev });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const make = (store: MemorySecretStore) => new KongjingSync({
    relayUrl: "https://relay.example", secrets: store,
    loadLocal: async () => ({}), saveMerged: async () => {}, merge: a => a,
    fetch: fetcher, WebSocket: Socket as any,
  });
  const inviter = make(secrets), joiner = make(new MemorySecretStore());
  try {
    await inviter.init();
    if (options.renameTo !== undefined) await inviter.renameSelf(options.renameTo);
    const invite = await inviter.invite();
    const peer = new Promise<{ name: string; platform: string; sas: string }>(resolve => invite.onPeer(resolve));
    ({ authKey } = await pairKeys(normalizePairCode(invite.code)!));
    const join = await joiner.join(invite.code, "Windows · Edge", "Windows · Edge");
    return { invite, join, peer, sent, authKey, inviter, joiner,
      dispose() { inviter.dispose(); joiner.dispose(); } };
  } catch (e) {
    inviter.dispose(); joiner.dispose(); throw e;
  }
}

describe("hello-i inviter labels (PROTOCOL v2.1)", () => {
  it.each([
    ["MacBook · Chrome", "macOS · Chrome"],
    ["客厅电脑", "Windows · Edge"],
    ["  工作💻 e\u0301  ", "Linux · Chrome"],
  ])("returns the authenticated name %j and platform without changing display text", async (name, platform) => {
    const f = await handshake({ name, platform });
    try {
      const [i, j] = await Promise.all([f.peer, f.join.sas]);
      expect(j).toEqual({ sas: i.sas, inviterName: name, platform });
      const helloI = f.sent.find(m => m.t === "hello-i")!,
        helloJ = f.sent.find(m => m.t === "hello-j")!;
      expect(helloI.name).toBe(name);
      expect(helloI.platform).toBe(platform);
      expect(await verifyMac(f.authKey,
        "I|" + helloI.epk + "|" + helloJ.epk + "|" + name + "|" + platform,
        helloI.mac)).toBe(true);
      expect(i.name).toBe("Windows · Edge");
      expect(i.platform).toBe("Windows · Edge");
    } finally { f.dispose(); }
  });

  it("uses the inviter's latest name after renameSelf", async () => {
    const f = await handshake({ renameTo: "改名后的工作机" });
    try { expect((await f.join.sas).inviterName).toBe("改名后的工作机"); }
    finally { f.dispose(); }
  });

  it.each(["name", "platform"])("rejects a modified hello-i %s before exposing SAS or accepting confirmation", async field => {
    const f = await handshake({ mutate(m) {
      if (m.t === "hello-i") m[field] += "-tampered";
    } });
    let exposed = false;
    void f.join.sas.then(() => { exposed = true; }, () => {});
    try {
      await expect(f.join.sas).rejects.toMatchObject({ code: "BAD_CODE" });
      await expect(f.join.done).rejects.toMatchObject({ code: "BAD_CODE" });
      await expect(f.join.confirm()).rejects.toMatchObject({ code: "BAD_CODE" });
      expect(exposed).toBe(false);
      expect(f.joiner.status().paired).toBe(false);
      expect(f.sent).toContainEqual({ t: "abort", reason: "BAD_CODE" });
    } finally { f.dispose(); }
  });

  it("rejects the old hello-i MAC even when labels are present", async () => {
    const f = await handshake({ async mutate(m, key, j) {
      if (m.t === "hello-i") m.mac = await hmac(key, "I|" + m.epk + "|" + j.epk);
    } });
    try { await expect(f.join.sas).rejects.toMatchObject({ code: "BAD_CODE" }); }
    finally { f.dispose(); }
  });

  for (const t of ["hello-i", "hello-j"]) {
    for (const field of ["name", "platform"]) {
      it.each([undefined, null, 123, ["device"]])(
        `rejects ${t} ${field}=%j even with a matching MAC`, async value => {
          const f = await handshake({ async mutate(m, key, j) {
            if (m.t !== t) return;
            m[field] = value;
            const transcript = t === "hello-i"
              ? "I|" + m.epk + "|" + j.epk + "|" + m.name + "|" + m.platform
              : "J|" + m.epk + "|" + m.id + "|" + m.name + "|" + m.platform;
            m.mac = await hmac(key, transcript);
          } });
          try { await expect(f.join.sas).rejects.toMatchObject({ code: "BAD_CODE" }); }
          finally { f.dispose(); }
        },
      );
    }
  }
});
