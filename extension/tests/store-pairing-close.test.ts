import { describe, it, expect, vi } from "vitest";
import {
  KongjingSync,
  MemorySecretStore,
  identity,
  b64url,
  type SecretStore,
  type InviteSession,
  type Member,
} from "../src/vendor/protocol-store/index.ts";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
// A real encrypted handshake with an opaque relay and explicitly gated async boundaries.
async function fixture(
  options: {
    immediateClose?: boolean;
    slowStore?: "host" | "guest";
    groupFailure?: boolean;
    groupGate?: boolean;
    badWelcome?: boolean;
    persistFailure?: boolean;
    hostPersistFailure?: boolean;
    pullFailure?: boolean;
  } = {},
) {
  const hostStore = new MemorySecretStore(),
    guestStore = new MemorySecretStore(),
    host = await identity();
  await hostStore.set("identity", host);
  await hostStore.set("group", {
    gk: b64url(new Uint8Array(32)),
    epoch: 1,
    rev: 0,
    name: "Inviter",
    platform: "Node",
    members: [
      {
        deviceId: host.deviceId,
        pub: host.pub,
        name: "Inviter",
        platform: "Node",
        joinedAt: 1,
        addedBy: host.deviceId,
      },
    ],
  });
  const saving = deferred(),
    releaseSave = deferred(),
    groupOpening = deferred(),
    releaseGroup = deferred();
  const pairs = new Map<string, Socket>(),
    frames: Record<string, unknown>[] = [];
  let welcomeSeen = false,
    snapshot: Uint8Array | undefined,
    rev = 0;
  const store = (
    role: "host" | "guest",
    source: MemorySecretStore,
  ): SecretStore => ({
    get: (k) => source.get(k),
    delete: (k) => source.delete(k),
    async set(k, v) {
      if (k === "group" && welcomeSeen && role === options.slowStore) {
        saving.resolve();
        await releaseSave.promise;
      }
      if (
        k === "group" &&
        welcomeSeen &&
        role === "guest" &&
        options.persistFailure
      )
        throw new Error("disk failure");
      if (
        k === "group" &&
        welcomeSeen &&
        role === "host" &&
        options.hostPersistFailure
      )
        throw new Error("host disk failure");
      await source.set(k, v);
    },
  });
  class Socket extends EventTarget {
    readyState = 0;
    constructor(
      public role: "host" | "guest",
      public pair: boolean,
    ) {
      super();
      if (pair) pairs.set(role, this);
      queueMicrotask(
        () =>
          void (async () => {
            if (!pair && role === "guest") {
              groupOpening.resolve();
              if (options.groupGate) await releaseGroup.promise;
              if (options.groupFailure) {
                this.remoteClose(1006);
                return;
              }
            }
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
          })(),
      );
    }
    remoteClose(code = 1000) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const e = new Event("close");
      Object.defineProperty(e, "code", { value: code });
      this.dispatchEvent(e);
    }
    close() {
      this.remoteClose();
    }
    send(raw: string) {
      if (this.readyState !== 1) return;
      if (!this.pair) return;
      const frame = JSON.parse(raw);
      frames.push(frame);
      if (frame.t === "welcome") welcomeSeen = true;
      if (frame.t === "close" || frame.t === "abort") {
        for (const socket of pairs.values()) socket.remoteClose();
        return;
      }
      const peer = pairs.get(this.role === "host" ? "guest" : "host")!;
      queueMicrotask(() => {
        if (frame.t === "welcome" && options.badWelcome) frame.ct = "AAAA";
        if (peer.readyState === 1)
          peer.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify(frame) }),
          );
        // Closing in this same task guarantees welcome processing has not completed.
        if (frame.t === "welcome" && options.immediateClose)
          for (const socket of pairs.values()) socket.remoteClose();
      });
    }
  }
  const fetcher: typeof fetch = async (_url, init = {}) => {
    if (String(_url).includes("/pow?"))
      return Response.json({
        challenge: b64url(new Uint8Array(16)),
        difficulty: 0,
        expiresAt: Date.now() + 120000,
        purpose: "pair",
        sig: "test",
      });
    if (init.method === "POST")
      return Response.json(
        { hostKey: "host", expiresAt: Date.now() + 600000 },
        { status: 201 },
      );
    if (init.method === "PUT") {
      snapshot = new Uint8Array(init.body as Uint8Array<ArrayBuffer>);
      return Response.json({ rev: ++rev });
    }
    return snapshot
      ? new Response(snapshot.slice().buffer as ArrayBuffer, {
          headers: { ETag: '"' + rev + '"' },
        })
      : new Response(null, { status: 204 });
  };
  const make = (role: "host" | "guest", source: MemorySecretStore) =>
    new KongjingSync({
      relayUrl: "https://relay.example",
      secrets: store(role, source),
      loadLocal: async () => ({}),
      saveMerged: async () => {},
      merge: (a) => a,
      fetch: (url, init) =>
        role === "guest" &&
        options.pullFailure &&
        String(url).endsWith("/snapshot")
          ? Promise.reject(new Error("snapshot temporarily unavailable"))
          : fetcher(url, init),
      WebSocket: class extends Socket {
        constructor(url: string) {
          super(role, new URL(url).pathname.startsWith("/v1/pair/"));
        }
      } as unknown as typeof WebSocket,
    });
  const inviter = make("host", hostStore),
    joiner = make("guest", guestStore);
  try {
    const invite = await inviter.invite(),
      peer = new Promise<Parameters<Parameters<InviteSession["onPeer"]>[0]>[0]>(
        (resolve) => invite.onPeer(resolve),
      );
    const join = await joiner.join(invite.code, "Joiner", "Node");
    const [i, j] = await Promise.all([peer, join.sas]);
    expect(i.sas).toBe(j.sas);
    return {
      inviter,
      joiner,
      invite,
      join,
      hostStore,
      guestStore,
      frames,
      pairs,
      saving,
      releaseSave,
      groupOpening,
      releaseGroup,
      async confirm(remoteFirst = false) {
        if (remoteFirst) {
          await join.confirm();
          await vi.waitFor(() =>
            expect(frames.some((f) => f.t === "confirm")).toBe(true),
          );
        }
        const confirmed = invite.confirm();
        if (!remoteFirst) await join.confirm();
        await confirmed;
      },
      async consistent() {
        expect(joiner.status()).toMatchObject({
          paired: true,
          connection: "online",
        });
        expect(inviter.status().paired).toBe(true);
        const a = await hostStore.get<{ members: Member[] }>("group"),
          b = await guestStore.get<{ members: Member[] }>("group");
        expect(a?.members).toEqual(b?.members);
        expect(a?.members).toHaveLength(2);
        expect(a?.members.map((m: Member) => m.name).sort()).toEqual([
          "Inviter",
          "Joiner",
        ]);
      },
      dispose() {
        releaseSave.resolve();
        releaseGroup.resolve();
        inviter.dispose();
        joiner.dispose();
      },
    };
  } catch (e) {
    releaseSave.resolve();
    releaseGroup.resolve();
    inviter.dispose();
    joiner.dispose();
    throw e;
  }
}

