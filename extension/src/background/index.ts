import { setPowActor } from "./pow-proxy";
import { defaults, type AppData } from "../lib/model";
import { migrate } from "../lib/migration";
import { PairController } from "../features/pairing/controller";
import {
  OffscreenController,
  remoteContinuity,
  receiveHostState,
  hostCollect,
  hostNotify,
} from "../offscreen/remote";
import { installDesktopContinuity } from "../features/continuity/desktop";
import { acquireIcon, fillMissingIcons } from "../features/bookmarks/icons";
import { normalizeUrl } from "../lib/validation";
import { STORE } from "../lib/build";
import { appData, withAppDataLock } from "../lib/app-data";
const continuityHost = () => remoteContinuity;
let current: AppData = defaults();
let ready: Promise<void> | undefined;
let controller: PairController | OffscreenController | undefined;
let serial = Promise.resolve();
const visiblePages = new Map<chrome.runtime.Port, boolean>();
function foreground() {
  return [...visiblePages.values()].some(Boolean);
}
if (!STORE)
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "kj:foreground" || port.sender?.id !== chrome.runtime.id)
      return;
    visiblePages.set(port, false);
    const update = () =>
      void init().then(() =>
        controller?.command("foreground", { visible: String(foreground()) }),
      );
    port.onMessage.addListener((message) => {
      visiblePages.set(port, message.visible === true);
      update();
    });
    port.onDisconnect.addListener(() => {
      visiblePages.delete(port);
      update();
    });
  });
