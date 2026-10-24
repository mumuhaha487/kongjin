import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange as FakeRange } from "fake-indexeddb";
import { ContinuityDB } from "../src/features/continuity/database";
import {
  filterVisits,
  recordableUrl,
  safeSlot,
  visitId,
} from "../src/features/continuity/privacy";
import { virtualWindow } from "../src/features/continuity/virtual";
import type {
  JournalRecord,
  RawVisit,
  Visit,
} from "../src/features/continuity/types";
const now = Date.now(),
  visit = (
    u = "https://example.com/",
    at = now,
    ti = "空境设计资料",
  ): RawVisit => ({ u, at, ti });
let db: ContinuityDB;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = FakeRange;
  db = new ContinuityDB("test");
});
describe("continuity privacy", () => {
  it("only records public http(s) URLs and strips fragments", () => {
    for (const u of [
      "chrome://history/",
      "chrome-extension://id/a",
      "file:///x",
      "ftp://example.com/",
      "http://localhost/a",
      "http://foo.localhost/",
      "http://foo.local/",
      "http://foo.lan/",
      "http://127.0.0.1/",
      "https://10.2.3.4/",
      "https://192.168.0.2/",
      "https://172.16.0.2/",
      "https://172.31.0.2/",
      "https://8.8.8.8/",
      "http://[::1]/",
      "http://[2001:db8::1]/",
      "http://2130706433/",
      "https://user:pass@example.com/",
    ])
      expect(recordableUrl(u)).toBeNull();
    expect(recordableUrl("https://EXAMPLE.com:443/a?q=design#secret")).toBe(
      "https://example.com/a?q=design",
    );
  });
  it("rejects every sensitive key, including mixed case and percent encoded keys", () => {
    for (const key of [
      "token",
      "access_token",
      "id_token",
      "code",
      "password",
      "passwd",
      "pwd",
      "session",
      "sessionid",
      "sid",
      "sig",
      "signature",
      "auth",
      "key",
      "apikey",
      "otp",
    ]) {
      expect(
        recordableUrl("https://example.com/?" + key.toUpperCase() + "=x"),
      ).toBeNull();
      expect(
        recordableUrl("https://example.com/?q=ok&" + key + "="),
      ).toBeNull();
    }
    expect(recordableUrl("https://example.com/?%74oken=x")).toBeNull();
    expect(recordableUrl("https://example.com/?keyword=ok")).toBeTruthy();
  });
  it("excludes websites and their subdomains without matching unrelated suffixes", () => {
    expect(recordableUrl("https://bank.com/", ["bank.com"])).toBeNull();
    expect(recordableUrl("https://pay.bank.com/", ["bank.com"])).toBeNull();
    expect(recordableUrl("https://notbank.com/", ["bank.com"])).toBeTruthy();
  });
  it("rejects malformed visits and expired timestamps", () => {
    expect(
      filterVisits(
        [
          visit(),
          visit(undefined, now - 31 * 86400000),
          visit(undefined, NaN),
          visit(undefined, now + 120000),
          visit("https://example.com/?otp=123"),
        ],
        [],
        now,
        30,
      ),
    ).toHaveLength(1);
    expect(
      filterVisits([visit(undefined, now - 40 * 86400000)], [], now, 90),
    ).toHaveLength(1);
  });
  it("applies the same rules to tabs, limits 200 and preserves the focused item", () => {
    const slot = safeSlot(
      {
        windows: [
          {
            focused: true,
            tabs: [
              { u: "http://localhost/", ti: "private", active: false },
              ...Array.from({ length: 220 }, (_, i) => ({
                u: "https://example.com/" + i,
                ti: "网页",
                active: i === 0,
              })),
            ],
          },
        ],
        last: visit("https://example.com/#a"),
      },
      [],
    );
    expect(slot.windows[0].tabs).toHaveLength(200);
    expect(slot.last?.u).toBe("https://example.com/");
    expect(
      safeSlot(
        { windows: [], last: visit("https://example.com/?password=x") },
        [],
      ).last,
    ).toBeUndefined();
  });
});
describe("continuity indexed storage", () => {
  it("enriches a local visit in place and updates its text and search index", async () => {
    const [original] = await db.visits("a", [visit(undefined, now, "")]);
    const updated = await db.visits("a", [
      visit(undefined, now + 2000, "接力测试网页"),
    ]);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      id: original.id,
      at: original.at,
      ti: "接力测试网页",
    });
    expect(await db.all("visits")).toHaveLength(1);
    expect((await db.query({ query: "接力测试" })).items[0].id).toBe(
      original.id,
    );
    expect(updated[0].text).toContain("接力测试网页");
    expect(updated[0].terms).toContain("接力测");
  });
  it("enriches remote visits without duplicates, preserving record-id idempotence", async () => {
    const first = {
      id: "empty",
      seq: 1,
      t: "hv",
      dev: "a",
      at: now,
      v: [visit(undefined, now, "")],
    };
    await db.apply(first, "b");
    const second = {
      ...first,
      id: "title",
      seq: 2,
      at: now + 30000,
      v: [visit(undefined, now, "接力测试网页")],
    };
    // Reusing an already applied journal record id must not alter its contents.
    await db.apply({ ...second, id: first.id }, "b");
    expect((await db.query()).items[0].ti).toBe("");
    await db.apply(second, "b");
    await db.apply(second, "b");
    const page = await db.query({ query: "接力测试" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      ti: "接力测试网页",
      at: now,
      dev: "a",
    });
    expect(await db.all("visits")).toHaveLength(1);
  });
  it("upgrades URL placeholders but never overwrites an existing real title", async () => {
    const u = "https://example.com/";
    await db.visits("a", [visit(u, now, u)]);
    expect(await db.visits("a", [visit(u, now, "真实标题")])).toHaveLength(1);
    for (const ti of ["", " ", u, "后来的标题"])
      expect(await db.visits("a", [visit(u, now, ti)])).toHaveLength(0);
    await db.apply(
      {
        id: "empty-remote",
        seq: 1,
        t: "hv",
        dev: "a",
        at: now,
        v: [visit(u, now, "")],
      },
      "b",
    );
    expect((await db.query()).items[0].ti).toBe("真实标题");
    expect(await db.all("visits")).toHaveLength(1);
  });
  it("uses deterministic minute ids and merges repeated visits within 60 seconds across minute boundaries", async () => {
    const at = Math.floor(now / 60000) * 60000 + 59000;
    await db.visits("a", [
      visit(undefined, at),
      visit(undefined, at + 2000),
      visit(undefined, at + 61000),
    ]);
    await db.visits("b", [visit(undefined, at)]);
    const all = await db.all<Visit>("visits");
    expect(all).toHaveLength(3);
    expect(await visitId("a", "https://example.com/", at)).toMatch(
      /^[\w-]{22}$/,
    );
    expect(await visitId("a", "https://example.com/", at)).toBe(
      await visitId("a", "https://example.com/", at),
    );
  });
  it("retention cleans history at 30/90 days and inbox at seven days", async () => {
    await db.visits("a", [
      visit(undefined, now - 31 * 86400000),
      visit("https://other.com/", now - 89 * 86400000),
      visit("https://new.com/", now),
    ]);
    await db.put("inbox", "old", { at: now - 8 * 86400000 });
    await db.clean(90, now);
    expect(await db.all("visits")).toHaveLength(3);
    expect(await db.all("inbox")).toHaveLength(0);
    await db.clean(30, now);
    expect(await db.all("visits")).toHaveLength(1);
  });
  it("propagates self/all deletion and blocks late replay, including after a new adapter opens", async () => {
    const hv: JournalRecord = {
      id: "h1",
      seq: 1,
      t: "hv",
      dev: "a",
      at: now,
      v: [visit()],
    };
    await db.apply(hv, "b");
    await db.visits("b", [visit()]);
    await db.apply(
      {
        id: "d1",
        seq: 2,
        t: "hd",
        dev: "a",
        at: now + 1,
        scope: "self",
        range: { from: 0, to: now },
      },
      "b",
    );
    expect((await db.all<Visit>("visits")).map((v) => v.dev)).toEqual(["b"]);
    const second = new ContinuityDB("test");
    await second.apply({ ...hv, id: "h-replay", seq: 3 }, "b");
    expect(await second.all("visits")).toHaveLength(1);
    await second.apply(
      {
        id: "d2",
        seq: 4,
        t: "hd",
        dev: "a",
        at: now + 2,
        scope: "all",
        range: { from: 0, to: now },
      },
      "b",
    );
    expect(await second.all("visits")).toHaveLength(0);
  });
  it("deletes selected ids only and delivers each journal record once", async () => {
    const records = [visit(), visit("https://another.com/")];
    const hv = { id: "r", seq: 1, t: "hv", dev: "a", at: now, v: records };
    await db.apply(hv, "b");
    await db.apply(hv, "b");
    expect(await db.all("visits")).toHaveLength(2);
    const id = await visitId("a", records[0].u, records[0].at);
    await db.deleteVisits({
      id: "delete",
      dev: "b",
      at: now + 1,
      ids: [id],
      scope: "all",
    });
    expect((await db.all<Visit>("visits"))[0].u).toBe("https://another.com/");
  });
  it("searches case insensitively in Chinese titles and URLs, with device filtering and pagination", async () => {
    await db.visits("a", [
      visit("https://docs.example.com/", now, "设计规范"),
      visit("https://other.example.com/", now - 61000, "其他"),
      visit("https://third.example.com/", now - 122000, "设计资料"),
    ]);
    await db.visits("b", [visit("https://b.example.com/", now, "设计灵感")]);
    expect((await db.query({ query: "设计" })).items).toHaveLength(3);
    expect((await db.query({ query: "DOCS.EXAMPLE" })).items[0].ti).toBe(
      "设计规范",
    );
    expect(
      (await db.query({ query: "设计", others: true }, "a")).items[0].dev,
    ).toBe("b");
    const page = await db.query({ dev: "a", limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.next).toBeDefined();
    expect(
      (await db.query({ dev: "a", limit: 2, before: page.next })).items,
    ).toHaveLength(1);
    expect((await db.query({ query: "无匹配" })).items).toHaveLength(0);
  });
  it("only stores incoming messages addressed to self and persists read acknowledgements", async () => {
    const record = {
      id: "send",
      seq: 1,
      t: "snd",
      dev: "a",
      at: now,
      to: "b",
      k: "url",
      u: "https://example.com",
      ti: "网页",
    };
    await db.apply(record, "c");
    expect(await db.all("inbox")).toHaveLength(0);
    await db.apply({ ...record, id: "send-b" }, "b");
    await db.apply(
      { id: "ack", seq: 2, t: "ack", dev: "b", at: now, ref: "send-b" },
      "b",
    );
    expect(await db.get("inbox", "send-b")).toMatchObject({ read: true });
  });
  it("caches per-device slots and image blobs in IndexedDB", async () => {
    await db.setSlots([{ dev: "a", at: now, payload: { windows: [] } }]);
    expect(await new ContinuityDB("test").all("slots")).toHaveLength(1);
    await db.put("blobs", "image", new Uint8Array([1, 2, 3]));
    expect(await db.get("blobs", "image")).toEqual(new Uint8Array([1, 2, 3]));
  });
});
describe("virtual history rows", () => {
  it("renders a bounded window for ten thousand rows, including day headings", () => {
    const heights = [28, ...Array.from({ length: 10000 }, () => 44)];
    const middle = virtualWindow(heights, 44000, 600);
    expect(middle.end - middle.start).toBeLessThan(30);
    expect(middle.start).toBeGreaterThan(900);
    expect(middle.total).toBe(440028);
    expect(virtualWindow(heights, 0, 600).start).toBe(0);
    const end = virtualWindow(heights, 440000, 600);
    expect(end.end).toBe(10001);
  });
});
