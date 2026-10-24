import { ANDROID } from "./build";
import { nativeCall } from "../platform/native";
export function deviceLabel() {
  if (ANDROID) return nativeCall("deviceName") || "Android · 空境";
  const ua = navigator.userAgent,
    os = /Android/i.test(ua)
      ? "Android"
      : /iPhone|iPad/i.test(ua)
        ? "iPhone"
        : /Macintosh|Mac OS/i.test(ua)
          ? "MacBook"
          : /Windows/i.test(ua)
            ? "Windows"
            : "Linux",
    browser = /Edg\//.test(ua) ? "Edge" : "Chrome";
  return os + " · " + browser;
}
