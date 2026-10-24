import { visitId, textTerms, recordableUrl } from "./privacy";
import type {
  DeleteRule,
  HistoryPage,
  HistoryQuery,
  Incoming,
  JournalRecord,
  RawVisit,
  Slot,
  Visit,
} from "./types";
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = t.onerror = () => reject(t.error || Error("IDB_ABORT"));
  });
export function deletionMatches(v: Visit, d: DeleteRule) {
  return (
    (d.scope === "all" || v.dev === d.dev) &&
    (!d.ids || d.ids.includes(v.id)) &&
    (!d.range || (v.at >= d.range.from && v.at <= d.range.to))
  );
}
export class ContinuityDB {
  private opened?: Promise<IDBDatabase>;
  private serial = Promise.resolve();
  constructor(private name = "kongjing-continuity") {}
  private db() {
    return (this.opened ||= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => {
        const db = r.result,
          v = db.createObjectStore("visits", { keyPath: "id" });
        v.createIndex("at", ["at", "id"]);
        v.createIndex("dev", ["dev", "at"]);
        v.createIndex("text", "terms", { multiEntry: true });
        for (const name of [
          "deletions",
          "applied",
          "inbox",
          "slots",
          "blobs",
          "search",
          "meta",
        ])
          db.createObjectStore(name);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.then(fn, fn);
    this.serial = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  async get<T>(store: string, key: IDBValidKey) {
    const d = await this.db();
    return request(d.transaction(store).objectStore(store).get(key)) as Promise<
      T | undefined
    >;
  }
  async all<T>(store: string) {
    const d = await this.db();
    return request(d.transaction(store).objectStore(store).getAll()) as Promise<
      T[]
    >;
  }
  async put(store: string, key: IDBValidKey, value: unknown) {
    const d = await this.db(),
      t = d.transaction(store, "readwrite"),
      complete = done(t);
    t.objectStore(store).put(value, key);
    await complete;
  }
  async remove(store: string, key: IDBValidKey) {
    const d = await this.db(),
      t = d.transaction(store, "readwrite"),
      complete = done(t);
    t.objectStore(store).delete(key);
    await complete;
  }
  async clear() {
    const d = await this.db(),
      names = [...d.objectStoreNames],
      t = d.transaction(names, "readwrite"),
      complete = done(t);
    names.forEach((n) => t.objectStore(n).clear());
    await complete;
  }
  async markRead(id: string) {
    const db = await this.db(),
      t = db.transaction("inbox", "readwrite"),
      complete = done(t),
      store = t.objectStore("inbox");
    const item = (await request(store.get(id))) as Incoming | undefined;
    const changed = !!item && !item.read;
    if (changed) store.put({ ...item, read: true }, id);
    await complete;
    return changed;
  }
  async storeIncoming(item: Incoming) {
    const db = await this.db(),
      t = db.transaction("inbox", "readwrite"),
      complete = done(t),
      store = t.objectStore("inbox");
    const existing = (await request(store.get(item.id))) as
      | Incoming
      | undefined;
    store.put({ ...item, read: !!existing?.read || !!item.read }, item.id);
    await complete;
  }
  async visits(dev: string, input: RawVisit[], recordAt = Date.now()) {
    const prepared = await Promise.all(
      input.map(async (v) => {
        const text = (v.ti + " " + v.u).toLowerCase();
        return {
          ...v,
          dev,
          id: await visitId(dev, v.u, v.at),
          text,
          terms: textTerms(text),
        };
      }),
    );
    return this.enqueue(async () => {
      const [old, deletions] = await Promise.all([
        this.all<Visit>("visits"),
        this.all<DeleteRule>("deletions"),
      ]);
      const changed = new Map<string, Visit>();
      for (const v of prepared) {
        if (deletions.some((d) => recordAt <= d.at && deletionMatches(v, d)))
          continue;
        const existing = old.find(
          (o) => o.dev === dev && o.u === v.u && Math.abs(o.at - v.at) < 60000,
        );
        if (existing) {
          if (
            v.ti.trim() &&
            (!existing.ti.trim() || existing.ti === existing.u)
          ) {
            // Preserve the original identity/time for deletion and replay semantics.
            const text = (v.ti + " " + existing.u).toLowerCase();
            Object.assign(existing, { ti: v.ti, text, terms: textTerms(text) });
            changed.set(existing.id, existing);
          }
          continue;
        }
        old.push(v);
        changed.set(v.id, v);
      }
      const d = await this.db(),
        tx = d.transaction("visits", "readwrite"),
        complete = done(tx);
      changed.forEach((v) => tx.objectStore("visits").put(v));
      await complete;
      return [...changed.values()];
    });
  }
  async deleteVisits(rule: DeleteRule) {
    return this.enqueue(async () => {
      const old = await this.all<Visit>("visits"),
        removed = old.filter((v) => deletionMatches(v, rule));
      const db = await this.db(),
        t = db.transaction(["deletions", "visits"], "readwrite"),
        complete = done(t);
      t.objectStore("deletions").put(rule, rule.id);
      removed.forEach((v) => t.objectStore("visits").delete(v.id));
      await complete;
      return removed;
    });
  }
  async query(q: HistoryQuery = {}, self = ""): Promise<HistoryPage> {
    const term = (q.query || "").trim().toLowerCase(),
      limit = Math.max(1, Math.min(q.limit || 100, 500)),
      db = await this.db();
    if (term.length >= 3) {
      const values: Visit[] = await request(
        db
          .transaction("visits")
          .objectStore("visits")
          .index("text")
          .getAll(term.slice(0, 3)),
      );
      const matching = values
        .filter(
          (v) =>
            v.text.includes(term) &&
            (!q.dev || q.dev === v.dev) &&
            (!q.others || v.dev !== self) &&
            (!q.before ||
              v.at < q.before[0] ||
              (v.at === q.before[0] && v.id < q.before[1])),
        )
        .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
      return this.page(matching, limit);
    }
    const store = db.transaction("visits").objectStore("visits"),
      index = store.index(q.dev ? "dev" : "at"),
      range = q.dev
        ? IDBKeyRange.bound(
            [q.dev, 0],
            [q.dev, q.before?.[0] ?? Number.MAX_SAFE_INTEGER],
          )
        : q.before
          ? IDBKeyRange.upperBound(q.before, true)
          : undefined;
    return new Promise((resolve, reject) => {
      const values: Visit[] = [],
        r = index.openCursor(range, "prev");
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const c = r.result;
        if (!c || values.length > limit) {
          resolve(this.page(values, limit));
          return;
        }
        const v = c.value as Visit;
        if (
          (!q.dev || v.dev === q.dev) &&
          (!q.before ||
            v.at < q.before[0] ||
            (v.at === q.before[0] && v.id < q.before[1])) &&
          (!q.others || v.dev !== self) &&
          (!term || v.text.includes(term))
        )
          values.push(v);
        c.continue();
      };
    });
  }
  private page(values: Visit[], limit: number): HistoryPage {
    const items = values.slice(0, limit),
      last = items[items.length - 1];
    return {
      items,
      ...(values.length > limit && last
        ? { next: [last.at, last.id] as [number, string] }
        : {}),
    };
  }
  async apply(record: JournalRecord, self: string) {
    if (await this.get("applied", record.id)) return;
    if (record.t === "hv" && Array.isArray(record.v)) {
      const visits = (record.v as RawVisit[]).flatMap((v) => {
        const u = typeof v.u === "string" && recordableUrl(v.u);
        return u && typeof v.ti === "string" && Number.isFinite(v.at)
          ? [{ ...v, u }]
          : [];
      });
      await this.visits(record.dev, visits, record.at);
    }
    if (record.t === "hd")
      await this.deleteVisits({
        id: record.id,
        dev: record.dev,
        at: record.at,
        ids: record.ids as string[] | undefined,
        range: record.range as DeleteRule["range"],
        scope: record.scope === "all" ? "all" : "self",
      });
    if (record.t === "sh" && Array.isArray(record.q))
      for (const q of record.q as { s: string; at: number }[])
        if (typeof q.s === "string" && Number.isFinite(q.at))
          await this.put("search", record.dev + "|" + q.at + "|" + q.s, {
            ...q,
            dev: record.dev,
          });
    if (record.t === "sd") {
      const db = await this.db(),
        t = db.transaction("search", "readwrite"),
        complete = done(t),
        r = t.objectStore("search").openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        const range = record.range as { from: number; to: number } | undefined;
        if (
          record.all ||
          !range ||
          (c.value.at >= range.from && c.value.at <= range.to)
        )
          c.delete();
        c.continue();
      };
      await complete;
    }
    if (
      record.t === "snd" &&
      record.to === self &&
      !(await this.get("meta", "dismissed:" + record.id))
    ) {
      await this.storeIncoming({
        id: record.id,
        from: record.dev,
        at: record.at,
        k: String(record.k),
        u: record.u as string | undefined,
        ti: record.ti as string | undefined,
        tx: record.tx as string | undefined,
      } satisfies Incoming);
    }
    if (record.t === "ack") {
      const item = await this.get<Incoming>("inbox", String(record.ref));
      if (item) await this.put("inbox", item.id, { ...item, read: true });
    }
    await this.put("applied", record.id, record.at);
  }
  async setSlots(slots: Slot[]) {
    const db = await this.db(),
      t = db.transaction("slots", "readwrite"),
      complete = done(t),
      s = t.objectStore("slots");
    s.clear();
    slots.forEach((v) => s.put(v, v.dev));
    await complete;
  }
  async clean(days: number, now = Date.now()) {
    const db = await this.db(),
      t = db.transaction(
        ["visits", "inbox", "search", "applied", "deletions"],
        "readwrite",
      ),
      complete = done(t);
    for (const name of ["visits", "inbox", "search", "applied", "deletions"]) {
      const r = t.objectStore(name).openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        const value = c.value,
          age = now - (typeof value === "number" ? value : value.at);
        if (
          age >
          (name === "inbox"
            ? 7
            : name === "applied" || name === "deletions"
              ? 90
              : days) *
            86400000
        )
          c.delete();
        c.continue();
      };
    }
    await complete;
    const inbox = (await this.all<Incoming>("inbox")).sort(
      (a, b) => b.at - a.at,
    );
    await Promise.all(inbox.slice(20).map((v) => this.remove("inbox", v.id)));
  }
}
