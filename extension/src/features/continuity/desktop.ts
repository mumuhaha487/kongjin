import type { ContinuityService } from "./service";
import { recordableUrl } from "./privacy";
import { normalizeUrl } from "../../lib/validation";
import type { Incoming } from "./types";
import { HistoryTitleCollector } from "./history-collector";
import { LateHistoryTitles } from "./late-history-title";
const sendMenu = "kj-send-device";
export async function installDesktopContinuity(service: ContinuityService) {
  let tabsAllowed = await chrome.permissions.contains({
    permissions: ["tabs"],
  });
  const lateTitles = new LateHistoryTitles({
    enabled: () =>
      service.options.history && service.options.tabs && tabsAllowed,
    normalize: (url) => recordableUrl(url, service.options.excluded),
    record: (visits) => service.recordVisits(visits, true),
  });
  const historyTitles = new HistoryTitleCollector({
    enabled: () => service.options.history,
    normalize: (url) => recordableUrl(url, service.options.excluded),
    search: (query) => chrome.history.search(query),
    record: (visits) => service.recordVisits(visits, true),
  });
  let tabsTimer: ReturnType<typeof setTimeout>,
    lastMenus = "";
  // onInstalled removes the old menu tree before recreating bookmark entries.
  // Force one reconciliation after that asynchronous operation has completed.
  service.rebuildMenus = () => {
    lastMenus = "";
    void service.publish();
  };
  const permissions = {
    history: "history",
    tabs: "tabs",
    incoming: "notifications",
  } as const;
  const collectTabs = async () => {
    if (
      !service.options.tabs ||
      !(await chrome.permissions.contains({ permissions: ["tabs"] }))
    )
      return;
    const tabs = (await chrome.tabs.query({})).filter((t) => !t.incognito);
    const focused = await chrome.windows.getLastFocused();
    const windows = [...new Set(tabs.map((t) => t.windowId))].map(
      (windowId) => ({
        focused: windowId === focused.id,
        tabs: tabs
          .filter((t) => t.windowId === windowId && t.url)
          .map((t) => ({ u: t.url!, ti: t.title || "", active: !!t.active })),
      }),
    );
    const active = tabs.find((t) => t.windowId === focused.id && t.active);
    await service.setOpenTabs({
      windows,
      ...(active?.url
        ? { last: { u: active.url, ti: active.title || "", at: Date.now() } }
        : {}),
    });
  };
  const scheduleTabs = () => {
    clearTimeout(tabsTimer);
    tabsTimer = setTimeout(() => void collectTabs().catch(() => {}), 3000);
  };
  const backfill = async () => {
    if (
      !service.options.history ||
      !(await chrome.permissions.contains({ permissions: ["history"] }))
    )
      return;
    const visits = await chrome.history.search({
      text: "",
      startTime: Date.now() - 30 * 86400000,
      maxResults: 5000,
    });
    await service.recordVisits(
      visits.flatMap((v) =>
        v.url && v.lastVisitTime
          ? [{ u: v.url, ti: v.title || "", at: v.lastVisitTime }]
          : [],
      ),
    );
  };
  service.setCollector(async (key, enabled) => {
    const permission = permissions[key];
    if (enabled) {
      if (
        !(await chrome.permissions.contains({ permissions: [permission] })) &&
        !(await chrome.permissions.request({ permissions: [permission] }))
      )
        return false;
      if (key === "tabs") tabsAllowed = true;
      installOptionalListeners();
      // The option is committed after authorization; start collection on the next task.
      setTimeout(() => {
        if (key === "history") void backfill();
        if (key === "tabs") scheduleTabs();
      }, 0);
    } else {
      if (key === "history") historyTitles.cancel();
      if (key === "history" || key === "tabs") lateTitles.cancel();
      if (key === "tabs") tabsAllowed = false;
      await chrome.permissions.remove({ permissions: [permission] });
    }
    return true;
  });
  let historyListeners = false,
    notificationListeners = false;
  const installOptionalListeners = () => {
    if (!historyListeners && chrome.history) {
      historyListeners = true;
      chrome.history.onVisited.addListener((v) => {
        lateTitles.visited(v);
        historyTitles.visit(v);
      });
      chrome.history.onVisitRemoved.addListener((e) => {
        lateTitles.cancel(
          e.allHistory
            ? undefined
            : (e.urls || []).flatMap((u) => {
                const url = recordableUrl(u);
                return url ? [url] : [];
              }),
        );
        historyTitles.cancel(
          e.allHistory
            ? undefined
            : (e.urls || []).flatMap((u) => {
                const url = recordableUrl(u);
                return url ? [url] : [];
              }),
        );
        void service.historyRemoved(
          e.allHistory
            ? undefined
            : (e.urls || [])
                .map((u) => recordableUrl(u))
                .filter((u): u is string => !!u),
        );
      });
    }
    if (!notificationListeners && chrome.notifications) {
      notificationListeners = true;
      chrome.notifications.onClicked.addListener((id) => {
        if (!id.startsWith("kj-incoming:")) return;
        void service.state().then(async (s) => {
          const item = s.inbox.find((i) => i.id === id.slice(12)),
            u = item?.u && normalizeUrl(item.u);
          if (u) await chrome.tabs.create({ url: u });
          if (item) await service.read(item.id);
          await chrome.notifications.clear(id);
        });
      });
    }
  };
  installOptionalListeners();
  chrome.permissions.onAdded.addListener((p) => {
    if (p.permissions?.includes("tabs")) tabsAllowed = true;
    installOptionalListeners();
  });
  chrome.tabs.onCreated.addListener((tab) => {
    if (!tab.incognito) scheduleTabs();
  });
  chrome.tabs.onUpdated.addListener((id, change, tab) => {
    void lateTitles.updated(id, change, tab).catch(() => {});
    if (
      !tab.incognito &&
      (change.url || change.title || change.status === "complete")
    )
      scheduleTabs();
  });
  chrome.tabs.onRemoved.addListener((id) => {
    lateTitles.removed(id);
    scheduleTabs();
  });
  chrome.tabs.onActivated.addListener(scheduleTabs);
  chrome.windows.onFocusChanged.addListener(scheduleTabs);
  chrome.permissions.onRemoved.addListener((p) => {
    if (p.permissions?.includes("tabs")) tabsAllowed = false;
    if (p.permissions?.some((name) => name === "tabs" || name === "history"))
      lateTitles.cancel();
    for (const key of ["history", "tabs", "incoming"] as const)
      if (p.permissions?.includes(permissions[key]) && service.options[key])
        void service.setOption(key, false);
  });
  service.notifyIncoming = async (item: Incoming) => {
    if (
      !(await chrome.permissions.contains({ permissions: ["notifications"] }))
    )
      return;
    const url = item.u && normalizeUrl(item.u);
    await chrome.notifications.create("kj-incoming:" + item.id, {
      type: "basic",
      iconUrl: "icons/128.png",
      title: "来自 " + service.deviceName(item.from),
      message: url
        ? (item.ti || url) + "\n" + new URL(url).hostname
        : item.tx || "",
    });
  };
  service.subscribe((state) => {
    const unread = state.inbox.filter((i) => !i.read).length;
    void chrome.action.setBadgeBackgroundColor({ color: "#2F6CEB" });
    void chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
    void chrome.action.setBadgeText({ text: unread ? String(unread) : "" });
    const devices = state.status.devices.filter((d) => !d.self),
      key = JSON.stringify(devices.map((d) => [d.deviceId, d.name]));
    if (key === lastMenus) return;
    lastMenus = key;
    void chrome.contextMenus
      .remove(sendMenu)
      .catch(() => {})
      .then(() => {
        if (!devices.length) return;
        chrome.contextMenus.create({
          id: sendMenu,
          title: "发送到设备",
          contexts: ["page", "link", "selection"],
        });
        devices.forEach((d) =>
          chrome.contextMenus.create({
            id: sendMenu + ":" + d.deviceId,
            parentId: sendMenu,
            title: d.name,
            contexts: ["page", "link", "selection"],
          }),
        );
      });
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (tab?.incognito || !String(info.menuItemId).startsWith(sendMenu + ":"))
      return;
    const id = String(info.menuItemId).slice(sendMenu.length + 1);
    void service
      .send(
        id,
        info.selectionText
          ? { k: "text", tx: info.selectionText.slice(0, 4000) }
          : {
              k: "url",
              u: info.linkUrl || tab?.url,
              ti: info.linkUrl || tab?.title,
            },
      )
      .catch(() => {});
  });
  await service.publish();
  scheduleTabs();
}
