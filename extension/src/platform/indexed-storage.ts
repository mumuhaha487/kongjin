import type { StorageAdapter } from "../lib/storage";
export function indexedStorage(databaseName = "kongjing-home"): StorageAdapter {
  const listeners = new Set<(key: string, value: unknown) => void>();
  const channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(databaseName);
  if (channel)
    channel.onmessage = ({ data }) =>
      listeners.forEach((fn) => fn(data.key, data.value));
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(databaseName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("values");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  async function run<T>(
    key: string,
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("values", mode),
        req = op(tx.objectStore("values"));
      let value: T;
      req.onsuccess = () => {
        value = req.result;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error || req.error);
      };
    });
  }
  return {
    get: <T>(key: string) =>
      run<T | undefined>(key, "readonly", (store) => store.get(key)),
    async set(key, value) {
      await run(key, "readwrite", (store) => store.put(value, key));
      channel?.postMessage({ key, value });
      // Same-page writes are managed by the store; only external changes notify.
    },
    async remove(key) {
      await run(key, "readwrite", (store) => store.delete(key));
      channel?.postMessage({ key });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
