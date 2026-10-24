import {
  createSync,
  IndexedDBQueueStore,
  type KongjingSync,
} from "@kongjing/protocol";
import type { AppData } from "../../lib/model";
import { STORE } from "../../lib/build";
import { initialStatus, type SyncOptions } from "./types";

export const edgeDefault = "https://sync.example.com";
export const legacyDefault = "https://kongjing.inc.re";
export interface SyncPreferences {
  backend: "cloudflare" | "edge";
  url: string;
  directOnly: boolean;
  turnUrl: string;
  turnUser: string;
  turnCredential: string;
}
export const syncDefaults = (): SyncPreferences => ({
  backend: "cloudflare",
  url: legacyDefault,
  directOnly: false,
  turnUrl: "",
  turnUser: "",
  turnCredential: "",
});
export type ManagedClient = KongjingSync<AppData> & {
  configure(prefs: Partial<SyncPreferences>): Promise<void>;
  preferences(): SyncPreferences;
  setForeground(value: boolean): void;
  retryJoin(): Promise<void>;
};

/** Stable subscriptions survive local transport/TURN changes. Secrets never enter AppData. */
export function createEngine(options: SyncOptions<AppData>): ManagedClient {
  let raw: ReturnType<typeof createSync<AppData>> | undefined;
  let prefs = syncDefaults();
  let foreground = true;
  const subscriptions = new Set<{
    key: string;
    args: unknown[];
    off?: () => void;
  }>();
  const subscribe = (key: string, args: unknown[]) => {
    const item: { key: string; args: unknown[]; off?: () => void } = {
      key,
      args,
    };
    subscriptions.add(item);
    if (raw) item.off = Reflect.apply(Reflect.get(raw, key), raw, args);
    return () => {
      item.off?.();
      subscriptions.delete(item);
    };
  };
  const open = async () => {
    raw = createSync({
      ...options,
      relayUrl: prefs.url,
      secrets: {
        get: async <T>(key: string) => key === "relayUrl" ? prefs.url as T : options.secrets.get<T>(key),
        set: (key: string, value: unknown) => options.secrets.set(key, value),
        delete: (key: string) => options.secrets.delete(key),
      },
      transport: prefs.backend,
      disablePeer: STORE,
      queueStore: new IndexedDBQueueStore("kongjing-edge-queue"),
      directOnly: prefs.directOnly,
      turn: prefs.turnUrl
        ? [
            {
              urls: prefs.turnUrl,
              username: prefs.turnUser,
              credential: prefs.turnCredential,
            },
          ]
        : [],
      // v3.1 pauses an invisible Android host; a desktop offscreen host keeps background polling.
      clientPlatform: options.host,
    });
    for (const s of subscriptions)
      s.off = Reflect.apply(Reflect.get(raw, s.key), raw, s.args);
    (
      raw as unknown as { setForeground?: (v: boolean) => void }
    ).setForeground?.(foreground);
    await raw.init();
  };
  const special = {
    status: () => raw?.status() || initialStatus(),
    async init() {
      const saved = await options.secrets.get<Partial<SyncPreferences>>("app.sync-v3");
      const previous = await options.secrets.get<string>("relayUrl");
      const url = saved?.url || previous || options.relayUrl || legacyDefault;
      prefs = {
        ...syncDefaults(),
        ...saved,
        url,
        backend: saved?.backend || (!saved?.url || url === legacyDefault || /:8790$/.test(url) ? "cloudflare" : "edge"),
      };
      await open();
    },
    preferences: () => ({ ...prefs }),
    setForeground(value: boolean) {
      foreground = value;
      (
        raw as unknown as { setForeground?: (v: boolean) => void }
      )?.setForeground?.(value);
    },
    async configure(next: Partial<SyncPreferences>) {
      const updated = { ...prefs, ...next };
      const url = new URL(updated.url);
      if (
        !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
        url.username ||
        url.password
      )
        throw Error("BAD_REQUEST");
      updated.url = url.origin;
      if (!["cloudflare", "edge"].includes(updated.backend)) throw Error("BAD_REQUEST");
      if (
        updated.directOnly &&
        updated.backend === "cloudflare"
      )
        throw Error("BAD_REQUEST");
      if (updated.turnUrl && !/^turns?:[^\s]+$/.test(updated.turnUrl))
        throw Error("BAD_REQUEST");
      if ((raw?.status().paired || raw?.status().joinPhase) && (updated.url !== prefs.url || updated.backend !== prefs.backend))
        throw Object.assign(Error(), { code: "RELAY_CHANGE_REQUIRES_REPAIR" });
      const reconnect =
        updated.backend !== prefs.backend ||
        updated.url !== prefs.url ||
        updated.turnUrl !== prefs.turnUrl ||
        updated.turnUser !== prefs.turnUser ||
        updated.turnCredential !== prefs.turnCredential;
      await options.secrets.set("app.sync-v3", updated);
      prefs = updated;
      if (reconnect) {
        raw?.dispose();
        for (const s of subscriptions) s.off?.();
        await open();
      } else if (raw && "setDirectOnly" in raw)
        await raw.setDirectOnly(prefs.directOnly);
    },
  };
  return new Proxy(special, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (["on", "onJournal", "onSlots", "onIncoming"].includes(String(key)))
        return (...args: unknown[]) => subscribe(String(key), args);
      const value = raw && Reflect.get(raw, key);
      if (!raw)
        return (...args: unknown[]) => {
          if (!raw) throw Error("同步正在初始化");
          return Reflect.apply(Reflect.get(raw, key), raw, args);
        };
      return typeof value === "function" ? value.bind(raw) : value;
    },
  }) as unknown as ManagedClient;
}
