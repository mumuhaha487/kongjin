import { describe, expect, it, vi, afterEach } from "vitest";
import {
  compactDeviceName,
  fittingPills,
} from "../src/features/continuity/device-name";
import { afterPaintIdle } from "../src/lib/after-paint";
const device = (deviceId: string, name: string) => ({ deviceId, name });
describe("compact device names", () => {
  const devices = [
    device("a", "MacBook · Chrome"),
    device("b", "Windows · Chrome"),
    device("c", "Xiaomi 14 · 空境"),
  ];
  it("uses only the prefix before the first spaced middle dot", () => {
    expect(devices.map((d) => compactDeviceName(d.deviceId, devices))).toEqual([
      "MacBook",
      "Windows",
      "Xiaomi 14",
    ]);
    expect(compactDeviceName("d", [device("d", "手机 · 空境 · Android")])).toBe(
      "手机",
    );
    expect(compactDeviceName("d", [device("d", "A·B")])).toBe("A·B");
  });
  it("keeps both full names when prefixes collide, even if longer than twelve characters", () => {
    const same = [...devices, device("d", "MacBook · Safari")];
    expect(compactDeviceName("a", same)).toBe("MacBook · Chrome");
    expect(compactDeviceName("d", same)).toBe("MacBook · Safari");
    expect(compactDeviceName("b", same)).toBe("Windows");
  });
  it("truncates after twelve Unicode characters without breaking surrogate pairs", () => {
    expect(compactDeviceName("d", [device("d", "123456789012 · Chrome")])).toBe(
      "123456789012",
    );
    expect(
      compactDeviceName("d", [device("d", "1234567890123 · Chrome")]),
    ).toBe("123456789012…");
    expect(compactDeviceName("d", [device("d", "😀".repeat(13))])).toBe(
      "😀".repeat(12) + "…",
    );
    expect(compactDeviceName("unknown", devices)).toBe("unknown");
  });
});
describe("one-line send pills", () => {
  it("fits all when possible, otherwise reserves overflow space, preserving order", () => {
    expect(fittingPills([80, 70, 90], 256, 28)).toBe(3);
    expect(fittingPills([80, 70, 90], 255, 28)).toBe(2);
    expect(fittingPills([400, 50], 300, 28)).toBe(0);
    expect(fittingPills([50, 50, 50, 50, 50], 500, 28)).toBe(4);
    expect(fittingPills([], 100, 28)).toBe(0);
  });
});
afterEach(() => vi.unstubAllGlobals());
it("waits until a frame has painted, then schedules idle work with a 1s timeout; supports cancellation", () => {
  const frames: FrameRequestCallback[] = [];
  const idle = vi.fn(),
    task = vi.fn(),
    cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    frames.push(cb),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("requestIdleCallback", idle.mockReturnValue(42));
  vi.stubGlobal("cancelIdleCallback", cancel);
  const dispose = afterPaintIdle(task);
  expect(idle).not.toHaveBeenCalled();
  frames.shift()!(0);
  expect(idle).not.toHaveBeenCalled();
  frames.shift()!(16);
  expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
  dispose();
  idle.mock.calls[0][0]();
  expect(task).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledWith(42);
});
