import { afterEach, expect, it, vi } from "vitest";
import { executeSearch } from "../src/features/search/execute";
import { searchPlaceholder } from "../src/features/search/placeholder";
import { builtins } from "../src/lib/model";
import { ANDROID, STORE } from "../src/lib/build";
afterEach(() => vi.unstubAllGlobals());
it.each([
  "baidu.com",
  "https://baidu.com",
  "baidu.com是什么网站",
  "www.baidu.com/s?wd=天气",
  "localhost:3000",
  "192.168.1.1",
  "hello world",
  "kongjing.inc.re",
  "a.b",
  "中文.中国",
])("always searches the complete homepage input: %s", async (text) => {
  const query = vi.fn().mockResolvedValue(undefined),
    open = vi.fn(),
    assign = vi.fn();
  vi.stubGlobal("chrome", { runtime: { id: "test" }, search: { query } });
  vi.stubGlobal("window", { KongjingNative: { open }, location: { assign } });
  const engine = builtins.find((e) => e.id === "bing")!;
  await executeSearch(text, engine, false);
  if (STORE) {
    expect(query).toHaveBeenCalledExactlyOnceWith({
      text,
      disposition: "CURRENT_TAB",
    });
    expect(assign).not.toHaveBeenCalled();
  } else {
    const url = engine.url.replace("%s", encodeURIComponent(text));
    if (ANDROID) expect(open).toHaveBeenCalledExactlyOnceWith(url, false);
    else expect(assign).toHaveBeenCalledExactlyOnceWith(url);
    expect(query).not.toHaveBeenCalled();
  }
});
it("removes address wording while retaining Chinese/Latin engine spacing", () => {
  expect(searchPlaceholder("默认搜索", "default")).toBe("搜索");
  expect(searchPlaceholder("必应")).toBe("在必应中搜索");
  expect(searchPlaceholder("Google")).toBe("在 Google 中搜索");
});
