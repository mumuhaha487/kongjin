import { afterEach, describe, expect, it, vi } from "vitest";
import { nextClockDelay } from "../src/lib/clock-timer";
import { LayoutBudget } from "../src/lib/layout-budget";
import { orbitFrames, waves } from "../src/components/Background/drawing";
import { cleanSettings, defaults } from "../src/lib/model";
import {
  onPageVisibility,
  pageVisible,
  setNativeVisible,
  visibleTimeout,
} from "../src/lib/visibility";
afterEach(() => {
  setNativeVisible(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("PERF v5", () => {
  it("aligns minute clocks without second polling, and second clocks to seconds", () => {
    expect(nextClockDelay(60_001, false)).toBe(59_999);
    expect(nextClockDelay(120_000, false)).toBe(60_000);
    expect(nextClockDelay(61_234, true)).toBe(766);
  });
  it("never grants more than eight Android projection leases", () => {
    const budget = new LayoutBudget(),
      nodes = Array.from({ length: 100 }, () => Symbol());
    expect(nodes.filter((id) => budget.acquire(id))).toHaveLength(8);
    budget.release(nodes[0]);
    expect(budget.acquire(nodes[99])).toBe(true);
  });
  it("uses 60 closed transform samples, with no repainting animation properties", () => {
    const frames = orbitFrames(1440, 900);
    expect(frames).toHaveLength(61);
    for (const frame of frames)
      expect(Object.keys(frame).sort()).toEqual(["opacity", "transform"]);
    expect(String(frames[0].transform)).toContain("translate(");
    expect(waves).toHaveLength(3);
  });
  it("defaults smooth-first off and migrates existing settings without losing values", () => {
    expect(defaults().settings.smoothFirst).toBe(false);
    const old = defaults().settings;
    delete (old as Partial<typeof old>).smoothFirst;
    expect(cleanSettings(old).smoothFirst).toBe(false);
    expect(cleanSettings({ ...old, smoothFirst: true }).smoothFirst).toBe(true);
  });
  it("combines native and document visibility and suspends UI timeouts", () => {
    vi.useFakeTimers();
    const events = new EventTarget();
    vi.stubGlobal("document", {
      hidden: false,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    vi.stubGlobal("performance", { now: () => Date.now() });
    const listener = vi.fn(),
      unsubscribe = onPageVisibility(listener),
      done = vi.fn();
    visibleTimeout(done, 6000);
    vi.advanceTimersByTime(2000);
    setNativeVisible(false);
    expect(pageVisible()).toBe(false);
    vi.advanceTimersByTime(20000);
    expect(done).not.toHaveBeenCalled();
    setNativeVisible(true);
    vi.advanceTimersByTime(3999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