describe("store frozen protocol: v2.2.2 welcome close race", () => {
  for (const remoteFirst of [false, true])
    it(`finishes both sides when the relay closes immediately after welcome; remote-first=${remoteFirst}`, async () => {
      const f = await fixture({ immediateClose: true });
      try {
        await f.confirm(remoteFirst);
        await Promise.all([f.invite.done, f.join.done]);
        await f.consistent();
      } finally {
        f.dispose();
      }
    });
  for (const side of ["host", "guest"] as const)
    it(`ignores pair close while ${side} credential persistence is gated`, async () => {
      const f = await fixture({ slowStore: side });
      let hostDone = false,
        guestDone = false;
      void f.invite.done.then(
        () => (hostDone = true),
        () => {},
      );
      void f.join.done.then(
        () => (guestDone = true),
        () => {},
      );
      try {
        const confirming = f.confirm();
        await f.saving.promise;
        for (const socket of f.pairs.values()) socket.remoteClose();
        await Promise.resolve();
        await Promise.resolve();
        expect(side === "host" ? hostDone : guestDone).toBe(false);
        f.releaseSave.resolve();
        await confirming;
        await Promise.all([f.invite.done, f.join.done]);
        await f.consistent();
      } finally {
        f.dispose();
      }
    });
  it("does not resolve JoinSession.done before the first group WebSocket opens", async () => {
    const f = await fixture({ immediateClose: true, groupGate: true });
    let done = false;
    void f.join.done.then(
      () => (done = true),
      () => {},
    );
    try {
      await f.confirm();
      await f.groupOpening.promise;
      expect(done).toBe(false);
      expect(f.joiner.status().connection).toBe("connecting");
      f.releaseGroup.resolve();
      await Promise.all([f.invite.done, f.join.done]);
      await f.consistent();
    } finally {
      f.dispose();
    }
  });
  it.each(["badWelcome", "persistFailure", "groupFailure"] as const)(
    "still rejects done for a genuine %s failure after pair close",
    async (failure) => {
      const f = await fixture({ immediateClose: true, [failure]: true });
      try {
        const rejected = expect(f.join.done).rejects.toMatchObject({
          code: "NETWORK",
        });
        await f.confirm();
        await rejected;
        await f.invite.done;
        if (failure === "persistFailure")
          expect(await f.guestStore.get("group")).toBeUndefined();
      } finally {
        f.dispose();
      }
    },
  );
  it("reports a real inviter persistence failure after sending welcome", async () => {
    const f = await fixture({ immediateClose: true, hostPersistFailure: true });
    try {
      const rejected = expect(f.invite.done).rejects.toMatchObject({
        code: "NETWORK",
      });
      await f.confirm().catch(() => {});
      await rejected;
      await f.join.done;
      expect(
        (await f.hostStore.get<{ members: Member[] }>("group"))?.members,
      ).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });
  it("rejects a first group connection that stays pending for 30 seconds", async () => {
    const f = await fixture({ immediateClose: true, groupGate: true });
    vi.useFakeTimers();
    try {
      const rejected = expect(f.join.done).rejects.toMatchObject({
        code: "NETWORK",
      });
      await f.confirm();
      await f.groupOpening.promise;
      await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      await f.invite.done;
      expect(await f.guestStore.get("group")).toBeDefined();
    } finally {
      f.dispose();
      vi.useRealTimers();
    }
  });
  it("leaves subsequent snapshot synchronization to normal group sync after adopting credentials", async () => {
    const f = await fixture({ immediateClose: true, pullFailure: true });
    try {
      await f.confirm();
      await Promise.all([f.invite.done, f.join.done]);
      await f.consistent();
    } finally {
      f.dispose();
    }
  });
  it("still rejects a pair close before welcome", async () => {
    const f = await fixture();
    try {
      const rejected = expect(f.join.done).rejects.toMatchObject({
        code: "NETWORK",
      });
      f.pairs.get("guest")!.remoteClose();
      await rejected;
      expect(f.joiner.status().paired).toBe(false);
    } finally {
      f.dispose();
    }
  });
});
