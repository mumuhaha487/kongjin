import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeCall, nativeOpen } from "../src/platform/native";
import { createNativeDispatcher } from "../src/platform/bridge";
import { bookmarkKey, findBookmark } from "../src/platform/bookmark-key";
import { defaults } from "../src/lib/model";
import { indexedStorage } from "../src/platform/indexed-storage";
import { IDBFactory } from "fake-indexeddb";
import { ANDROID } from "../src/lib/build";
import { executeSearch } from "../src/features/search/execute";
import {
  browserSettings,
  mobileEngines,
  searchTemplate,
} from "../src/platform/android-settings";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Android native platform", () => {
  it.runIf(ANDROID)(
    "searches even address-like input through native open, without a Chrome API",
    async () => {
      const open = vi.fn();
      vi.stubGlobal("window", { KongjingNative: { open } });
      await executeSearch(
        "空境 接力",
        {
          id: "bing",
          name: "必应",
          url: "https://www.bing.com/search?q=%s",
          updatedAt: 0,
        },
        false,
      );
      expect(open).toHaveBeenLastCalledWith(
        "https://www.bing.com/search?q=%E7%A9%BA%E5%A2%83%20%E6%8E%A5%E5%8A%9B",
        false,
      );
      await executeSearch(
        "example.com/relay",
        {
          id: "bing",
          name: "必应",
          url: "https://www.bing.com/search?q=%s",
          updatedAt: 0,
        },
        true,
      );
      expect(open).toHaveBeenLastCalledWith(
        "https://www.bing.com/search?q=example.com%2Frelay",
        true,
      );
    },
  );
  it("uses Bing by default and keeps native-only options out of synced settings", () => {
    const data = defaults();
    expect(browserSettings.get()).toEqual({
      engine: "bing",
      bookmarkNewTab: false,
    });
    expect(mobileEngines(data).some((e) => e.id === "default")).toBe(false);
    expect(searchTemplate(data)).toBe("https://www.bing.com/search?q=%s");
    expect(data.settings).not.toHaveProperty("bookmarkNewTab");
  });
  it("normalizes native open and rejects unsafe protocols", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { KongjingNative: { open } });
    expect(nativeOpen(" HTTPS://Example.COM:443/path ", true)).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/path",
      true,
    );
    for (const url of [
      "javascript:alert(1)",
      "file:///a",
      "content://host/a",
      "intent://x",
    ])
      expect(nativeOpen(url)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("missing or throwing native interfaces degrade without errors", () => {
    vi.stubGlobal("window", {});
    expect(nativeCall("deviceName")).toBeUndefined();
    vi.stubGlobal("window", {
      KongjingNative: {
        deviceName: () => {
          throw Error();
        },
      },
    });
    expect(nativeCall("deviceName")).toBeUndefined();
  });
  it("native preview fallback never replaces the persistent home", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    nativeOpen("example.com");
    expect(open).toHaveBeenCalledWith(
      "https://example.com/",
      "_blank",
      "noopener,noreferrer",
    );
  });
  it("IndexedDB persists across adapter instances and supports remove", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("BroadcastChannel", undefined);
    const a = indexedStorage("test"),
      b = indexedStorage("test");
    await a.set("data", defaults());
    expect(await b.get("data")).toEqual(defaults());
    await b.remove("data");
    expect(await a.get("data")).toBeUndefined();
  });
});
describe("Native dispatcher", () => {
  it("returns JSON via reply with the original id", async () => {
    const handler = vi.fn().mockResolvedValue([{ id: "a", name: "常用" }]),
      reply = vi.fn();
    const call = createNativeDispatcher(handler, reply);
    expect(await call("42", "getGroups", "{}")).toEqual({
      ok: true,
      data: [{ id: "a", name: "常用" }],
    });
    expect(handler).toHaveBeenCalledWith("getGroups", {});
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      "42",
      JSON.stringify({ ok: true, data: [{ id: "a", name: "常用" }] }),
    );
  });
  it("rejects malformed args and passes method failures", async () => {
    const reply = vi.fn(),
      handler = vi.fn().mockRejectedValue(Error("UNKNOWN_METHOD"));
    const call = createNativeDispatcher(handler, reply);
    expect(await call("a", "x", "[]")).toEqual({
      ok: false,
      error: "INVALID_ARGS",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(await call("b", "x", "{}")).toEqual({
      ok: false,
      error: "UNKNOWN_METHOD",
    });
  });
  it("times out and never replies twice after late resolution", async () => {
    vi.useFakeTimers();
    let finish!: (v: object) => void;
    const reply = vi.fn(),
      call = createNativeDispatcher(
        () =>
          new Promise((r) => {
            finish = r;
          }),
        reply,
      );
    const result = call("id", "slow", "{}");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({ ok: false, error: "TIMEOUT" });
    finish({});
    await vi.runAllTimersAsync();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
describe("normalized bookmark lookup", () => {
  it("handles host case, default port, root slash and fragment", () => {
    const d = defaults();
    d.bookmarks[0].url = "https://EXAMPLE.com:443/";
    expect(findBookmark(d.bookmarks, "example.com#section")?.id).toBe(
      d.bookmarks[0].id,
    );
    expect(bookmarkKey("https://example.com:443/")).toBe(
      "https://example.com/",
    );
  });
  it("keeps meaningful paths, queries, schemes and rejects invalid URL", () => {
    const d = defaults();
    d.bookmarks[0].url = "https://example.com/a?q=1";
    for (const u of [
      "https://example.com/a?q=2",
      "https://example.com/a/",
      "http://example.com/a?q=1",
      "javascript:alert(1)",
    ])
      expect(findBookmark(d.bookmarks, u)).toBeUndefined();
  });
});
