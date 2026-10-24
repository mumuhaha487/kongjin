import { storage, imageFile } from "../../lib/storage";
import type { AppData } from "../../lib/model";
import { ANDROID } from "../../lib/build";
import { nativeCall } from "../../platform/native";
import { normalizeUrl } from "../../lib/validation";
import { ContinuityDB } from "./database";
import { filterVisits, safeSlot } from "./privacy";
import {
  continuityDefaults,
  otherDevices,
  type ContinuityClient,
  type ContinuityOptions,
  type ContinuityState,
  type HistoryQuery,
  type Incoming,
  type RawVisit,
  type Slot,
  type Visit,
} from "./types";

export interface ImageReference {
  blobId: string;
  mime: string;
  size: number;
  w: number;
  h: number;
}
export type ExtendedSettings = AppData["settings"] & {
  backgroundImage?: ImageReference;
};
export class ContinuityService {
  readonly db = new ContinuityDB();
  options = { ...continuityDefaults };
  available = false;
  private gap = false;
  private error?: string;
  private records = Promise.resolve();
  private imageWork = Promise.resolve();
  private currentImage?: string;
  private listeners = new Set<(s: ContinuityState) => void>();
  private collect?: (
    key: "history" | "tabs" | "incoming",
    enabled: boolean,
  ) => Promise<boolean>;
  notifyIncoming?: (i: Incoming) => Promise<void>;
  rebuildMenus?: () => void;
  constructor(
    readonly client: ContinuityClient,
    private load: () => Promise<AppData>,
    private save: (d: AppData) => Promise<void>,
  ) {}
  self() {
    return this.client.status().devices.find((d) => d.self)?.deviceId || "";
  }
  async init() {
    this.options = {
      ...continuityDefaults,
      ...(await storage.get<ContinuityOptions>("continuity-options")),
    };
    this.available = typeof this.client.journalAppend === "function";
    await this.db.clean(this.options.retentionDays);
    this.client.on("status", () => {
      void this.publish();
      void this.reconcileImage();
    });
    if (this.available) {
      this.client.onJournal((records, info) => {
        const task = this.records.then(async () => {
          if (info.replay && !records.length) this.gap = true;
          for (const record of records) {
            await this.db.apply(record, this.self());
            if (record.t === "snd" && record.to === this.self())
              await this.incoming({
                id: record.id,
                from: record.dev,
                at: record.at,
                k: String(record.k),
                u: record.u as string,
                ti: record.ti as string,
                tx: record.tx as string,
              });
          }
          const searches = await this.db.all<{ s: string; at: number }>(
            "search",
          );
          if (records.some((r) => r.t === "sh" || r.t === "sd"))
            await storage.set(
              "history",
              [
                ...new Set(
                  searches.sort((a, b) => b.at - a.at).map((q) => q.s),
                ),
              ].slice(0, 50),
            );
          await this.db.clean(this.options.retentionDays);
          await this.publish();
        });
        this.records = task.catch((e) => {
          this.error = String(e);
          void this.publish();
        });
        return task;
      });
      this.client.onSlots((slots) => {
        void this.db.setSlots(slots).then(() => this.publish());
      });
      this.client.onIncoming((item) => {
        this.records = this.records
          .then(() => this.incoming(item))
          .catch((e) => {
            this.error = String(e);
            void this.publish();
          });
      });
    }
    storage.subscribe((key) => {
      if (key === "data") void this.reconcileImage();
    });
    if (ANDROID)
      this.notifyIncoming = async (item) => {
        nativeCall(
          "incoming",
          JSON.stringify({ ...item, from: this.deviceName(item.from) }),
        );
      };
    await this.publish();
  }
  setCollector(fn: NonNullable<ContinuityService["collect"]>) {
    this.collect = fn;
  }
  deviceName(id: string) {
    return (
      this.client.status().devices.find((d) => d.deviceId === id)?.name || id
    );
  }
  async state(): Promise<ContinuityState> {
    return {
      options: this.options,
      slots: await this.db.all<Slot>("slots"),
      inbox: (await this.db.all<Incoming>("inbox")).sort((a, b) => b.at - a.at),
      status: this.client.status(),
      available: this.available,
      historyGap: this.gap,
      localUrls: (await this.db.get<string[]>("meta", "local-urls")) || [],
      error: this.error,
    };
  }
  subscribe(fn: (s: ContinuityState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async publish() {
    const state = await this.state();
    this.listeners.forEach((fn) => fn(state));
    return state;
  }
  private requireClient() {
    if (!this.available) throw Error("接力协议尚未就绪");
    if (!this.self()) throw Error("请先配对设备");
  }
  async setOption(key: keyof ContinuityOptions, value: unknown) {
    if (!(key in continuityDefaults)) throw Error("INVALID_ARGS");
    if (
      (key === "retentionDays" && value !== 30 && value !== 90) ||
      (key === "excluded" &&
        (!Array.isArray(value) ||
          !value.every((v) => typeof v === "string"))) ||
      (key !== "retentionDays" &&
        key !== "excluded" &&
        typeof value !== "boolean")
    )
      throw Error("INVALID_ARGS");
    if (value && ["history", "tabs", "incoming"].includes(key)) {
      if (
        this.collect &&
        !(await this.collect(key as "history" | "tabs" | "incoming", true))
      )
        return { granted: false };
      if (
        ANDROID &&
        key === "incoming" &&
        nativeCall("requestNotificationPermission") === "denied"
      )
        return { granted: false };
    }
    this.options = { ...this.options, [key]: value };
    await storage.set("continuity-options", this.options);
    if (!value && ["history", "tabs", "incoming"].includes(key))
      await this.collect?.(key as "history" | "tabs" | "incoming", false);
    if (key === "tabs" && !value && this.available && this.self())
      await this.client.deleteSlot();
    if (key === "retentionDays") {
      await this.db.clean(Number(value));
      if (this.available && this.self())
        this.client.journalAppend("cfg", { retentionDays: value });
    }
    await this.publish();
    if (key === "background" && value) await this.reconcileImage();
    if ((key === "profile" || key === "background") && value)
      await this.save(await this.load());
    return { granted: true };
  }
  async recordVisits(visits: RawVisit[], flush = false) {
    if (!this.options.history || !this.self()) return {};
    this.requireClient();
    const allowed = filterVisits(
        visits,
        this.options.excluded,
        Date.now(),
        this.options.retentionDays,
      ),
      added = await this.db.visits(this.self(), allowed);
    for (let i = 0; i < added.length; i += 200)
      this.client.journalAppend("hv", {
        v: added.slice(i, i + 200).map(({ u, ti, at }) => ({ u, ti, at })),
      });
    await this.publish();
    // Desktop title lookups already batch for four seconds. Drain that batch
    // through the public API so the journal's extra 10s wait cannot exceed 15s.
    // Offline failures leave the encrypted journal queued for the normal retry.
    if (flush && added.length) void this.client.syncNow?.().catch(() => {});
    return {};
  }
  async setOpenTabs(payload: Slot["payload"]) {
    const safe = {
      ...safeSlot(payload, this.options.excluded),
      dev: this.self(),
      at: Date.now(),
    };
    await this.db.put(
      "meta",
      "local-urls",
      safe.windows.flatMap((w) => w.tabs.map((t) => t.u)),
    );
    if (!this.options.tabs || !this.self()) {
      await this.publish();
      return {};
    }
    this.requireClient();
    await this.client.putSlot(safe);
    await this.db.put("meta", "own-slot", safe);
    await this.publish();
    return {};
  }
  async searchHistory(query: string, limit = 6) {
    if (!query.trim()) return [];
    const page = await this.db.query(
      { query, limit, others: true },
      this.self(),
    );
    return page.items.map(({ u, ti, dev, at }) => ({
      u,
      ti,
      dev,
      at,
      devName: this.deviceName(dev),
    }));
  }
  async search(s: string) {
    if (!this.options.search || !this.self()) return;
    this.requireClient();
    const at = Date.now();
    await this.db.put("search", this.self() + "|" + at + "|" + s, {
      s,
      at,
      dev: this.self(),
    });
    this.client.journalAppend("sh", { q: [{ s, at }] });
  }
  async clearSearch() {
    if (this.options.search && this.available && this.self()) {
      const record = {
        id: this.client.journalAppend("sd", { all: true }),
        seq: 0,
        t: "sd",
        dev: this.self(),
        at: Date.now(),
        all: true,
      };
      await this.db.apply(record, this.self());
    }
  }
  async send(
    deviceId: string,
    item: { k: "url" | "text"; u?: string; ti?: string; tx?: string },
  ) {
    this.requireClient();
    if (
      !otherDevices(this.client.status()).some((d) => d.deviceId === deviceId)
    )
      throw Error("设备不可用");
    if (item.k === "url") {
      const u = normalizeUrl(item.u || "");
      if (!u) throw Error("INVALID_URL");
      item = { k: "url", u, ti: String(item.ti || u).slice(0, 2000) };
    } else if (
      item.k === "text" &&
      typeof item.tx === "string" &&
      item.tx.length <= 4000
    )
      item = { k: "text", tx: item.tx };
    else throw Error("INVALID_ARGS");
    return { id: this.client.sendTo(deviceId, item) };
  }
  async incoming(item: Incoming) {
    if (item.at < Date.now() - 7 * 86400000) return;
    if (await this.db.get("meta", "dismissed:" + item.id)) return;
    await this.db.storeIncoming(item);
    if (
      this.options.incoming &&
      !(await this.db.get("meta", "notified:" + item.id))
    ) {
      await this.db.put("meta", "notified:" + item.id, true);
      try {
        await this.notifyIncoming?.(item);
      } catch (error) {
        this.error = String(error);
      }
    }
    await this.db.clean(this.options.retentionDays);
    await this.publish();
  }
  async read(id: string) {
    if (await this.db.markRead(id)) {
      if (this.available && this.self()) this.client.ack(id);
    }
    await this.publish();
  }
  async deleteHistory(args: {
    ids?: string[];
    range?: { from: number; to: number };
    scope: "self" | "all";
  }) {
    this.requireClient();
    const at = Date.now(),
      id = this.client.journalAppend("hd", args);
    const removed = await this.db.deleteVisits({
      ...args,
      id,
      dev: this.self(),
      at,
    });
    await this.publish();
    return removed;
  }
  async historyRemoved(urls?: string[]) {
    if (!this.options.history || !this.available || !this.self()) return;
    const own = (await this.db.all<Visit>("visits")).filter(
      (v) => v.dev === this.self() && (!urls || urls.includes(v.u)),
    );
    if (own.length)
      await this.deleteHistory({ ids: own.map((v) => v.id), scope: "self" });
  }
  async reconcileImage() {
    this.imageWork = this.imageWork
      .then(async () => {
        if (!this.options.background || !this.available || !this.self()) return;
        const data = await this.load(),
          reference = (data.settings as ExtendedSettings).backgroundImage;
        if (!reference) {
          if (
            data.settings.background === "image" &&
            data.settings.imageUrl === "local"
          ) {
            const blob = await imageFile();
            if (blob) {
              const bitmap = await createImageBitmap(blob);
              try {
                await this.uploadBackground(blob, bitmap.width, bitmap.height);
              } finally {
                bitmap.close();
              }
            }
          }
          return;
        }
        if (this.currentImage === reference.blobId) return;
        const cached = await this.db.get<Blob>("blobs", reference.blobId);
        const received = cached ? undefined : await this.client.getBlob(reference.blobId) as unknown as Uint8Array | { bytes: Uint8Array };
        const blob = cached || new Blob([new Uint8Array(received && "bytes" in received ? received.bytes : received as Uint8Array)], { type: reference.mime });
        await this.db.put("blobs", reference.blobId, blob);
        await imageFile(blob);
        this.currentImage = reference.blobId;
        await storage.set("background-revision", reference.blobId);
      })
      .catch((e) => {
        this.error = String(e);
        void this.publish();
      });
    return this.imageWork;
  }
  async uploadBackground(blob: Blob, w: number, h: number) {
    if (!this.options.background || !this.self()) return;
    this.requireClient();
    if (blob.size > 3 * 1024 * 1024 - 1024) throw Error("背景图片需小于 3 MB");
    const old = ((await this.load()).settings as ExtendedSettings)
      .backgroundImage;
    const uploaded = await this.client.putBlob(
        new Uint8Array(await blob.arrayBuffer()),
        blob.type,
      ) as unknown as string | { blobId: string; size: number };
    const ref = {
      ...(typeof uploaded === "string" ? { blobId: uploaded, size: blob.size } : uploaded),
      mime: blob.type,
      w,
      h,
    };
    await this.db.put("blobs", ref.blobId, blob);
    this.currentImage = ref.blobId;
    const data = structuredClone(await this.load());
    Object.assign(data.settings, {
      backgroundImage: ref,
      background: "image",
      imageUrl: "local",
      updatedAt: Date.now(),
    });
    await this.save(data);
    if (old && old.blobId !== ref.blobId)
      await this.client.deleteBlob(old.blobId);
    return ref;
  }
  async execute(
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (action === "state") return this.publish();
    if (action === "option")
      return this.setOption(args.key as keyof ContinuityOptions, args.value);
    if (action === "history") {
      await this.db.clean(this.options.retentionDays);
      return this.db.query(args as HistoryQuery, this.self());
    }
    if (action === "recordVisits")
      return this.recordVisits(args.visits as RawVisit[]);
    if (action === "setOpenTabs")
      return this.setOpenTabs(args as unknown as Slot["payload"]);
    if (action === "getDevices")
      return otherDevices(this.client.status()).map(
        ({ deviceId, name, platform, online }) => ({
          deviceId,
          name,
          platform,
          online,
        }),
      );
    if (action === "sendToDevice")
      return this.send(String(args.deviceId), {
        k: args.k === "text" ? "text" : "url",
        u: String(args.url || ""),
        ti: String(args.title || ""),
        tx: args.text as string,
      });
    if (action === "searchHistory")
      return this.searchHistory(
        String(args.query || ""),
        args.limit as number | undefined,
      );
    if (action === "pendingIncoming")
      return (await this.state()).inbox
        .filter((i) => !i.read)
        .map(({ id, from, u, ti, at }) => ({ id, from, u, ti, at }));
    if (action === "read") return this.read(String(args.id));
    if (action === "markIncomingRead") {
      if (
        !Array.isArray(args.ids) ||
        !args.ids.every((id) => typeof id === "string")
      )
        throw Error("INVALID_ARGS");
      for (const id of args.ids) await this.read(id);
      return {};
    }
    if (action === "dismiss") {
      await this.read(String(args.id));
      await this.db.put("meta", "dismissed:" + String(args.id), true);
      await this.db.remove("inbox", String(args.id));
      return this.publish();
    }
    if (action === "delete")
      return this.deleteHistory(
        args as unknown as Parameters<ContinuityService["deleteHistory"]>[0],
      );
    if (action === "deleteBackground") {
      if (this.available && this.self())
        await this.client.deleteBlob(String(args.blobId));
      await this.db.remove("blobs", String(args.blobId));
      this.currentImage = undefined;
      return;
    }
    if (action === "search") return this.search(String(args.query));
    if (action === "clearSearch") return this.clearSearch();
    if (action === "background") {
      const bytes = Uint8Array.from(atob(String(args.base64)), (c) =>
        c.charCodeAt(0),
      );
      return this.uploadBackground(
        new Blob([bytes], { type: String(args.mime) }),
        Number(args.w),
        Number(args.h),
      );
    }
    throw Error("UNKNOWN_METHOD");
  }
}
let host: ContinuityService | undefined;
export function continuityHost() {
  if (!host) throw Error("接力正在初始化");
  return host;
}
export async function attachContinuity(
  client: ContinuityClient,
  load: () => Promise<AppData>,
  save: (d: AppData) => Promise<void>,
) {
  host = new ContinuityService(client, load, save);
  await host.init();
  return host;
}
