// Test/screenshot build alias only. Never imported by the production alias.
import {
  initialStatus,
  type SyncOptions,
  type SyncStatus,
  type Device,
  type InviteSession,
  type JoinSession,
} from "../types";
import type { Incoming, JournalRecord, Slot } from "../../continuity/types";
const device = (name: string, id: string, self = false): Device => ({
  deviceId: id,
  name,
  platform: name,
  online: true,
  self,
});
export class KongjingSync<D> {
  setForeground(_value: boolean) { /* QA-only */ }
  async setDirectOnly(_value: boolean) { /* QA-only */ }
  private journalListeners = new Set<
    (r: JournalRecord[], info: { replay: boolean }) => void
  >();
  private slotListeners = new Set<(s: Slot[]) => void>();
  private incomingListeners = new Set<(i: Incoming) => void>();
  private slots: Slot[] = [];
  private cursor = 0;
  private state = initialStatus();
  private listeners = new Map<string, Set<(value: SyncStatus) => void>>();
  private scenario = "";
  constructor(private opts: SyncOptions<D>) {
    this.state.relayUrl = opts.relayUrl;
    try {
      const fixture = JSON.parse(localStorage.getItem("kj:mock") || "{}");
      this.scenario = fixture.scenario || "";
      if (fixture.paired)
        this.state = {
          ...this.state,
          paired: true,
          connection: "online",
          devices: [
            device(fixture.selfName || "Windows · Chrome", "a", true),
            device("MacBook · Chrome", "b"),
            device("iPhone · Edge", "c"),
            ...(fixture.extraDevices || []).map((name: string, i: number) => ({
              ...device(name, "extra" + i),
              platform: name.includes("空境") ? "Android" : name,
            })),
          ],
          lastSyncAt: Date.now(),
          epoch: 1,
        };
    } catch {
      /* SW test */
    }
  }
  async init() {
    try {
      const fixture = JSON.parse(
        localStorage.getItem("kj:continuity-fixture") || "{}",
      );
      this.slots = fixture.slots || [];
      this.slotListeners.forEach((cb) => cb(this.slots));
      this.journalListeners.forEach((cb) =>
        cb(fixture.records || [], { replay: false }),
      );
      for (const item of fixture.inbox || [])
        this.incomingListeners.forEach((cb) => cb(item));
    } catch {
      /* QA only */
    }
  }
  journalAppend(t: string, payload: object) {
    const id = crypto.randomUUID(),
      record = {
        id,
        seq: ++this.cursor,
        t,
        dev: this.state.devices.find((d) => d.self)?.deviceId || "a",
        at: Date.now(),
        ...payload,
      };
    queueMicrotask(() =>
      this.journalListeners.forEach((cb) => cb([record], { replay: false })),
    );
    return id;
  }
  onJournal(cb: (r: JournalRecord[], info: { replay: boolean }) => void) {
    this.journalListeners.add(cb);
    return () => this.journalListeners.delete(cb);
  }
  journalCursor() {
    return this.cursor;
  }
  async putSlot(payload: Slot["payload"]) {
    const dev = this.state.devices.find((d) => d.self)?.deviceId || "a";
    this.slots = [
      ...this.slots.filter((s) => s.dev !== dev),
      { dev, at: Date.now(), payload },
    ];
    this.slotListeners.forEach((cb) => cb(this.slots));
  }
  async getSlots() {
    return this.slots;
  }
  onSlots(cb: (s: Slot[]) => void) {
    this.slotListeners.add(cb);
    return () => this.slotListeners.delete(cb);
  }
  async deleteSlot() {
    const self = this.state.devices.find((d) => d.self)?.deviceId;
    this.slots = this.slots.filter((s) => s.dev !== self);
    this.slotListeners.forEach((cb) => cb(this.slots));
  }
  async putBlob(bytes: Uint8Array, _mime: string) {
    const blobId = crypto.randomUUID();
    const blobs = JSON.parse(localStorage.getItem("kj:qa-blobs") || "{}");
    blobs[blobId] = [...bytes];
    localStorage.setItem("kj:qa-blobs", JSON.stringify(blobs));
    return { blobId, size: bytes.length };
  }
  async getBlob(id: string) {
    return new Uint8Array(
      JSON.parse(localStorage.getItem("kj:qa-blobs") || "{}")[id] || [],
    );
  }
  async deleteBlob(id: string) {
    const blobs = JSON.parse(localStorage.getItem("kj:qa-blobs") || "{}");
    delete blobs[id];
    localStorage.setItem("kj:qa-blobs", JSON.stringify(blobs));
  }
  sendTo(to: string, item: object) {
    return this.journalAppend("snd", { to, ...item });
  }
  onIncoming(cb: (i: Incoming) => void) {
    this.incomingListeners.add(cb);
    return () => this.incomingListeners.delete(cb);
  }
  ack(ref: string) {
    this.journalAppend("ack", { ref });
  }
  status() {
    return this.state;
  }
  on(ev: string, cb: (s: SyncStatus) => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(cb);
    return () => this.listeners.get(ev)?.delete(cb);
  }
  private emit() {
    this.listeners.get("status")?.forEach((cb) => cb(this.state));
  }
  async createGroup(name: string, _platform: string) {
    await new Promise((r) => setTimeout(r, 500));
    if (this.scenario === "failure") throw { code: "NETWORK" };
    this.state = {
      ...this.state,
      paired: true,
      connection: "online",
      epoch: 1,
      devices: [device(name, "a", true)],
    };
    this.emit();
  }
  async invite(): Promise<InviteSession> {
    let resolve!: (d: Device) => void;
    const done = new Promise<Device>((r) => (resolve = r));
    const peer = device("MacBook · Chrome", "b");
    return {
      code: "8F3QZT7M2C",
      expiresAt: Date.now() + 600000,
      onPeer: (cb) => {
        if (this.scenario === "sas" || this.scenario === "success")
          setTimeout(
            () =>
              cb({ name: peer.name, platform: peer.platform, sas: "482913" }),
            300,
          );
      },
      confirm: async () => {
        await new Promise((r) => setTimeout(r, 300));
        this.state.devices.push(peer);
        this.emit();
        resolve(peer);
      },
      cancel: () => {},
      done,
    };
  }
  async join(
    _code: string,
    name: string,
    _platform: string,
  ): Promise<JoinSession> {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    return {
      sas: Promise.resolve({ sas: "482913", inviterName: "MacBook · Chrome" }),
      confirm: async () => {
        this.state = {
          ...this.state,
          paired: true,
          connection: "online",
          devices: [device(name, "a", true), device("MacBook · Chrome", "b")],
          epoch: 1,
        };
        this.emit();
        resolve();
      },
      cancel: () => {},
      done,
    };
  }
  notifyLocalChange() {}
  async syncNow() {
    this.state.lastSyncAt = Date.now();
    this.emit();
  }
  async renameSelf(name: string) {
    this.state.devices[0].name = name;
    this.emit();
  }
  async removeDevice(id: string) {
    this.state.devices = this.state.devices.filter((d) => d.deviceId !== id);
    this.emit();
  }
  async leave() {
    this.state = initialStatus();
    this.emit();
  }
  async setRelayUrl(url: string) {
    if (this.state.paired) throw { code: "RELAY_CHANGE_REQUIRES_REPAIR" };
    this.state.relayUrl = url;
    this.emit();
  }
  dispose() {}
}
export const createSync = <D>(options: SyncOptions<D>) => new KongjingSync(options);
export class IndexedDBQueueStore {
  constructor(_name: string) {}
}
