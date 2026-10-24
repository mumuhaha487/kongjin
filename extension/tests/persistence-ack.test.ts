import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
vi.mock("../src/features/pairing/bridge", () => ({
  notifyPairing: vi.fn(),
  connectPairing: vi.fn(),
  pairCommand: vi.fn(),
}));
vi.mock("../src/lib/visibility", () => ({ visibleTimeout: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("flushPersistence rejects a failed durable write instead of acknowledging addBookmark", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k),
    setItem: () => {
      throw Error("quota");
    },
  });
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  const { storage } = await import("../src/lib/storage");
  vi.spyOn(storage, "set").mockRejectedValueOnce(Error("quota"));
  const { useStore, flushPersistence } = await import("../src/app/store");
  const task = useStore.getState().update((d) => {
    d.profile.nickname = "not saved";
  });
  await expect(task).rejects.toThrow("quota");
  await expect(flushPersistence()).rejects.toThrow("quota");
  const { notifyPairing } = await import("../src/features/pairing/bridge");
  expect(notifyPairing).not.toHaveBeenCalled();
});
