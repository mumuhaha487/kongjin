import { expect, it, vi } from "vitest";
import { foregroundPort } from "../src/features/pairing/foreground";

it("resends visibility after MV3 worker sleep and stops reconnecting after page close", () => {
  vi.useFakeTimers();
  try {
    let visible = true;
    let visibilityChanged = () => {};
    const ports: { postMessage: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; close: () => void }[] = [];
    const connect = vi.fn(() => {
      const port = { postMessage: vi.fn(), disconnect: vi.fn(), close: () => {} };
      ports.push(port);
      return { ...port, onDisconnect: { addListener: (cb: () => void) => { port.close = cb; } } } as unknown as chrome.runtime.Port;
    });
    const unsubscribe = vi.fn();
    const dispose = foregroundPort(connect, () => visible, (cb) => { visibilityChanged = cb; return unsubscribe; });
    expect(ports[0].postMessage).toHaveBeenLastCalledWith({ visible: true });
    ports[0].close();
    visible = false;
    vi.advanceTimersByTime(100);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ports[1].postMessage).toHaveBeenLastCalledWith({ visible: false });
    visible = true; visibilityChanged();
    expect(ports[1].postMessage).toHaveBeenLastCalledWith({ visible: true });
    dispose(); ports[1].close(); vi.advanceTimersByTime(1000);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
