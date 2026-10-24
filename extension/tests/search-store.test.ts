import { afterEach, describe, expect, it, vi } from "vitest";
import { defaults, builtins } from "../src/lib/model";
import { migrate } from "../src/lib/migration";
import { merge } from "../src/lib/merge";
import { backupObject, decodeBackup, encodeBackup } from "../src/lib/backup";
import { executeSearch } from "../src/features/search/execute";
import { searchPlaceholder } from "../src/features/search/placeholder";
import { ANDROID, STORE } from "../src/lib/build";
afterEach(() => vi.unstubAllGlobals());
describe.skipIf(ANDROID)(
  "browser default search (desktop Chrome API contract)",
  () => {
    it.each([false, true])(
      "uses Chrome search disposition newTab=%s",
      async (newTab) => {
        const query = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("chrome", { runtime: { id: "test" }, search: { query } });
        await executeSearch(" 空境 测试 ", builtins[0], newTab);
        expect(query).toHaveBeenCalledExactlyOnceWith({
          text: "空境 测试",
          disposition: newTab ? "NEW_TAB" : "CURRENT_TAB",
        });
      },
    );
    it("searches address-like inputs, with temporary engines only outside the store edition", async () => {
      const query = vi.fn().mockResolvedValue(undefined),
        assign = vi.fn(),
        open = vi.fn();
      vi.stubGlobal("chrome", { runtime: { id: "test" }, search: { query } });
      vi.stubGlobal("window", { location: { assign }, open });
      await executeSearch("example.com/page", builtins[0], false);
      expect(query).toHaveBeenCalledWith({
        text: "example.com/page",
        disposition: "CURRENT_TAB",
      });
      expect(assign).not.toHaveBeenCalled();
      await executeSearch("空境", builtins[1], true);
      if (STORE) {
        expect(query).toHaveBeenCalledWith({
          text: "空境",
          disposition: "NEW_TAB",
        });
        expect(open).not.toHaveBeenCalled();
      } else
        expect(open).toHaveBeenCalledWith(
          "https://www.google.com/search?q=%E7%A9%BA%E5%A2%83",
          "_blank",
          "noopener,noreferrer",
        );
    });
    it("never falls back to a vendor search in an extension with a missing API", async () => {
      const assign = vi.fn();
      vi.stubGlobal("chrome", { runtime: { id: "test" } });
      vi.stubGlobal("window", { location: { assign } });
      await expect(executeSearch("空境", builtins[0], false)).rejects.toThrow();
      expect(assign).not.toHaveBeenCalled();
    });
    it("only preview falls back with a debug message", async () => {
      vi.stubGlobal("chrome", undefined);
      const assign = vi.fn(),
        debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      vi.stubGlobal("window", { location: { assign } });
      await executeSearch("空境", builtins[0], false);
      expect(assign).toHaveBeenCalledWith(
        "https://www.bing.com/search?q=%E7%A9%BA%E5%A2%83",
      );
      expect(debug).toHaveBeenCalledTimes(1);
      debug.mockRestore();
    });
    it("uses a generic placeholder only for the browser default entry", () => {
      expect(searchPlaceholder("默认搜索", "default")).toBe("搜索");
      expect(searchPlaceholder("默认搜索", "custom")).toBe("在默认搜索中搜索");
    });
  },
);
it("removes legacy defaults across migration, imported backups, merge and export", async () => {
  const old = defaults();
  Object.assign(old.settings, { engine: "google" });
  expect(migrate(old)!.settings).not.toHaveProperty("engine");
  expect(merge(defaults(), old).settings).not.toHaveProperty("engine");
  expect(backupObject(old).data.settings).not.toHaveProperty("engine");
  expect(
    (await decodeBackup(JSON.stringify(old))).data.settings,
  ).not.toHaveProperty("engine");
  expect(
    (await decodeBackup(await encodeBackup(old))).data.settings,
  ).not.toHaveProperty("engine");
  expect(defaults().settings).not.toHaveProperty("engine");
});
it("imports a real schema 1 saved engine without restoring it and retains custom engines", async () => {
  const old = defaults();
  old.searchEngines = [
    {
      id: "custom",
      name: "自定义",
      url: "https://example.com/?q=%s",
      updatedAt: 1,
    },
  ];
  const legacy = {
    ...old,
    schema: 1,
    profile: undefined,
    settings: {
      ...old.settings,
      accent: "glacier",
      background: "aurora",
      engine: "google",
    },
    bookmarks: old.bookmarks.map(({ icon: _icon, ...bookmark }) => bookmark),
  };
  const imported = (await decodeBackup(JSON.stringify(legacy))).data;
  expect(imported.settings).not.toHaveProperty("engine");
  expect(imported.settings.accent).toBe("sky");
  expect(imported.searchEngines).toEqual(old.searchEngines);
});
