import { defaults, type AppData } from "./model";
import { migrate } from "./migration";
import { merge } from "./merge";
import { storage, type StorageAdapter } from "./storage";

// Web Locks coordinate new tabs, popup, worker and offscreen on the same origin.
// Android uses the same lock; the fallback is for non-browser unit tests only.
let tail: Promise<unknown> = Promise.resolve();
export async function withAppDataLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks)
    return await navigator.locks.request("kongjing:app-data", task);
  const result = tail.then(task, task);
  tail = result.catch(() => {});
  return result;
}

/** A proposal contains only this interaction's changes, never a stale whole snapshot. */
export function rebaseChange(
  latest: AppData,
  before: AppData,
  after: AppData,
): AppData {
  const next = structuredClone(latest);
  for (const key of ["bookmarks", "groups", "searchEngines"] as const) {
    const kind = key === "groups" ? "group" : key === "bookmarks" ? "bookmark" : "searchEngine";
    const old = new Map(before[key].map((v) => [v.id, v]));
    const changed = after[key].filter(
      (v) => JSON.stringify(old.get(v.id)) !== JSON.stringify(v),
    );
    const removed = before[key].filter(
      (v) => !after[key].some((n) => n.id === v.id),
    );
    // Applying the delta preserves concurrent additions, including during import/reset.
    const edits = changed.flatMap((value) => {
      const prior = old.get(value.id),
        current = next[key].find((v) => v.id === value.id);
      if (!prior) {
        const added = structuredClone(value);
        const knownDeletion = before.tombstones.find(
          (t) => t.id === value.id && t.kind === kind,
        )?.deletedAt;
        if (knownDeletion !== undefined)
          added.updatedAt = Math.max(added.updatedAt, knownDeletion + 1);
        return [added];
      }
      // A late icon response must neither resurrect a deletion nor undo a title edit.
      if (!current) return [];
      const delta = structuredClone(current) as unknown as Record<
        string,
        unknown
      >;
      const a = prior as unknown as Record<string, unknown>,
        b = value as unknown as Record<string, unknown>;
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (
          field === "updatedAt" ||
          JSON.stringify(a[field]) === JSON.stringify(b[field])
        )
          continue;
        if (field in b) delta[field] = structuredClone(b[field]);
        else delete delta[field];
      }
      delta.updatedAt = Math.max(value.updatedAt, current.updatedAt + 1);
      return [delta as unknown as typeof value];
    });
    Object.assign(next, {
      [key]: [
        ...next[key].filter(
          (v) =>
            !edits.some((n) => n.id === v.id) &&
            !removed.some((n) => n.id === v.id),
        ),
        ...edits,
      ],
    });
      for (const item of removed) {
        if (!after.tombstones.some((t) => t.id === item.id && t.kind === kind))
          next.tombstones.push({
            id: item.id,
            kind,
            deletedAt: Math.max(
              Date.now(),
              (latest[key].find((v) => v.id === item.id)?.updatedAt ??
                item.updatedAt) + 1,
            ),
          });
      }
  }
  for (const key of ["settings", "profile"] as const) {
    const a = before[key] as unknown as Record<string, unknown>;
    const b = after[key] as unknown as Record<string, unknown>;
    const target = next[key] as unknown as Record<string, unknown>;
    let changed = false;
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (
        field === "updatedAt" ||
        JSON.stringify(a[field]) === JSON.stringify(b[field])
      )
        continue;
      changed = true;
      if (field in b) target[field] = structuredClone(b[field]);
      else delete target[field];
    }
    if (changed)
      target.updatedAt = Math.max(Number(b.updatedAt), next[key].updatedAt + 1);
  }
  const removedTombs = before.tombstones.filter(
    (t) =>
      !after.tombstones.some((b) => JSON.stringify(t) === JSON.stringify(b)),
  );
  next.tombstones = next.tombstones.filter(
    (t) => !removedTombs.some((b) => JSON.stringify(t) === JSON.stringify(b)),
  );
  next.tombstones.push(
    ...after.tombstones
      .filter(
        (t) =>
          !before.tombstones.some(
            (b) => JSON.stringify(t) === JSON.stringify(b),
          ),
      )
      .map((t) => {
        const existing = (
          t.kind === "bookmark" ? latest.bookmarks : t.kind === "group" ? latest.groups : latest.searchEngines
        ).find((b) => b.id === t.id);
        return {
          ...t,
          deletedAt: Math.max(t.deletedAt, (existing?.updatedAt ?? -1) + 1),
        };
      }),
  );
  // Reuse the canonical tombstone, dangling-group and deterministic merge rules.
  return merge(next, next);
}

export class AppDataRepository {
  constructor(
    private adapter: StorageAdapter,
    private lock = withAppDataLock,
  ) {}
  async read() {
    return migrate(await this.adapter.get("data")) || defaults();
  }
  async change(before: AppData, after: AppData) {
    return this.update((latest) => rebaseChange(latest, before, after));
  }
  async update(edit: (latest: AppData) => AppData | void) {
    return this.lock(async () => {
      const latest = await this.read();
      const data = edit(latest) || latest;
      await this.adapter.set("data", data);
      return data;
    });
  }
  async mergeRemote(snapshot: AppData) {
    return this.update((latest) => merge(latest, snapshot));
  }
}
export const appData = new AppDataRepository(storage);
