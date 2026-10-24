import { defaults, type AppData } from "./model";
import { migrate } from "./migration";
import { ANDROID } from "./build";
import { indexedStorage } from "../platform/indexed-storage";
import { chromeStorage, offscreenStorage } from "../platform/chrome-storage";
export interface StorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  subscribe(fn: (key: string, value: unknown) => void): () => void;
}
export const extensionEnvironment = () =>
  !ANDROID && typeof chrome !== "undefined" && !!chrome.runtime?.id;
export function readMirror(): AppData {
  try {
    const d: unknown = JSON.parse(
      localStorage.getItem("kongjing:mirror") ||
        localStorage.getItem("shiguang:mirror") ||
        "null",
    );
    return migrate(d) || defaults();
  } catch {
    return defaults();
  }
}
export function mirror(data: AppData) {
  try {
    localStorage.setItem("kongjing:mirror", JSON.stringify(data));
  } catch {
    /* quota: chrome storage remains authoritative */
  }
}
export function createStorage(prefix = "shiguang:"): StorageAdapter {
  if (ANDROID)
    return indexedStorage(prefix === "shiguang:" ? "kongjing-home" : prefix);
  // Chrome offscreen documents expose runtime only. Never access storage APIs
  // there, and never serialize SecretStore CryptoKeys through runtime JSON.
  if (extensionEnvironment() && !chrome.storage?.local)
    return offscreenStorage();
  if (!ANDROID && extensionEnvironment()) return chromeStorage();
  return {
    async get<T>(key: string) {
      try {
        return (
          (JSON.parse(localStorage.getItem(prefix + key) || "null") as T) ||
          undefined
        );
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      localStorage.setItem(prefix + key, JSON.stringify(value));
    },
    async remove(key) {
      localStorage.removeItem(prefix + key);
    },
    subscribe(fn) {
      const listener = (e: StorageEvent) => {
        if (e.key?.startsWith(prefix)) {
          try {
            fn(
              e.key.slice(prefix.length),
              e.newValue ? JSON.parse(e.newValue) : undefined,
            );
          } catch {
            /* ignore unrelated invalid data */
          }
        }
      };
      window.addEventListener("storage", listener);
      return () => window.removeEventListener("storage", listener);
    },
  };
}
export function memoryStorage(): StorageAdapter {
  const m = new Map<string, unknown>(),
    listeners = new Set<(k: string, v: unknown) => void>();
  return {
    async get<T>(k: string) {
      return structuredClone(m.get(k)) as T | undefined;
    },
    async set(k, v) {
      m.set(k, structuredClone(v));
      listeners.forEach((fn) => fn(k, v));
    },
    async remove(k) {
      m.delete(k);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
export const storage = createStorage();
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("shiguang-images", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("images");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function imageFile(file?: Blob): Promise<Blob | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("images", file ? "readwrite" : "readonly");
    const r = file
      ? tx.objectStore("images").put(file, "background")
      : tx.objectStore("images").get("background");
    r.onsuccess = () => resolve(file || r.result);
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => d.close();
  });
}
export async function clearImage() {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("images", "readwrite");
    transaction.objectStore("images").delete("background");
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}
