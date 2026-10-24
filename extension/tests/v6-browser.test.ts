import { afterEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { AmbientClock } from "../src/lib/ambient";
import { addReadLater } from "../src/lib/read-later";
import { defaults } from "../src/lib/model";
import { browserPrefs } from "../src/platform/browser-prefs";
import { pairQr } from "../src/features/pairing/PairQr";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("Android ambient clock", () => {
  it("uses one timer, at most 30Hz and six layers; no writes after 21.2s", async () => {
    vi.useFakeTimers();
    const clock = new AmbientClock(() => Date.now());
    const layers = Array.from({ length: 6 }, () => vi.fn());
    layers.forEach((draw) => clock.register({} as Element, draw));
    expect(vi.getTimerCount()).toBe(1);
    expect(() => clock.register({} as Element, vi.fn())).toThrow("budget");
    await vi.advanceTimersByTimeAsync(1000);
    expect(layers[0].mock.calls.length - 1).toBeLessThanOrEqual(30);
    await vi.advanceTimersByTimeAsync(21000);
    const phase = clock.snapshot().phase;
    expect(phase).toBeCloseTo(20600, 4);
    expect(clock.snapshot().running).toBe(false);
    const calls = layers[0].mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(layers[0]).toHaveBeenCalledTimes(calls);
    clock.wake();
    expect(clock.snapshot().phase).toBe(phase);
    await vi.advanceTimersByTimeAsync(100);
    expect(clock.snapshot().phase - phase).toBeLessThan(101);
    clock.configure({ visible: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("decelerates continuously, pauses immediately and smooth-first stops its timer", async () => {
    vi.useFakeTimers();
    const clock = new AmbientClock(() => Date.now()), values: number[] = [];
    clock.register({} as Element, (time) => values.push(time));
    await vi.advanceTimersByTimeAsync(22000);
    const deltas = values.slice(1).map((v, i) => v - values[i]);
    expect(deltas.every((v) => v >= 0 && v < 35)).toBe(true);
    expect(deltas.at(-1)).toBeLessThan(1);
    clock.wake();
    clock.configure({ enabled: false });
    const at = clock.snapshot().phase;
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.snapshot().phase).toBe(at);
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("read later and local browser preferences", () => {
  it("appends one group; normalized duplicates in that group return the original record", () => {
    const data = defaults(), oldCount = data.groups.length;
    const first = addReadLater(data, { url: "https://EXAMPLE.com:443/#one", title: "中文文章" }, 10);
    const second = addReadLater(data, { url: "https://example.com#two", title: "不覆盖" }, 20);
    expect(second).toEqual(first);
    expect(data.groups).toHaveLength(oldCount + 1);
    expect(data.groups.at(-1)?.name).toBe("稍后阅读");
    expect(data.bookmarks.filter((b) => b.groupId === first.groupId)).toHaveLength(1);
    expect(data.bookmarks.find((b) => b.id === first.id)?.title).toBe("中文文章");
    expect(() => addReadLater(data, { url: "javascript:alert(1)" })).toThrow("INVALID_URL");
  });
  it("does not move a bookmark out of another group", () => {
    const data = defaults(), original = data.bookmarks[0];
    const result = addReadLater(data, original);
    expect(result.id).not.toBe(original.id);
    expect(original.groupId).not.toBe(result.groupId);
  });
  it("reads native prefs, propagates changes; missing/broken native hides the group", () => {
    const value = { isDefault: false, darkMode: "follow", darkSupported: true, textZoom: 100 };
    const setTextZoom = vi.fn((n: number) => { value.textZoom = n; }),
      setWebDarkMode = vi.fn((s: string) => { value.darkMode = s; });
    vi.stubGlobal("window", { KongjingNative: { getBrowserPrefs: () => JSON.stringify(value), setTextZoom, setWebDarkMode } });
    const listener = vi.fn(), off = browserPrefs.subscribe(listener);
    browserPrefs.refresh();
    expect(browserPrefs.get()).toEqual(value);
    browserPrefs.setTextZoom(133);
    expect(setTextZoom).toHaveBeenCalledWith(130);
    browserPrefs.setDarkMode("on");
    expect(setWebDarkMode).toHaveBeenCalledWith("on");
    expect(listener).toHaveBeenCalledTimes(3);
    vi.stubGlobal("window", {});
    browserPrefs.refresh();
    expect(browserPrefs.get()).toBeNull();
    off();
    expect(defaults().settings).not.toHaveProperty("textZoom");
  });
});
it("bundled QR decodes to the exact Kongjing deep link", () => {
  const qr = pairQr("0123456789"), scale = 8, width = qr.size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const match of qr.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((Number(match[2]) * scale + y) * width) + Number(match[1]) * scale + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    }
  }
  expect(jsQR(pixels, width, width)?.data).toBe("kongjing://pair?code=KJ-01234-56789");
});
