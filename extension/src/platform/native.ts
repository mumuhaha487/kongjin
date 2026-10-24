import { normalizeUrl } from "../lib/validation";
export interface NativeBridge {
  open(url: string, newTab: boolean): void;
  favicon(url: string): string;
  deviceName(): string;
  appVersion(): string;
  getBrowserPrefs(): string;
  setWebDarkMode(mode: "follow" | "on" | "off"): void;
  setTextZoom(percent: number): void;
  requestDefaultBrowser(): void;
  scanQr(): void;
  haptic(kind: "light" | "success" | "warning"): void;
  setTheme(theme: "light" | "dark"): void;
  setSearchTemplate(template: string): void;
  clearBrowsingData(kinds: string): void;
  ready(): void;
  reply(id: string, json: string): void;
  incoming(json: string): void;
  requestNotificationPermission(): "granted" | "denied";
}
export function androidVersion(homeVersion: string) {
  const app = nativeCall("appVersion");
  return typeof app === "string" && app.trim()
    ? `空境 安卓版 ${app.trim()} · 主页 ${homeVersion}`
    : `主页 ${homeVersion}`;
}
declare global {
  interface Window {
    KongjingNative?: NativeBridge;
  }
}
export function nativeCall<K extends keyof NativeBridge>(
  method: K,
  ...args: Parameters<NativeBridge[K]>
): ReturnType<NativeBridge[K]> | undefined {
  try {
    const bridge =
      typeof window === "undefined" ? undefined : window.KongjingNative;
    const fn = bridge?.[method];
    if (typeof fn === "function")
      return (
        fn as (
          ...values: Parameters<NativeBridge[K]>
        ) => ReturnType<NativeBridge[K]>
      ).apply(bridge, args);
  } catch {
    /* Preview or an unavailable native feature must not break home. */
  }
}
export function nativeOpen(input: string, newTab = false) {
  const url = normalizeUrl(input);
  if (!url) return false;
  if (typeof window !== "undefined" && window.KongjingNative?.open)
    nativeCall("open", url, newTab);
  else if (typeof window !== "undefined")
    window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
