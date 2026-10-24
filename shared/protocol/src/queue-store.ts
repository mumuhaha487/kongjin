import type { QueueStore } from "./types.ts";

export class MemoryQueueStore implements QueueStore {
  private data = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async set(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { this.data.delete(key); }
}

export class IndexedDBQueueStore implements QueueStore {
  private db?: Promise<IDBDatabase>;
  constructor(private name = "kj-continuity") {}
  private open() {
    return this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("data");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  private async access(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest) {
    const db = await this.open();
    return new Promise<any>((resolve, reject) => {
      const tx = db.transaction("data", mode), request = op(tx.objectStore("data"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? request.error);
    });
  }
  get<T>(key: string): Promise<T | undefined> { return this.access("readonly", s => s.get(key)); }
  async set(key: string, value: unknown) { await this.access("readwrite", s => s.put(value, key)); }
  async delete(key: string) { await this.access("readwrite", s => s.delete(key)); }
}
