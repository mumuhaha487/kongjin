import { builtins, type AppData } from "../lib/model";
import { storage } from "../lib/storage";
import { nativeCall } from "./native";
export interface BrowserSettings {
  engine: string;
  bookmarkNewTab: boolean;
}
let current: BrowserSettings = { engine: "bing", bookmarkNewTab: false };
const listeners = new Set<() => void>();
export const browserSettings = {
  get: () => current,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  async load() {
    current = {
      ...current,
      ...(await storage.get<BrowserSettings>("browser")),
    };
    listeners.forEach((fn) => fn());
  },
  async set(value: Partial<BrowserSettings>) {
    current = { ...current, ...value };
    await storage.set("browser", current);
    listeners.forEach((fn) => fn());
  },
};
export function mobileEngines(data: AppData) {
  return [...builtins.filter((e) => e.id !== "default"), ...data.searchEngines];
}
export function searchTemplate(data: AppData) {
  return (
    mobileEngines(data).find((e) => e.id === current.engine) ||
    builtins.find((e) => e.id === "bing")!
  ).url;
}
export function syncNativeSearch(data: AppData) {
  nativeCall("setSearchTemplate", searchTemplate(data));
}
