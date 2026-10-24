import { nativeCall } from "./native";
export interface BrowserPrefs {
  isDefault: boolean;
  darkMode: "follow" | "on" | "off";
  darkSupported: boolean;
  textZoom: number;
}
let current: BrowserPrefs | null = null;
const listeners = new Set<() => void>();
export const browserPrefs = {
  get: () => current,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  refresh() {
    try {
      const raw = nativeCall("getBrowserPrefs");
      const data = typeof raw === "string" ? JSON.parse(raw) : null;
      current =
        data &&
        typeof data.isDefault === "boolean" &&
        typeof data.darkSupported === "boolean" &&
        ["follow", "on", "off"].includes(data.darkMode) &&
        Number.isFinite(data.textZoom)
          ? { ...data, textZoom: Math.min(150, Math.max(80, data.textZoom)) }
          : null;
    } catch {
      current = null;
    }
    listeners.forEach((fn) => fn());
  },
  setDarkMode(mode: BrowserPrefs["darkMode"]) {
    nativeCall("setWebDarkMode", mode);
    this.refresh();
  },
  setTextZoom(value: number) {
    nativeCall(
      "setTextZoom",
      Math.min(150, Math.max(80, Math.round(value / 10) * 10)),
    );
    this.refresh();
  },
};
