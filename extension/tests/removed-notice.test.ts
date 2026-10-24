import { beforeEach, expect, it, vi } from "vitest";
import { memoryStorage } from "../src/lib/storage";
import { defaults } from "../src/lib/model";
import { initialStatus, type SyncStatus } from "../src/features/pairing/types";
import { RemovedNotices } from "../src/features/pairing/removed-notice";
import { syncFooter } from "../src/features/pairing/status";

const mock = vi.hoisted(() => ({
  listeners: new Map<string, (value: unknown) => void>(),
  status: {} as SyncStatus,
  complete: () => {},
}));
vi.mock("@kongjing/protocol", () => ({
  KongjingSync: class {
    on(event: string, fn: (value: unknown) => void) {
      mock.listeners.set(event, fn);
    }
    status() {
      return mock.status;
    }
    async init() {}
    async join() {
      return {
        sas: Promise.resolve({ sas: "123456", inviterName: "A" }),
        confirm: async () => {},
        cancel: () => {},
        done: new Promise<void>((resolve) => {
          mock.complete = resolve;
        }),
      };
    }
  },
}));
vi.mock("../src/features/continuity/service", () => ({
  attachContinuity: async () => ({}),
}));
vi.mock("../src/features/continuity/desktop", () => ({
  installDesktopContinuity: vi.fn(),
}));
vi.mock("../src/features/pairing/engine", async () => {
  const { KongjingSync } = await import("@kongjing/protocol");
  return { createEngine: (options: ConstructorParameters<typeof KongjingSync>[0]) => Object.assign(new KongjingSync(options), { preferences: () => ({}), setForeground: () => {} }) };
});
import { PairController } from "../src/features/pairing/controller";

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://localhost/" });
  mock.listeners.clear();
  mock.status = initialStatus();
});
const dispatch = (status: SyncStatus) => {
  mock.status = status;
  mock.listeners.get("status")!(status);
};
async function fixture() {
  const storage = memoryStorage(),
    updates: SyncStatus[] = [];
  const controller = new PairController(
    async () => defaults(),
    async () => {},
    (s) => updates.push(s),
    undefined,
    storage,
  );
  await controller.init();
  dispatch({
    ...initialStatus(),
    paired: true,
    connection: "online",
    devices: [
      {
        deviceId: "a",
        name: "A",
        platform: "Chrome",
        online: true,
        self: true,
      },
      {
        deviceId: "b",
        name: "B",
        platform: "Chrome",
        online: true,
        self: false,
      },
    ],
  });
  mock.status = initialStatus();
  mock.listeners.get("removed")!(undefined);
  await vi.waitFor(() => expect(controller.status.removedNotice).toBeDefined());
  return { controller, storage, updates };
}
it("removed persists across repeated protocol status events, controller restart, and leaves data intact", async () => {
  const { controller, storage } = await fixture();
  const notice = controller.status.removedNotice!;
  expect(notice.groupDevices).toBe(2);
  const data = defaults();
  await storage.set("data", data);
  for (let i = 0; i < 20; i++) dispatch(initialStatus());
  // A stale paired status is also just a refresh, never proof of re-pairing.
  dispatch({ ...initialStatus(), paired: true });
  expect(controller.status.removedNotice).toEqual(notice);
  expect(await storage.get("removedNotice")).toEqual(notice);
  mock.status = initialStatus();
  const restarted = new PairController(
    async () => defaults(),
    async () => {},
    () => {},
    undefined,
    storage,
  );
  await restarted.init();
  expect(restarted.status.removedNotice).toEqual(notice);
  expect(syncFooter(restarted.status)).toBe("仅本机");
  expect(await storage.get("data")).toEqual(data);
});
it("acknowledgement removes persistent notice and status events cannot revive it", async () => {
  const { controller, storage } = await fixture();
  await controller.command("dismiss-removed-notice");
  dispatch(initialStatus());
  expect(controller.status.removedNotice).toBeUndefined();
  expect(await storage.get("removedNotice")).toBeUndefined();
});
it("successful re-pair clears notice without requiring acknowledgement", async () => {
  const { controller, storage } = await fixture();
  await controller.command("join", { code: "TEST", name: "B" });
  mock.status = { ...initialStatus(), paired: true };
  mock.complete();
  await vi.waitFor(() =>
    expect(controller.status.removedNotice).toBeUndefined(),
  );
  expect(await storage.get("removedNotice")).toBeUndefined();
});
it("toast is claimed only once across concurrent pages and restarts; a new removal gets a new toast", async () => {
  const storage = memoryStorage(),
    notices = new RemovedNotices(storage);
  await notices.record(100, 3);
  const claims = await Promise.all([
    notices.claimToast(100),
    notices.claimToast(100),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const restart = new RemovedNotices(storage);
  await restart.load();
  expect(await restart.claimToast(100)).toBeUndefined();
  await restart.clear();
  expect(await restart.claimToast(100)).toBeUndefined();
  await restart.record(200);
  expect(await restart.claimToast(200)).toEqual({ at: 200 });
});
