import { readFile } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
export const version = "2.4.0";
export const storeVersion = "2.1.0";
export async function createManifest(store = false) {
  return {
    manifest_version: 3,
    name: "空境 · 新标签页",
    short_name: "空境",
    version: store ? storeVersion : version,
    description:
      "空境——安静的新标签页：时钟、搜索、书签，以及端到端加密的多设备同步。",
    permissions: store
      ? ["storage", "favicon", "activeTab", "contextMenus", "alarms", "search"]
      : [
          "storage",
          "favicon",
          "activeTab",
          "contextMenus",
          "scripting",
          "alarms",
          "search",
          "offscreen",
        ],
    host_permissions: ["https://kongjing.inc.re/*"],
    ...(store ? { optional_host_permissions: ["https://*/*", "http://*/*"], optional_permissions: ["scripting"] } : {}),
    ...(!store
      ? {
          optional_host_permissions: ["<all_urls>"],
          optional_permissions: ["history", "tabs", "notifications"],
          key: createPublicKey(
            await readFile(new URL("../../keys/shiguang.pem", import.meta.url)),
          )
            .export({ type: "spki", format: "der" })
            .toString("base64"),
        }
      : {}),
    action: {
      default_popup: "popup.html",
      default_title: "空境 · 快速收藏",
      default_icon: { 16: "icons/16.png", 32: "icons/32.png" },
    },
    background: { service_worker: "background.js", type: "module" },
    commands: {
      _execute_action: { suggested_key: { default: "Alt+K" } },
      "toggle-bar": {
        suggested_key: { default: "Alt+J" },
        description: "展开或收起空境栏",
      },
    },
    chrome_url_overrides: { newtab: "index.html" },
    icons: Object.fromEntries(
      [16, 32, 48, 128].map((n) => [n, `icons/${n}.png`]),
    ),
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; base-uri 'self'",
    },
    minimum_chrome_version: "111",
  };
}
