import {
  ProtocolError,
  type SyncOptions,
  type SyncStatus,
  type SecretStore,
  type Member,
  type Device,
  type InviteSession,
  type JoinSession,
  type Envelope,
  type EnvelopePlain,
  type SnapshotPlain,
} from "./types.ts";
import {
  identity,
  random,
  b64url,
  unb64,
  hex,
  sha256,
  utf8,
  deriveGroup,
  sealSnapshot,
  openSnapshot,
  sealEnvelope,
  openEnvelope,
  normalizePairCode,
  formatPairCode,
  generatePairCode,
  pairKeys,
  hmac,
  verifyMac,
  pairSession,
  encrypt,
  decrypt,
  text,
  wrapKey,
  unwrapKey,
} from "./crypto.ts";
import { solvePowWorker } from "./pow.ts";
type Identity = Awaited<ReturnType<typeof identity>>;
type Group = {
  gk: string;
  epoch: number;
  members: Member[];
  rev: number;
  name: string;
  platform: string;
};
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function hasPairLabels(m: { name?: unknown; platform?: unknown }) {
  // Both hello frames use the original strings, without display normalization.
  return typeof m.name === "string" && typeof m.platform === "string";
}
function relayOrigin(url: string) {
  const u = new URL(url);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    !["https:", "http:"].includes(u.protocol)
  )
    throw new ProtocolError("BAD_REQUEST", "Invalid relay URL");
  if (
    u.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
    !/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)
  )
    throw new ProtocolError("BAD_REQUEST", "HTTPS required");
  return u.origin;
}
export class KongjingSync<D> {
  private ident!: Identity;
  private group?: Group;
  private keys?: Awaited<ReturnType<typeof deriveGroup>>;
  private ws?: WebSocket;
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  private state: SyncStatus;
  private fetcher: typeof fetch;
  private WS: typeof WebSocket;
  private stopped = false;
  private initialized = false;
  private reconnectAttempt = 0;
  private debounce?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private poll?: ReturnType<typeof setInterval>;
  private syncing?: Promise<void>;
  private syncAgain = false;
  private pendingLocal = false;
  private switching?: Promise<void>;
  private seen = new Map<string, number>();
  private greeted = new Set<string>();
  private pairCancels = new Set<() => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private wake = () => {
    if (!this.stopped && this.group) {
      if (!this.ws || this.ws.readyState === 3) this.connect();
      void this.syncNow().catch(() => {});
    }
  };
  private visible = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    )
      this.wake();
  };
  constructor(private opts: SyncOptions<D>) {
    this.state = {
      paired: false,
      connection: "offline",
      syncing: false,
      devices: [],
      relayUrl: relayOrigin(opts.relayUrl),
    };
    this.fetcher = opts.fetch ?? globalThis.fetch;
    this.WS = opts.WebSocket ?? globalThis.WebSocket;
  }
  private emit(ev: string, value?: unknown) {
    for (const cb of this.listeners.get(ev) ?? []) cb(value);
  }
  private update(extra: Partial<SyncStatus> = {}) {
    this.state = {
      ...this.state,
      ...extra,
      paired: !!this.group,
      epoch: this.group?.epoch,
      devices: (this.group?.members ?? []).map((m) => ({
        deviceId: m.deviceId,
        name: m.name,
        platform: m.platform,
        self: m.deviceId === this.ident?.deviceId,
        online:
          m.deviceId === this.ident?.deviceId
            ? this.state.connection === "online"
            : Date.now() - (this.seen.get(m.deviceId) ?? 0) < 90000,
        lastSeenAt: this.seen.get(m.deviceId),
      })),
    };
    this.emit("status", this.status());
  }
  status(): SyncStatus {
    return structuredClone(this.state);
  }
  on(ev: "status", cb: (s: SyncStatus) => void): () => void;
  on(ev: "removed", cb: () => void): () => void;
  on(ev: string, cb: (...args: any[]) => void) {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }
  private async persist() {
    if (this.group) await this.opts.secrets.set("group", this.group);
    else await this.opts.secrets.delete("group");
  }
  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.ident =
      (await this.opts.secrets.get<Identity>("identity")) ?? (await identity());
    await this.opts.secrets.set("identity", this.ident);
    const saved = await this.opts.secrets.get<string>("relayUrl");
    if (saved) this.state.relayUrl = relayOrigin(saved);
    this.group = await this.opts.secrets.get<Group>("group");
    if (this.group) {
      this.keys = await deriveGroup(unb64(this.group.gk), this.group.epoch);
      this.update();
      await this.pull().catch((e) => this.fail(e));
      if (this.group) this.connect();
    }
    globalThis.addEventListener?.("online", this.wake);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.visible);
    this.poll = setInterval(() => {
      if (this.group) void this.pull().catch((e) => this.fail(e));
    }, 300000);
    this.heartbeat = setInterval(() => {
      this.update();
      void this.send("presence", {
        name: this.group?.name,
        platform: this.group?.platform,
        online: true,
      });
    }, 60000);
  }
  private fail(e: unknown) {
    this.update({
      error:
        e instanceof ProtocolError
          ? e.code
          : e instanceof Error
            ? e.message
            : "NETWORK",
      syncing: false,
    });
  }
  private async request(path: string, init: RequestInit = {}, token?: string) {
    const headers = new Headers(init.headers);
    if (token) headers.set("X-KJ-Token", token);
    const r = await this.fetcher(this.state.relayUrl + path, {
      ...init,
      headers,
      credentials: "omit",
    });
    if (!r.ok && r.status !== 412) {
      let body: any;
      try {
        body = await r.json();
      } catch {}
      throw new ProtocolError(
        body?.error?.code ?? "NETWORK",
        body?.error?.message ?? `HTTP ${r.status}`,
        body?.retryAfter,
      );
    }
    return r;
  }
  private async createRoom(
    keys: NonNullable<typeof this.keys>,
    old?: NonNullable<typeof this.keys>,
  ) {
    const body: any = {
      room: keys.roomId,
      tokenHash: hex(await sha256(utf8(keys.roomToken))),
    };
    if (old) body.rotateFrom = old.roomId;
    else body.pow = await this.pow("group");
    await this.request(
      "/v1/groups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      old?.roomToken,
    );
  }
  private async pow(purpose: "group" | "pair") {
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await (await this.request("/v1/pow?purpose=" + purpose)).json();
      try {
        return await solvePowWorker(c, this.opts.powWorkerUrl);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "EXPIRED" || attempt === 2)
          throw error;
      }
    }
    throw new Error("EXPIRED");
  }
  async createGroup(selfName: string, platform: string) {
    await this.init();
    if (this.group) throw new ProtocolError("CONFLICT");
    const gk = random(32),
      keys = await deriveGroup(gk, 1),
      self: Member = {
        deviceId: this.ident.deviceId,
        pub: this.ident.pub,
        name: selfName,
        platform,
        joinedAt: Date.now(),
        addedBy: this.ident.deviceId,
      };
    await this.createRoom(keys);
    this.group = {
      gk: b64url(gk),
      epoch: 1,
      members: [self],
      rev: 0,
      name: selfName,
      platform,
    };
    this.keys = keys;
    await this.persist();
    this.update();
    await this.syncNow();
    this.connect();
  }
  private stopSocket() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState < 2) ws.close(1000);
    this.update({ connection: "offline" });
  }
  private connect() {
    if (
      this.stopped ||
      !this.group ||
      !this.keys ||
      (this.ws && this.ws.readyState < 2)
    )
      return;
    clearTimeout(this.reconnectTimer);
    this.update({ connection: "connecting" });
    let ws: WebSocket;
    try {
      ws = new this.WS(
        this.state.relayUrl.replace(/^http/, "ws") +
          "/v1/groups/" +
          this.keys.roomId +
          "/ws",
        ["kj.v1", "kjt." + this.keys.roomToken],
      );
    } catch (e) {
      this.fail(e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let chain = Promise.resolve();
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.update({ connection: "online", error: undefined });
      void this.send("presence", {
        name: this.group?.name,
        platform: this.group?.platform,
        online: true,
      });
      void this.pull().catch((e) => this.fail(e));
    });
    ws.addEventListener("message", (e) => {
      chain = chain
        .then(async () => {
          if (this.ws !== ws) return;
          const m = JSON.parse(String(e.data));
          if (m.type === "hello" || m.type === "snapshot") {
            if (this.group && (m.rev > this.group.rev || m.type === "hello"))
              await this.pull();
          } else if (m.type === "peers") this.greeted.clear();
          else if (m.type === "relay") await this.receive(m.env);
          else if (m.type === "retired") await this.follow();
        })
        .catch((e) => this.fail(e));
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.update({ connection: "offline" });
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      if (this.ws === ws) this.update({ error: "NETWORK" });
    });
  }
  private scheduleReconnect() {
    if (this.stopped || !this.group) return;
    const delay = Math.min(
      60000,
      1000 *
        2 ** Math.min(this.reconnectAttempt++, 6) *
        (0.8 + Math.random() * 0.4),
    );
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(this.wake, delay);
  }
  private async connectAfterWelcome() {
    this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState >= 2) throw new ProtocolError("NETWORK");
    if (ws.readyState === 1) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: ProtocolError) => {
        clearTimeout(timer);
        ws.removeEventListener("open", opened);
        ws.removeEventListener("close", failed);
        ws.removeEventListener("error", failed);
        error ? reject(error) : resolve();
      };
      const opened = () => finish();
      const failed = () => finish(new ProtocolError("NETWORK"));
      const timer = setTimeout(failed, 30000);
      ws.addEventListener("open", opened, { once: true });
      ws.addEventListener("close", failed, { once: true });
      ws.addEventListener("error", failed, { once: true });
    });
  }
  private async send(t: string, payload: Record<string, unknown> = {}) {
    if (!this.keys || !this.group || this.ws?.readyState !== 1) return;
    const env = await sealEnvelope(this.keys.encKey, this.keys.roomId, {
      t,
      from: this.ident.deviceId,
      at: Date.now(),
      ...payload,
    });
    if (this.ws?.readyState === 1)
      this.ws.send(JSON.stringify({ type: "relay", env }));
  }
  private acceptMembers(members: Member[], sender?: string) {
    if (!this.group || !Array.isArray(members)) return;
    if (sender && !this.group.members.some((m) => m.deviceId === sender))
      return;
    const known = new Map(this.group.members.map((m) => [m.deviceId, m.pub]));
    const valid = members.filter(
      (m) =>
        typeof m.deviceId === "string" &&
        typeof m.pub === "string" &&
        (!known.has(m.deviceId) || known.get(m.deviceId) === m.pub) &&
        (known.has(m.deviceId) || !!sender),
    );
    const combined = new Map(this.group.members.map((m) => [m.deviceId, m]));
    for (const m of valid) combined.set(m.deviceId, m);
    if (combined.size > 10) return;
    this.group.members = [...combined.values()];
    this.update();
  }
  private async receive(env: Envelope) {
    if (!this.keys || !this.group) return;
    const m = await openEnvelope(this.keys.encKey, this.keys.roomId, env);
    if (
      !this.group.members.some((x) => x.deviceId === m.from) ||
      !Number.isFinite(m.at)
    )
      return;
    if (m.t === "rotate") {
      await this.applyRotation(m);
      return;
    }
    if (m.t === "presence") {
      this.seen.set(m.from, m.online ? Date.now() : 0);
      this.update();
      // Reconnect catch-up: only an already trusted member can authenticate
      // new public keys. A snapshot by itself never expands that trust set.
      if (m.online && !this.greeted.has(m.from)) {
        this.greeted.add(m.from);
        await this.send("members", { members: this.group.members });
      }
    } else if (m.t === "members") {
      this.acceptMembers(m.members as Member[], m.from);
      await this.persist();
    } else if (m.t === "changed" && Number(m.rev) > this.group.rev)
      await this.pull();
    else if (m.t === "leave") {
      const others = this.group.members
        .filter((x) => x.deviceId !== m.from)
        .map((x) => x.deviceId)
        .sort();
      if (others[0] === this.ident.deviceId) {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          if (this.group?.members.some((x) => x.deviceId === m.from))
            void this.removeDevice(m.from).catch((e) => this.fail(e));
        }, 5000);
        this.timers.add(timer);
      }
    }
  }
  private async pull() {
    if (!this.group || !this.keys) return;
    const group = this.group,
      keys = this.keys;
    let r: Response;
    try {
      r = await this.request(
        "/v1/groups/" + keys.roomId + "/snapshot",
        {},
        keys.roomToken,
      );
    } catch (e) {
      if (e instanceof ProtocolError && e.code === "GONE") {
        await this.follow();
        return;
      }
      throw e;
    }
    if (this.group !== group || r.status === 204) return;
    const remote = await openSnapshot<D>(
      keys.encKey,
      keys.roomId,
      new Uint8Array(await r.arrayBuffer()),
    );
    if (
      remote.group.epoch !== group.epoch ||
      !group.members.some((m) => m.deviceId === remote.writer)
    )
      throw new ProtocolError("BAD_REQUEST", "Untrusted snapshot writer");
    if (this.group !== group) return;
    this.acceptMembers(remote.group.members);
    group.rev = Number(r.headers.get("ETag")?.replaceAll('"', "") ?? 0);
    await this.opts.saveMerged(
      this.opts.merge(await this.opts.loadLocal(), remote.data),
    );
    await this.persist();
    this.update({ lastSyncAt: Date.now(), error: undefined });
  }
  notifyLocalChange() {
    this.pendingLocal = true;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      void this.syncNow().catch(() => {});
    }, 800);
  }
  async syncNow(): Promise<void> {
    if (!this.group) return;
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = this.pushLoop();
    try {
      await this.syncing;
    } finally {
      this.syncing = undefined;
      if (this.syncAgain && !this.stopped) {
        this.syncAgain = false;
        await this.syncNow();
      }
    }
  }
  private async pushLoop() {
    if (!this.group || !this.keys) return;
    this.update({ syncing: true });
    this.pendingLocal = false;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const group: Group | undefined = this.group,
          keys = this.keys;
        if (!group || !keys) return;
        await this.pull();
        if (this.group !== group) continue;
        // Keep the CAS revision attached to the data we read. A concurrent WS
        // pull may advance group.rev while compression/encryption is awaiting.
        const baseRev = group.rev;
        const plain: SnapshotPlain<D> = {
          v: 1,
          writer: this.ident.deviceId,
          at: Date.now(),
          group: { epoch: group.epoch, members: group.members },
          data: await this.opts.loadLocal(),
        };
        const bytes = await sealSnapshot(keys.encKey, keys.roomId, plain);
        const r = await this.request(
          "/v1/groups/" + keys.roomId + "/snapshot",
          {
            method: "PUT",
            headers: {
              "If-Match": '"' + baseRev + '"',
              "Content-Type": "application/octet-stream",
            },
            body: bytes.slice().buffer as ArrayBuffer,
          },
          keys.roomToken,
        );
        if (r.status === 412) continue;
        group.rev = Math.max(group.rev, (await r.json()).rev);
        await this.persist();
        this.update({ lastSyncAt: Date.now(), error: undefined });
        await this.send("changed", { rev: group.rev });
        return;
      }
      throw new ProtocolError("PRECONDITION_FAILED");
    } catch (e) {
      this.fail(e);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        void this.syncNow().catch(() => {});
      }, 30000);
      throw e;
    } finally {
      this.update({ syncing: false });
    }
  }
  async renameSelf(name: string) {
    if (!this.group) throw new ProtocolError("CONFLICT");
    const m = this.group.members.find(
      (m) => m.deviceId === this.ident.deviceId,
    )!;
    m.name = name;
    this.group.name = name;
    await this.persist();
    await this.send("members", { members: this.group.members });
    await this.syncNow();
  }
  private async follow() {
    if (this.switching) return this.switching;
    this.switching = (async () => {
      if (!this.group || !this.keys) return;
      try {
        const r = await this.request(
          "/v1/groups/" + this.keys.roomId + "/forward",
          {},
          this.keys.roomToken,
        );
        const { env } = await r.json();
        await this.receive(env);
      } catch (e) {
        if (!(e instanceof ProtocolError && e.code === "NOT_FOUND")) throw e;
      }
    })();
    try {
      await this.switching;
    } finally {
      this.switching = undefined;
    }
  }
  private async applyRotation(m: EnvelopePlain) {
    if (
      !this.group ||
      !this.keys ||
      Number(m.newEpoch) !== this.group.epoch + 1
    )
      return;
    const sender = this.group.members.find((x) => x.deviceId === m.from);
    if (!sender) return;
    const wraps = m.wraps as Record<string, string>;
    if (!wraps?.[this.ident.deviceId]) {
      await this.clearGroup();
      this.emit("removed");
      return;
    }
    const plain = await unwrapKey(
      this.ident.privateKey,
      sender.pub,
      this.ident.deviceId,
      Number(m.newEpoch),
      wraps[this.ident.deviceId],
    );
    if (
      plain.epoch !== m.newEpoch ||
      !plain.members.some(
        (x: Member) =>
          x.deviceId === this.ident.deviceId && x.pub === this.ident.pub,
      )
    )
      throw new Error("Invalid rotation");
    for (const member of plain.members) {
      if (
        !this.group.members.some(
          (x) => x.deviceId === member.deviceId && x.pub === member.pub,
        )
      )
        throw new Error("Untrusted rotation member");
    }
    this.stopSocket();
    this.group = {
      ...this.group,
      gk: plain.gk,
      epoch: plain.epoch,
      members: plain.members,
      rev: 0,
    };
    this.keys = await deriveGroup(unb64(plain.gk), plain.epoch);
    await this.persist();
    this.update();
    this.connect();
    await this.pull();
  }
  async removeDevice(deviceId: string) {
    if (!this.group || !this.keys) throw new ProtocolError("CONFLICT");
    if (deviceId === this.ident.deviceId) return this.leave();
    await this.syncNow();
    const old = this.keys,
      group = this.group,
      gk = random(32),
      epoch = group.epoch + 1,
      members = group.members.filter((m) => m.deviceId !== deviceId);
    if (members.length === group.members.length) return;
    const next = await deriveGroup(gk, epoch),
      wraps: Record<string, string> = {};
    for (const m of members)
      if (m.deviceId !== this.ident.deviceId)
        wraps[m.deviceId] = await wrapKey(
          this.ident.privateKey,
          m.pub,
          m.deviceId,
          epoch,
          { gk: b64url(gk), epoch, members },
        );
    await this.createRoom(next, old);
    const snapshot = await sealSnapshot(next.encKey, next.roomId, {
      v: 1,
      writer: this.ident.deviceId,
      at: Date.now(),
      group: { epoch, members },
      data: await this.opts.loadLocal(),
    });
    await this.request(
      "/v1/groups/" + next.roomId + "/snapshot",
      {
        method: "PUT",
        headers: { "If-Match": '"0"' },
        body: snapshot.slice().buffer as ArrayBuffer,
      },
      next.roomToken,
    );
    const env = await sealEnvelope(old.encKey, old.roomId, {
      t: "rotate",
      from: this.ident.deviceId,
      at: Date.now(),
      newEpoch: epoch,
      wraps,
    });
    await this.request(
      "/v1/groups/" + old.roomId + "/forward",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env }),
      },
      old.roomToken,
    );
    if (this.ws?.readyState === 1)
      this.ws.send(JSON.stringify({ type: "relay", env }));
    await this.request(
      "/v1/groups/" + old.roomId,
      { method: "DELETE" },
      old.roomToken,
    );
    this.stopSocket();
    this.group = { ...group, gk: b64url(gk), epoch, members, rev: 1 };
    this.keys = next;
    await this.persist();
    this.update();
    this.connect();
  }
  private async clearGroup() {
    this.stopSocket();
    clearTimeout(this.debounce);
    clearTimeout(this.retryTimer);
    this.group = undefined;
    this.keys = undefined;
    this.seen.clear();
    await this.persist();
    this.update({ error: undefined });
  }
  async leave() {
    if (!this.group) return;
    await this.send("leave");
    await this.clearGroup();
  }
  async setRelayUrl(url: string) {
    if (this.group) throw new ProtocolError("RELAY_CHANGE_REQUIRES_REPAIR");
    this.state.relayUrl = relayOrigin(url);
    await this.opts.secrets.set("relayUrl", this.state.relayUrl);
    this.update();
  }
  dispose() {
    this.stopped = true;
    for (const cancel of this.pairCancels) cancel();
    this.stopSocket();
    clearTimeout(this.debounce);
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.poll);
    for (const timer of this.timers) clearTimeout(timer);
    globalThis.removeEventListener?.("online", this.wake);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.visible);
    this.listeners.clear();
  }
  async invite(): Promise<InviteSession> {
    await this.init();
    if (!this.group) throw new ProtocolError("CONFLICT");
    const code = generatePairCode(),
      { room, authKey } = await pairKeys(code);
    const { hostKey, expiresAt } = await (
      await this.request("/v1/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, pow: await this.pow("pair") }),
      })
    ).json();
    const ws = new this.WS(
      this.state.relayUrl.replace(/^http/, "ws") + "/v1/pair/" + room + "/ws",
      ["kj.v1", "kjh." + hostKey],
    );
    const done = deferred<Device>();
    let peerCb:
        | ((p: { name: string; platform: string; sas: string }) => void)
        | undefined,
      peerInfo: { name: string; platform: string; sas: string } | undefined,
      peer: Member | undefined,
      session: Awaited<ReturnType<typeof pairSession>> | undefined,
      localConfirmed = false,
      remoteConfirmed = false,
      finished = false,
      welcomeSent = false,
      sending = false;
    const cleanup = () => {
      clearTimeout(timer);
      this.pairCancels.delete(cancel);
    };
    const fail = (code: string) => {
      if (finished) return;
      finished = true;
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ t: "abort", reason: code }));
      ws.close();
      cleanup();
      done.reject(new ProtocolError(code));
    };
    const cancel = () => fail(session ? "SAS_MISMATCH" : "CANCELLED");
    this.pairCancels.add(cancel);
    const timer = setTimeout(
      () => fail("EXPIRED"),
      Math.max(0, expiresAt - Date.now()),
    );
    const welcome = async () => {
      if (
        !localConfirmed ||
        !remoteConfirmed ||
        !peer ||
        !session ||
        finished ||
        sending
      )
        return;
      sending = true;
      try {
        if (!this.group) throw new Error("Group left");
        const members = [...this.group.members, peer],
          plain = {
            gk: this.group.gk,
            epoch: this.group.epoch,
            members,
            relay: this.state.relayUrl,
          };
        const e = await encrypt(session.key, utf8(JSON.stringify(plain)));
        if (finished) return;
        ws.send(
          JSON.stringify({ t: "welcome", iv: b64url(e.iv), ct: b64url(e.ct) }),
        );
        welcomeSent = true;
        clearTimeout(timer);
        this.group.members = members;
        await this.persist();
        if (finished) return;
        await this.send("members", { members });
        await this.syncNow();
        if (finished) return;
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: "close" }));
        finished = true;
        cleanup();
        done.resolve({
          deviceId: peer.deviceId,
          name: peer.name,
          platform: peer.platform,
          self: false,
          online: true,
        });
        ws.close();
      } catch (e) {
        const error = e instanceof ProtocolError ? e : new ProtocolError("NETWORK");
        fail(error.code);
        throw error;
      }
    };
    let chain = Promise.resolve();
    ws.addEventListener("message", (event) => {
      chain = chain
        .then(async () => {
          if (finished) return;
          const m = JSON.parse(String(event.data));
          if (m.t === "hello-j") {
            if (peer || !hasPairLabels(m)) throw new ProtocolError("BAD_CODE");
            if (
              !(await verifyMac(
                authKey,
                "J|" + m.epk + "|" + m.id + "|" + m.name + "|" + m.platform,
                m.mac,
              ))
            )
              throw new ProtocolError("BAD_CODE");
            if ((this.group?.members.length ?? 10) >= 10)
              throw new ProtocolError("GROUP_FULL");
            const id = b64url(await sha256(unb64(m.id))).slice(0, 16);
            if (this.group!.members.some((x) => x.deviceId === id))
              throw new ProtocolError("BAD_CODE");
            peer = {
              deviceId: id,
              pub: m.id,
              name: m.name,
              platform: m.platform,
              joinedAt: Date.now(),
              addedBy: this.ident.deviceId,
            };
            const ephemeral = await identity();
            session = await pairSession(
              ephemeral.privateKey,
              m.epk,
              ephemeral.pub,
              m.epk,
              m.id,
            );
            const { name, platform } = this.group!;
            ws.send(
              JSON.stringify({
                t: "hello-i",
                epk: ephemeral.pub,
                name,
                platform,
                mac: await hmac(
                  authKey,
                  "I|" + ephemeral.pub + "|" + m.epk + "|" + name + "|" + platform,
                ),
              }),
            );
            peerInfo = { name: m.name, platform: m.platform, sas: session.sas };
            peerCb?.(peerInfo);
          } else if (m.t === "confirm") {
            if (!session) throw new ProtocolError("BAD_CODE");
            remoteConfirmed = true;
            await welcome();
          } else if (m.t === "abort") fail(m.reason);
        })
        .catch((e) => fail(e instanceof ProtocolError ? e.code : "NETWORK"));
    });
    ws.addEventListener("close", (e) => {
      void chain.then(() => {
        if (!finished && !welcomeSent) fail(e.code === 4404 ? "EXPIRED" : "NETWORK");
      });
    });
    ws.addEventListener("error", () => {
      void chain.then(() => {
        if (!welcomeSent) fail("NETWORK");
      });
    });
    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === 1) {
        resolve();
        return;
      }
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new ProtocolError("NETWORK")), {
        once: true,
      });
      ws.addEventListener("close", () => reject(new ProtocolError("NETWORK")), {
        once: true,
      });
    });
    return {
      code: formatPairCode(code),
      expiresAt,
      onPeer(cb) {
        peerCb = cb;
        if (peerInfo) cb(peerInfo);
      },
      confirm: async () => {
        if (!session) throw new ProtocolError("BAD_CODE");
        localConfirmed = true;
        await welcome();
      },
      cancel,
      done: done.promise,
    };
  }
  async join(
    input: string,
    selfName: string,
    platform: string,
  ): Promise<JoinSession> {
    await this.init();
    if (this.group) throw new ProtocolError("CONFLICT");
    const code = normalizePairCode(input);
    if (!code) throw new ProtocolError("BAD_CODE");
    const { room, authKey } = await pairKeys(code),
      ephemeral = await identity(),
      sas = deferred<Awaited<JoinSession["sas"]>>(),
      done = deferred<void>();
    const ws = new this.WS(
      this.state.relayUrl.replace(/^http/, "ws") + "/v1/pair/" + room + "/ws",
      ["kj.v1"],
    );
    let session: Awaited<ReturnType<typeof pairSession>> | undefined,
      confirmed = false,
      finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      this.pairCancels.delete(cancel);
    };
    const fail = (code: string) => {
      if (finished) return;
      finished = true;
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ t: "abort", reason: code }));
      ws.close();
      cleanup();
      sas.reject(new ProtocolError(code));
      done.reject(new ProtocolError(code));
    };
    const cancel = () => fail("CANCELLED");
    this.pairCancels.add(cancel);
    const timer = setTimeout(() => fail("EXPIRED"), 600000);
    ws.addEventListener("open", () => {
      void (async () => {
        const m = {
          t: "hello-j",
          epk: ephemeral.pub,
          id: this.ident.pub,
          name: selfName,
          platform,
          mac: await hmac(
            authKey,
            "J|" +
              ephemeral.pub +
              "|" +
              this.ident.pub +
              "|" +
              selfName +
              "|" +
              platform,
          ),
        };
        ws.send(JSON.stringify(m));
      })().catch(() => fail("NETWORK"));
    });
    let chain = Promise.resolve();
    ws.addEventListener("message", (event) => {
      chain = chain
        .then(async () => {
          if (finished) return;
          const m = JSON.parse(String(event.data));
          if (m.t === "hello-i") {
            if (
              session ||
              !hasPairLabels(m) ||
              !(await verifyMac(
                authKey,
                "I|" + m.epk + "|" + ephemeral.pub + "|" + m.name + "|" + m.platform,
                m.mac,
              ))
            )
              throw new ProtocolError("BAD_CODE");
            session = await pairSession(
              ephemeral.privateKey,
              m.epk,
              m.epk,
              ephemeral.pub,
              this.ident.pub,
            );
            sas.resolve({
              sas: session.sas,
              inviterName: m.name,
              platform: m.platform,
            });
          } else if (m.t === "welcome") {
            if (!session || !confirmed) throw new ProtocolError("SAS_MISMATCH");
            // The pair transport has finished its job. Complete credential adoption
            // before processing its close/error; decryption/storage errors still fail done.
            clearTimeout(timer);
            const p = JSON.parse(
              text(await decrypt(session.key, unb64(m.iv), unb64(m.ct))),
            );
            if (finished) return;
            if (
              p.relay !== this.state.relayUrl ||
              !Array.isArray(p.members) ||
              p.members.length > 10 ||
              !p.members.some(
                (x: Member) =>
                  x.deviceId === this.ident.deviceId &&
                  x.pub === this.ident.pub,
              )
            )
              throw new ProtocolError("BAD_CODE");
            this.group = {
              gk: p.gk,
              epoch: p.epoch,
              members: p.members,
              rev: 0,
              name: selfName,
              platform,
            };
            this.keys = await deriveGroup(unb64(p.gk), p.epoch);
            if (finished) return;
            await this.persist();
            if (finished) return;
            this.update();
            await this.connectAfterWelcome();
            if (finished) return;
            finished = true;
            cleanup();
            done.resolve();
          } else if (m.t === "abort") fail(m.reason);
        })
        .catch((e) => fail(e instanceof ProtocolError ? e.code : "NETWORK"));
    });
    ws.addEventListener("close", (e) => {
      void chain.then(() => {
        if (!finished) fail(e.code === 4404 ? "BAD_CODE" : "NETWORK");
      });
    });
    ws.addEventListener("error", () => {
      void chain.then(() => fail("NETWORK"));
    });
    return {
      sas: sas.promise,
      confirm: async () => {
        if (!session) throw new ProtocolError("BAD_CODE");
        confirmed = true;
        ws.send(JSON.stringify({ t: "confirm" }));
      },
      cancel,
      done: done.promise,
    };
  }
}
export class MemorySecretStore implements SecretStore {
  private values = new Map<string, unknown>();
  async get<T>(k: string) {
    return structuredClone(this.values.get(k)) as T | undefined;
  }
  async set(k: string, v: unknown) {
    this.values.set(k, structuredClone(v));
  }
  async delete(k: string) {
    this.values.delete(k);
  }
}
