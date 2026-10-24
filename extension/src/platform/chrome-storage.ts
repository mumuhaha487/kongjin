import type { StorageAdapter } from "../lib/storage";
/** Runtime transport success is not a durable-storage success. */
export function offscreenStorage(): StorageAdapter {
  async function request(action: string, key: string, value?: unknown) {
    const reply = await chrome.runtime.sendMessage({
      type: "kj:host-storage", action, key, value,
    });
    if (!reply || reply.error) throw Error(reply?.error || "STORAGE_UNAVAILABLE");
    return reply;
  }
  return {
    async get<T>(key: string) { return (await request("get", key)).value as T | undefined; },
    async set(key, value) { await request("set", key, value); },
    async remove(key) { await request("remove", key); },
    subscribe(fn) {
      const listener = (m: { type: string; key: string; value: unknown }) => {
        if (m.type === "kj:host-storage-changed") fn(m.key, m.value);
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
  };
}
// Keep the desktop adapter outside the dynamically imported storage namespace,
// so Android builds can remove the entire Chrome-only module.
export function chromeStorage(): StorageAdapter {
  return {
    async get<T>(key: string) { return (await chrome.storage.local.get(key))[key] as T | undefined; },
    async set(key, value) { await chrome.storage.local.set({ [key]: value }); },
    async remove(key) { await chrome.storage.local.remove(key); },
    subscribe(fn) {
      const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if(area === "local") for(const [key, value] of Object.entries(changes)) fn(key, value.newValue);
      };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
  };
}
