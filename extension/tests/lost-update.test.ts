import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { indexedStorage } from "../src/platform/indexed-storage";
import { type StorageAdapter } from "../src/lib/storage";
import { chromeStorage, offscreenStorage } from "../src/platform/chrome-storage";
import { AppDataRepository } from "../src/lib/app-data";
import { defaults, type AppData } from "../src/lib/model";
import { merge } from "../src/lib/merge";
import { withAppDataLock } from "../src/lib/app-data";
import { LocalAccess } from "../../shared/protocol/src/local-access";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
function added(data: AppData, name: string) {
  const copy = structuredClone(data);
  copy.bookmarks.push({
    id: name,
    title: name,
    url: "https://example.com/" + name,
    groupId: copy.groups[0].id,
    order: 99,
    icon: { mode: "letter" },
    createdAt: 100,
    updatedAt: 100,
  });
  return copy;
}
afterEach(() => vi.unstubAllGlobals());
it("offscreen raw storage rejects a background storage error instead of returning an empty snapshot or a false success", async () => {
  const sendMessage = vi.fn().mockResolvedValue({ error: "QUOTA" });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const adapter = offscreenStorage();
  await expect(adapter.get("data")).rejects.toThrow("QUOTA");
  await expect(adapter.set("data", defaults())).rejects.toThrow("QUOTA");
  await expect(adapter.remove("data")).rejects.toThrow("QUOTA");
  sendMessage.mockResolvedValueOnce(undefined);
  await expect(adapter.get("data")).rejects.toThrow("STORAGE_UNAVAILABLE");
});
for (const kind of ["IndexedDB", "chrome.storage"] as const)
  describe(kind + " concurrent local/remote writes", () => {
    function adapter(): StorageAdapter {
      if (kind === "IndexedDB") {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.stubGlobal("BroadcastChannel", undefined);
        return indexedStorage("lost-update-test");
      }
      const values = new Map<string, unknown>();
      vi.stubGlobal("chrome", {
        storage: {
          local: {
            get: async (key: string) => ({
              [key]: structuredClone(values.get(key)),
            }),
            set: async (items: Record<string, unknown>) => {
              Object.entries(items).forEach(([k, v]) =>
                values.set(k, structuredClone(v)),
              );
            },
          },
        },
      });
      return chromeStorage();
    }
    it("deterministically reproduces the old lost update between loadLocal and saveMerged", async () => {
      const disk = adapter(),
        read = gate(),
        continueMerge = gate();
      await disk.set("data", defaults());
      const remote = added(defaults(), "remote");
      const receive = new LocalAccess({
        loadLocal: async () => {
          const stale = (await disk.get<AppData>("data"))!;
          read.release();
          await continueMerge.promise;
          return stale;
        },
        merge,
        saveMerged: (data) => disk.set("data", data),
        // Intentionally omits the application lock, reproducing the old wiring.
      }).merge(remote);
      await read.promise;
      await disk.set(
        "data",
        added((await disk.get<AppData>("data"))!, "local"),
      );
      expect(
        (await disk.get<AppData>("data"))!.bookmarks.some(
          (b) => b.id === "local",
        ),
      ).toBe(true);
      continueMerge.release();
      await receive;
      expect(
        (await disk.get<AppData>("data"))!.bookmarks.some(
          (b) => b.id === "local",
        ),
      ).toBe(false);
    });
    it("re-reads inside the shared queue and preserves both additions even for stale remote merges", async () => {
      const disk = adapter(),
        base = defaults(),
        saved = gate(),
        continueWrite = gate();
      await disk.set("data", base);
      const rawSet = disk.set.bind(disk);
      let delay = true;
      disk.set = async (key, value) => {
        if (delay) {
          delay = false;
          saved.release();
          await continueWrite.promise;
        }
        await rawSet(key, value);
      };
      const app = new AppDataRepository(disk),
        otherContext = new AppDataRepository(disk);
      const local = app.change(base, added(base, "local"));
      await saved.promise;
      const remote = otherContext.mergeRemote(
        merge(base, added(base, "remote")),
      );
      let acknowledged = false;
      void local.then(() => {
        acknowledged = true;
      });
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      continueWrite.release();
      await Promise.all([local, remote]);
      expect((await app.read()).bookmarks.map((b) => b.id)).toEqual(
        expect.arrayContaining(["local", "remote"]),
      );
      // Two stale page snapshots cannot overwrite each other's changes either.
      await Promise.all([
        app.change(base, added(base, "page1")),
        otherContext.change(base, added(base, "page2")),
      ]);
      expect((await app.read()).bookmarks.map((b) => b.id)).toEqual(
        expect.arrayContaining(["local", "remote", "page1", "page2"]),
      );
    });
    it("propagates durable write failures instead of acknowledging success", async () => {
      const disk = adapter();
      await disk.set("data", defaults());
      disk.set = async () => {
        throw Error("quota");
      };
      await expect(
        new AppDataRepository(disk).change(
          defaults(),
          added(defaults(), "failed"),
        ),
      ).rejects.toThrow("quota");
    });
    it("v3.3 library holds the same application lock across load, merge and durable save", async () => {
      const disk = adapter(),
        base = defaults(),
        read = gate(),
        resume = gate();
      await disk.set("data", base);
      const app = new AppDataRepository(disk);
      const access = new LocalAccess({
        withLocalLock: withAppDataLock,
        loadLocal: async () => {
          const data = await app.read();
          read.release();
          await resume.promise;
          return data;
        },
        merge,
        saveMerged: (data) => disk.set("data", data),
      });
      const receive = access.merge(added(base, "remote"));
      await read.promise;
      const local = app.change(base, added(base, "local"));
      resume.release();
      await Promise.all([receive, local]);
      expect((await app.read()).bookmarks.map((b) => b.id)).toEqual(
        expect.arrayContaining(["local", "remote"]),
      );
    });
    it("rebases field edits and deletion without overwriting other committed changes", async () => {
      const disk = adapter(),
        base = added(defaults(), "edited");
      await disk.set("data", base);
      const app = new AppDataRepository(disk);
      const local = structuredClone(base),
        remote = added(base, "remote");
      local.bookmarks.find((b) => b.id === "edited")!.icon = {
        mode: "letter",
        tone: "dark",
      };
      local.settings.grain = !base.settings.grain;
      remote.bookmarks.find((b) => b.id === "edited")!.title = "remote title";
      remote.bookmarks.find((b) => b.id === "edited")!.updatedAt = 200;
      remote.settings.seconds = !base.settings.seconds;
      remote.settings.updatedAt += 1;
      await app.mergeRemote(remote);
      await app.change(base, local);
      const saved = await app.read();
      expect(saved.bookmarks.find((b) => b.id === "edited")).toMatchObject({
        title: "remote title",
        icon: { tone: "dark" },
      });
      expect(saved.settings).toMatchObject({
        grain: local.settings.grain,
        seconds: remote.settings.seconds,
      });
      const removal = structuredClone(base);
      removal.bookmarks = removal.bookmarks.filter((b) => b.id !== "edited");
      await app.change(base, removal);
      expect((await app.read()).bookmarks.map((b) => b.id)).toContain("remote");
      expect((await app.read()).bookmarks.map((b) => b.id)).not.toContain(
        "edited",
      );
      await app.change(base, local); // delayed icon must not resurrect the deleted bookmark
      expect((await app.read()).bookmarks.map((b) => b.id)).not.toContain(
        "edited",
      );
    });
    it("undo clears only the observed tombstone and survives delayed deletion snapshots", async () => {
      const disk = adapter(),
        base = added(defaults(), "undo"),
        app = new AppDataRepository(disk);
      await disk.set("data", base);
      const deleted = structuredClone(base);
      deleted.bookmarks = deleted.bookmarks.filter((b) => b.id !== "undo");
      deleted.tombstones.push({
        id: "undo",
        kind: "bookmark",
        deletedAt: Date.now(),
      });
      await app.change(base, deleted);
      const beforeUndo = await app.read(),
        afterUndo = structuredClone(beforeUndo);
      afterUndo.tombstones = afterUndo.tombstones.filter(
        (t) => t.id !== "undo",
      );
      afterUndo.bookmarks.push(base.bookmarks.find((b) => b.id === "undo")!);
      await app.change(beforeUndo, afterUndo);
      await app.mergeRemote(beforeUndo);
      expect((await app.read()).bookmarks.map((b) => b.id)).toContain("undo");
      const newer = structuredClone(beforeUndo);
      newer.tombstones.find((t) => t.id === "undo")!.deletedAt += 1000;
      await app.mergeRemote(newer);
      await app.change(beforeUndo, afterUndo);
      expect((await app.read()).bookmarks.map((b) => b.id)).not.toContain(
        "undo",
      );
    });
  });
