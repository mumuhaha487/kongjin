import type { SecretStore } from "./types";
export class IndexedDBSecretStore implements SecretStore {
  private db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open("kj-secrets", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("secrets");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  private async run<T>(
    key: string,
    mode: IDBTransactionMode,
    op: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("secrets", mode);
      const req = op(tx.objectStore("secrets"));
      let value: T;
      req.onsuccess = () => {
        value = req.result as T;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
  get<T>(key: string) {
    return this.run<T | undefined>(key, "readonly", (s) => s.get(key));
  }
  set(key: string, value: unknown) {
    return this.run<void>(key, "readwrite", (s) => s.put(value, key));
  }
  delete(key: string) {
    return this.run<void>(key, "readwrite", (s) => s.delete(key));
  }
}