function writeApp(task: () => Promise<void>) {
  return withAppDataLock(task);
}
async function commit(data: AppData) {
  await chrome.storage.local.set({ data });
  current = data;
}
function save(data: AppData) {
  return appData.mergeRemote(data).then((committed) => {
    current = committed;
  });
}
async function init() {
  if (!ready)
    ready = (async () => {
      const stored = await chrome.storage.local.get<{
        data?: AppData | { schema: 1 };
        session?: { user?: { username?: string } };
        relayUrl?: string;
      }>(["data", "session", "relayUrl"]);
      current =
        migrate(stored.data, stored.session?.user?.username) || defaults();
      if (JSON.stringify(stored.data) !== JSON.stringify(current))
        await save(current);
      if (stored.data?.schema === 1)
        await chrome.storage.local.set({ v2WelcomePending: true });
      await chrome.storage.local.remove(["session", "server", "syncMeta"]);
      controller = STORE
        ? new PairController(
            () => appData.read(),
            commit,
            (status, pair) => {
              void chrome.runtime
                .sendMessage({ type: "kj:status", status, pair })
                .catch(() => {});
            },
            stored.relayUrl,
          )
        : new OffscreenController();
      await controller.init();
      if (!STORE)
        await controller.command("foreground", {
          visible: String(foreground()),
        });
      if (!STORE) await installDesktopContinuity(remoteContinuity);
      await registerBar();
      void fillMissingIcons(
        () => current,
        (id, icon) => {
          if (!STORE) {
            const url = current.bookmarks.find((b) => b.id === id)?.url;
            void writeApp(async () => {
              const stored = await chrome.storage.local.get<{
                data?: AppData;
              }>("data");
              const latest = migrate(stored.data) || current;
              const bookmark = latest.bookmarks.find((b) => b.id === id);
              if (
                !bookmark ||
                bookmark.url !== url ||
                bookmark.icon.mode !== "auto"
              )
                return;
              // Commit against authoritative storage, not the asynchronous
              // onChanged mirror: an icon response can beat that event.
              bookmark.icon = icon;
              bookmark.updatedAt = Date.now();
              await commit(latest);
              void controller?.notify().catch(() => {});
            });
            return;
          }
          void appData
            .update((data) => {
              const b = data.bookmarks.find((b) => b.id === id);
              if (b) {
                b.icon = icon;
                b.updatedAt = Date.now();
              }
            })
            .then(() => controller?.notify());
        },
        controller.status.relayUrl,
      );
    })();
  return ready;
}
function allowedPage(url: string) {
  try {
    const u = new URL(url);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !/(^|\.)(chromewebstore\.google\.com|chrome\.google\.com|microsoftedge\.microsoft\.com)$/.test(
        u.hostname,
      )
    );
  } catch {
    return false;
  }
}
let barRegistration = Promise.resolve();
export function registerBar() {
  const task = barRegistration.catch(() => {}).then(applyBarRegistration);
  barRegistration = task;
  return task;
}
async function applyBarRegistration() {
  if (!(await chrome.permissions.contains({ permissions: ["scripting"] }))) return;
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const enabled =
    current.settings.barEnabled &&
    (await chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] }));
  if (!enabled) {
    if (scripts.some((s) => s.id === "kongjing-bar"))
      await chrome.scripting.unregisterContentScripts({
        ids: ["kongjing-bar"],
      });
    return;
  }
  if (!scripts.some((s) => s.id === "kongjing-bar"))
    await chrome.scripting.registerContentScripts([
      {
        id: "kongjing-bar",
        js: ["bar.js"],
        matches: ["http://*/*", "https://*/*"],
        excludeMatches: [
          "https://chromewebstore.google.com/*",
          "https://chrome.google.com/webstore/*",
          "https://microsoftedge.microsoft.com/addons/*",
        ],
        runAt: "document_idle",
        allFrames: false,
      },
    ]);
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => t.id && allowedPage(t.url || ""))
      .map((t) =>
        chrome.scripting
          .executeScript({ target: { tabId: t.id! }, files: ["bar.js"] })
          .catch(() => {}),
      ),
  );
}
async function unreadBadge() {
  const state = await continuityHost().state(),
    count = state.inbox.filter((item) => !item.read).length;
  if (!count) return false;
  await chrome.action.setBadgeBackgroundColor({ color: "#2F6CEB" });
  await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  await chrome.action.setBadgeText({ text: String(count) });
  return true;
}
async function badge(exists: boolean) {
  if (!STORE && (await unreadBadge())) return;
  await chrome.action.setBadgeBackgroundColor({ color: "#1F9D63" });
  await chrome.action.setBadgeText({ text: exists ? "•" : "✓" });
  setTimeout(() => {
    if (STORE) void chrome.action.setBadgeText({ text: "" });
    else
      void unreadBadge().then((unread) => {
        if (!unread) void chrome.action.setBadgeText({ text: "" });
      });
  }, 1500);
}
async function bookmark(
  url: string,
  title: string,
  groupId?: string,
  first?: string,
) {
  await init();
  if (!allowedPage(url)) return { error: "这个页面无法收藏" };
  const normalized = normalizeUrl(url)!;
  let existing: AppData["bookmarks"][number] | undefined;
  let createdId: string | undefined;
  current = await appData.update((data) => {
    existing = data.bookmarks.find(
      (b) => b.url.replace(/\/$/, "") === normalized.replace(/\/$/, ""),
    );
    const now = Date.now();
    if (!existing) {
      const group =
        data.groups.find((g) => g.id === groupId)?.id ||
        data.groups.find((g) => g.id === data.settings.quickGroup)?.id ||
        data.groups[0].id;
      const b = {
        id: crypto.randomUUID(),
        url: normalized,
        title: title || new URL(url).hostname,
        groupId: group,
        order: data.bookmarks.filter((b) => b.groupId === group).length,
        icon: { mode: "auto" as const },
        createdAt: now,
        updatedAt: now,
      };
      data.bookmarks.push(b);
      createdId = b.id;
    }
  });
  await controller?.notify();
  if (createdId) {
    void acquireIcon(url, controller?.status.relayUrl, first).then((icon) => {
      return appData
        .update((data) => {
          const found = data.bookmarks.find((x) => x.id === createdId);
          if (found?.url === normalized && found.icon.mode === "auto") {
            found.icon = icon;
            found.updatedAt = Date.now();
          }
        })
        .then(() => controller?.notify());
    });
  }
  await badge(!!existing);
  return {
    ok: true,
    exists: !!existing,
    group:
      current.groups.find(
        (g) =>
          g.id ===
          (existing?.groupId || groupId || current.settings.quickGroup),
      )?.name || current.groups[0].name,
  };
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "kj-page",
      title: "收藏此页到空境",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "kj-link",
      title: "将链接收藏到空境",
      contexts: ["link"],
    });
    if (!STORE)
      void init().then(async () => {
        continuityHost().rebuildMenus?.();
      });
  });
  void chrome.alarms.create("kj-wake", { periodInMinutes: 1 });
  void init();
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "kj-page" && info.menuItemId !== "kj-link") return;
  serial = serial
    .then(() =>
      bookmark(
        info.linkUrl || tab?.url || "",
        info.linkUrl || tab?.title || "",
        undefined,
        tab?.favIconUrl,
      ),
    )
    .then(() => {})
    .catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    !message ||
    typeof message.type !== "string" ||
    sender.id !== chrome.runtime.id
  )
    return;
  if (!STORE && message.type === "kj:status") {
    (controller as OffscreenController | undefined)?.update(
      message.status,
      message.pair,
    );
    return;
  }
  if (
    [
      "kj:status",
      "kj:pow",
      "kj:pow-cancel",
      "kj:host-rpc",
      "kj:host-storage-changed",
    ].includes(message.type)
  )
    return;
  if (!STORE && message.type === "kj:continuity-state") {
    receiveHostState(message.state);
    return;
  }
  const task = async () => {
    if (message.type === "kj:hello") return { documentId: sender.documentId };
    if (
      !STORE &&
      message.type === "kj:host-storage" &&
      sender.url === chrome.runtime.getURL("offscreen.html")
    ) {
      if (message.action === "get")
        return {
          value: (await chrome.storage.local.get(message.key))[message.key],
        };
      if (message.action === "set")
        await chrome.storage.local.set({ [message.key]: message.value });
      if (message.action === "remove")
        await chrome.storage.local.remove(message.key);
      return {};
    }
    if (!STORE && message.type === "kj:host-collect")
      return hostCollect(message.key, message.enabled);
    if (!STORE && message.type === "kj:host-notify")
      return hostNotify(message.item);
    await init();
    if (message.type === "kj:local-committed") {
      await controller?.notify();
      return { ok: true };
    }
    if (message.type === "kj:remove-bookmark") {
      current = await appData.update((data) => {
        data.bookmarks = data.bookmarks.filter((b) => b.id !== message.id);
        data.tombstones.push({
          id: String(message.id),
          kind: "bookmark",
          deletedAt: Date.now(),
        });
      });
      await controller?.notify();
      return { ok: true };
    }
    if (!STORE && message.type === "kj:continuity") {
      return continuityHost().execute(message.action, message.args);
    }
    if (message.type === "kj:pair") {
      setPowActor(sender.documentId);
      const response = await controller!.command(message.action, message.args);
      if (message.action === "relay" && !controller!.status.paired)
        await chrome.storage.local.set({
          relayUrl: controller!.status.relayUrl,
        });
      return {
        ...response,
        status: controller!.status,
        pair: controller!.pair,
      };
    }
    if (message.type === "kj:page-state")
      return {
        id: current.bookmarks.find(
          (b) =>
            b.url.replace(/\/$/, "") === sender.tab?.url?.replace(/\/$/, ""),
        )?.id,
      };
    if (message.type === "kj:collect")
      return bookmark(
        message.url,
        message.title,
        message.groupId,
        message.favicon,
      );
    if (message.type === "kj:open") {
      if (allowedPage(message.url))
        await chrome.tabs.create({ url: message.url, active: false });
      return { ok: true };
    }
    if (message.type === "kj:settings") {
      await chrome.storage.local.set({
        openSettings: message.section || "bar",
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
      return { ok: true };
    }
    if (message.type === "kj:hide") {
      const host = sender.tab?.url
        ? new URL(sender.tab.url).hostname
        : message.host;
      if (host) {
        current = await appData.update((data) => {
          if (!data.settings.hiddenSites.includes(host)) {
            data.settings.hiddenSites.push(host);
            data.settings.updatedAt = Date.now();
          }
        });
        controller?.notify();
      }
      return { ok: true };
    }
    return {};
  };
  void task()
    .then(respond)
    .catch((error) => {
      if (!STORE) console.error("空境后台请求失败", error);
      respond({ error: "NETWORK" });
    });
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (!STORE && area === "local")
    for (const [key, change] of Object.entries(changes))
      void chrome.runtime
        .sendMessage({
          type: "kj:host-storage-changed",
          key,
          value: change.newValue,
        })
        .catch(() => {});
  if (area !== "local" || !changes.data) return;
  const data = migrate(changes.data.newValue);
  if (!data) return;
  const barChanged = current.settings.barEnabled !== data.settings.barEnabled,
    changed = JSON.stringify(current) !== JSON.stringify(data);
  current = data;
  void init().then(() => {
    if (changed) void controller?.notify().catch(() => {});
    if (barChanged) void registerBar();
  });
});
chrome.permissions.onRemoved.addListener(() => void init().then(registerBar));
chrome.permissions.onAdded.addListener(() => void init().then(registerBar));
chrome.alarms.onAlarm.addListener(
  () =>
    void init().then(() => {
      if (STORE) return controller?.command("sync");
    }),
);
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-bar")
      void chrome.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
          if (tabs[0]?.id)
            void chrome.tabs
              .sendMessage(tabs[0].id, { type: "kj:toggle-bar" })
              .catch(() => {});
        });
  });
void init();
