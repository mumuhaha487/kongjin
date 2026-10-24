import { beforeEach, expect, it, vi } from "vitest";
import { defaults } from "../src/lib/model";
import { initialStatus } from "../src/features/pairing/types";
import { syncFooter } from "../src/features/pairing/status";
import { STORE } from "../src/lib/build";
const h = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], foreground: [] as boolean[], paired: false, events: new Map<string, (...v: unknown[]) => void>(), disposals: 0 }));
vi.mock("@kongjing/protocol", () => ({
  IndexedDBQueueStore: class {},
  createSync: (options: Record<string, unknown>) => {
    h.options.push(options);
    return {
      init: async () => {}, dispose: () => { h.disposals++; },
      status: () => ({ ...initialStatus(), paired: h.paired, relayUrl: options.relayUrl }),
      on: (event: string, callback: (...args: unknown[]) => void) => { h.events.set(event, callback); return () => h.events.delete(event); },
      setForeground: (v: boolean) => h.foreground.push(v),
      setDirectOnly: vi.fn(),
    };
  },
}));
import { createEngine, edgeDefault, legacyDefault } from "../src/features/pairing/engine";
beforeEach(() => { h.options = []; h.foreground = []; h.paired = false; h.events.clear(); h.disposals = 0; });
async function setup(seed?: unknown) {
  const values = new Map<string, unknown>(seed ? [["app.sync-v3", seed]] : [["relayUrl", legacyDefault]]);
  const secrets = { get: async <T>(key: string) => values.get(key) as T | undefined, set: async (key: string, value: unknown) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  const client = createEngine({ relayUrl: legacyDefault, secrets, loadLocal: async () => defaults(), saveMerged: async () => {}, merge: (a) => a, host: "android" });
  client.setForeground(false);
  await client.init();
  return { client, values };
}
it("existing v2 credentials keep the public Cloudflare default, preserve secrets, separate the queue, and send actual visibility before init", async () => {
  const { client, values } = await setup();
  expect(h.options[0].relayUrl).toBe(legacyDefault);
  expect(h.options[0].transport).toBe("cloudflare");
  expect(h.options[0].clientPlatform).toBe("android");
  expect(h.options[0].queueStore).not.toBe(h.options[0].secrets);
  expect(values.get("relayUrl")).toBe(legacyDefault);
  expect(h.foreground).toEqual([false]);
  client.setForeground(true);
  expect(h.foreground).toEqual([false, true]);
});
it("local TURN settings survive transport recreation and listeners remain attached", async () => {
  const { client, values } = await setup();
  const listener = vi.fn(); client.on("status", listener);
  await client.configure({ turnUrl: "turn:localhost:3478", turnUser: "test", turnCredential: "local-only" });
  expect(h.disposals).toBe(1);
  expect(h.options[1].turn).toEqual([{ urls: "turn:localhost:3478", username: "test", credential: "local-only" }]);
  h.events.get("status")?.(initialStatus()); expect(listener).toHaveBeenCalledOnce();
  expect(values.has("app.sync-v3")).toBe(true);
  await client.configure({ url: edgeDefault, backend: "edge" });
  expect(h.options[2].transport).toBe("edge");
});
it("paired server changes and malformed TURN origins are rejected without losing the group", async () => {
  const { client } = await setup(); h.paired = true;
  await expect(client.configure({ url: edgeDefault, backend: "edge" })).rejects.toMatchObject({ code: "RELAY_CHANGE_REQUIRES_REPAIR" });
  await expect(client.configure({ turnUrl: "https://not-turn" })).rejects.toThrow();
  expect(h.disposals).toBe(0);
});
it("v3 footer displays direct, relay and offline while store preserves its prior copy", () => {
  const base = { ...initialStatus(), paired: true, connection: "online" as const, lastSyncAt: Date.now() };
  expect(syncFooter({ ...base, transport: "direct" })).toBe(STORE ? "已连接 · 刚刚同步" : "直连 · 刚刚同步");
  expect(syncFooter({ ...base, transport: "relay" })).toBe(STORE ? "已连接 · 刚刚同步" : "中转 · 刚刚同步");
  if (!STORE) expect(syncFooter({ ...base, transport: "offline" })).toBe("离线");
});

it("custom Cloudflare origins use explicit selection and paired backend changes are rejected", async () => {
  const { client } = await setup({ url: "https://worker.example.com", backend: "cloudflare" });
  expect(h.options[0].transport).toBe("cloudflare");
  expect(await (h.options[0].secrets as {get(key:string):Promise<unknown>}).get("relayUrl")).toBe("https://worker.example.com");
  h.paired = true;
  await expect(client.configure({ backend: "edge" })).rejects.toMatchObject({ code: "RELAY_CHANGE_REQUIRES_REPAIR" });
});
it("saved EO installations retain their platform when upgrading old preferences", async () => {
  const { client } = await setup({ url: "https://sync.example.com" });
  expect(h.options[0].transport).toBe("edge");
  expect(client.preferences().backend).toBe("edge");
});
