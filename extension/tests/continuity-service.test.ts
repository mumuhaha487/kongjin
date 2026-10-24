import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange as FakeRange } from "fake-indexeddb";
import { defaults } from "../src/lib/model";
import { initialStatus } from "../src/features/pairing/types";
import type {
  ContinuityClient,
  Incoming,
  JournalRecord,
  Slot,
} from "../src/features/continuity/types";
const storageValues = new Map<string, unknown>();
vi.mock("../src/lib/storage", () => ({
  storage: {
    get: async (k: string) => storageValues.get(k),
    set: async (k: string, v: unknown) => {
      storageValues.set(k, structuredClone(v));
    },
    subscribe: () => () => {},
  },
  imageFile: vi.fn(),
}));
import { ContinuityService } from "../src/features/continuity/service";
function clientFixture() {
  let journal: Parameters<ContinuityClient["onJournal"]>[0] = () => {};
  let incoming: (i: Incoming) => void = () => {};
  let slots: (s: Slot[]) => void = () => {};
  const client: ContinuityClient = {
    status: () => ({
      ...initialStatus(),
      paired: true,
      devices: [
        {
          deviceId: "a",
          name: "电脑A",
          platform: "Chrome",
          online: true,
          self: true,
        },
        {
          deviceId: "b",
          name: "电脑B",
          platform: "Chrome",
          online: true,
          self: false,
        },
      ],
    }),
    on: () => () => {},
    onJournal: (fn) => {
      journal = fn;
      return () => {};
    },
    onIncoming: (fn) => {
      incoming = fn;
      return () => {};
    },
    onSlots: (fn) => {
      slots = fn;
      return () => {};
    },
    journalAppend: vi.fn(() => crypto.randomUUID()),
    syncNow: vi.fn(async () => {}),
    journalCursor: () => 0,
    putSlot: vi.fn(async () => {}),
    getSlots: async () => [],
    deleteSlot: vi.fn(async () => {}),
    putBlob: vi.fn(async () => ({ blobId: "image", size: 10 })),
    getBlob: async () => new Uint8Array(),
    deleteBlob: vi.fn(async () => {}),
    sendTo: vi.fn(() => "sent"),
    ack: vi.fn(),
  };
  return {
    client,
    journal: (r: JournalRecord[]) => journal(r, { replay: false }),
    incoming: (i: Incoming) => incoming(i),
    slots: (s: Slot[]) => slots(s),
  };
}
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = FakeRange;
  storageValues.clear();
});
describe("continuity application contract", () => {
  it("flushes a delayed desktop batch once, only when it changed history, preserving the offline queue", async () => {
    const { client } = clientFixture();
    const service = new ContinuityService(
      client,
      async () => defaults(),
      async () => {},
    );
    await service.init();
    await service.setOption("history", true);
    const visits = [1, 2, 3].map((i) => ({
      u: "https://example.com/" + i,
      ti: "网页 " + i,
      at: Date.now(),
    }));
    await service.recordVisits(visits, true);
    expect(client.journalAppend).toHaveBeenCalledExactlyOnceWith("hv", {
      v: visits,
    });
    expect(client.syncNow).toHaveBeenCalledOnce();
    await service.recordVisits(visits, true);
    expect(client.syncNow).toHaveBeenCalledOnce();
    vi.mocked(client.syncNow!).mockRejectedValueOnce(Error("OFFLINE"));
    await expect(
      service.recordVisits(
        [{ ...visits[0], u: "https://example.com/offline" }],
        true,
      ),
    ).resolves.toEqual({});
    expect(client.journalAppend).toHaveBeenCalledTimes(2);
    expect((await service.db.query()).items).toHaveLength(4);
  });
  it("reuploads enriched local titles and publishes remote enrichment for UI refresh", async () => {
    const fixture = clientFixture();
    const service = new ContinuityService(
      fixture.client,
      async () => defaults(),
      async () => {},
    );
    await service.init();
    await service.setOption("history", true);
    const at = Date.now(),
      u = "https://example.com/history";
    await service.recordVisits([{ u, at, ti: "" }]);
    await service.recordVisits([{ u, at, ti: "接力测试网页" }]);
    expect(fixture.client.journalAppend).toHaveBeenCalledTimes(2);
    expect(fixture.client.journalAppend).toHaveBeenLastCalledWith("hv", {
      v: [{ u, at, ti: "接力测试网页" }],
    });
    expect((await service.db.query({ dev: "a" })).items).toHaveLength(1);
    const first = {
      id: "remote-empty",
      seq: 1,
      t: "hv",
      dev: "b",
      at,
      v: [{ u, at, ti: "" }],
    };
    await fixture.journal([first]);
    const refresh = vi.fn();
    service.subscribe(refresh);
    await fixture.journal([
      {
        ...first,
        id: "remote-title",
        seq: 2,
        v: [{ u, at, ti: "远端真实标题" }],
      },
    ]);
    expect(refresh).toHaveBeenCalledOnce();
    const remote = await service.db.query({ dev: "b", query: "远端真实" });
    expect(remote.items).toHaveLength(1);
    expect(remote.items[0].ti).toBe("远端真实标题");
  });
  it("uploads a background without mutating the host before its change-detecting commit", async () => {
    const { client } = clientFixture();
    let current = defaults(),
      commits = 0;
    const original = current;
    const service = new ContinuityService(
      client,
      async () => current,
      async (next) => {
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          commits++;
          current = next;
        }
      },
    );
    await service.init();
    await service.uploadBackground(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
      32,
      20,
    );
    expect(commits).toBe(1);
    expect(original.settings.background).toBe("kongjing");
    expect(current.settings).toMatchObject({
      background: "image",
      imageUrl: "local",
      backgroundImage: { blobId: "image", w: 32, h: 20 },
    });
  });
  it("keeps opt-in collection disabled until authorized, and returns optional permissions on disable", async () => {
    const { client } = clientFixture(),
      data = defaults(),
      save = vi.fn(async () => {});
    const service = new ContinuityService(client, async () => data, save);
    await service.init();
    await service.recordVisits([
      { u: "https://example.com/", ti: "off", at: Date.now() },
    ]);
    expect(client.journalAppend).not.toHaveBeenCalled();
    const collector = vi.fn(async () => false);
    service.setCollector(collector);
    expect(await service.setOption("history", true)).toEqual({
      granted: false,
    });
    expect(service.options.history).toBe(false);
    collector.mockResolvedValue(true);
    await service.setOption("history", true);
    await service.recordVisits([
      { u: "https://example.com/", ti: "on", at: Date.now() },
    ]);
    expect(client.journalAppend).toHaveBeenCalledWith("hv", expect.any(Object));
    await service.setOption("history", false);
    expect(collector).toHaveBeenLastCalledWith("history", false);
    expect(data.settings).not.toHaveProperty("continuity-options");
    expect(storageValues.get("continuity-options")).toMatchObject({
      history: false,
    });
  });
  it("serializes journal and incoming callback duplicates, displays one notification, preserves read state", async () => {
    const fixture = clientFixture(),
      service = new ContinuityService(
        fixture.client,
        async () => defaults(),
        async () => {},
      );
    await service.init();
    service.notifyIncoming = vi.fn(async () => {});
    const item = {
      id: "one",
      from: "b",
      k: "url",
      u: "https://example.com/",
      ti: "接力",
      at: Date.now(),
    };
    fixture.journal([{ ...item, dev: "b", t: "snd", seq: 1, to: "a" }]);
    fixture.incoming(item);
    await vi.waitFor(() =>
      expect(service.notifyIncoming).toHaveBeenCalledTimes(1),
    );
    await service.read(item.id);
    fixture.incoming(item);
    await vi.waitFor(async () =>
      expect((await service.state()).inbox[0].read).toBe(true),
    );
    expect(fixture.client.ack).toHaveBeenCalledWith("one");
    expect(service.notifyIncoming).toHaveBeenCalledTimes(1);
  });
  it("returns only remote history for native suggestions and removes its slot when sharing stops", async () => {
    const { client } = clientFixture(),
      service = new ContinuityService(
        client,
        async () => defaults(),
        async () => {},
      );
    await service.init();
    await service.db.visits("a", [
      { u: "https://example.com/self", ti: "测试本机", at: Date.now() },
    ]);
    await service.db.visits("b", [
      { u: "https://example.com/remote", ti: "测试远端", at: Date.now() },
    ]);
    expect(await service.searchHistory("测试")).toEqual([
      expect.objectContaining({ dev: "b", devName: "电脑B" }),
    ]);
    await service.setOption("tabs", false);
    expect(client.deleteSlot).toHaveBeenCalledOnce();
  });
  it("propagates journal storage failure to the protocol and permits an idempotent retry", async () => {
    const fixture = clientFixture(),
      service = new ContinuityService(
        fixture.client,
        async () => defaults(),
        async () => {},
      );
    await service.init();
    const apply = vi
      .spyOn(service.db, "apply")
      .mockRejectedValueOnce(Error("IDB_ABORT"));
    const record = {
      id: "retry",
      seq: 1,
      t: "hv",
      dev: "b",
      at: Date.now(),
      v: [{ u: "https://example.com/retry", ti: "重试", at: Date.now() }],
    };
    await expect(fixture.journal([record])).rejects.toThrow("IDB_ABORT");
    await fixture.journal([record]);
    await fixture.journal([record]);
    expect(apply).toHaveBeenCalledTimes(3);
    expect((await service.db.query()).items).toHaveLength(1);
  });
  it("marks incoming IDs read once across repeated native calls and replay", async () => {
    const { client } = clientFixture(),
      service = new ContinuityService(
        client,
        async () => defaults(),
        async () => {},
      );
    await service.init();
    const item = {
      id: "read-one",
      from: "b",
      at: Date.now(),
      k: "url",
      u: "https://example.com/",
    };
    await service.incoming(item);
    await Promise.all([
      service.execute("markIncomingRead", { ids: [item.id, item.id] }),
      service.execute("markIncomingRead", { ids: [item.id] }),
    ]);
    await service.incoming(item);
    expect((await service.state()).inbox[0].read).toBe(true);
    expect(client.ack).toHaveBeenCalledTimes(1);
    await expect(
      service.execute("markIncomingRead", { ids: [3] }),
    ).rejects.toThrow("INVALID_ARGS");
  });
});
