import { useStore, flushPersistence } from "../app/store";
import { nativeCall } from "./native";
import { searchTemplate } from "./android-settings";
import { createNativeDispatcher } from "./bridge";
import { findBookmark } from "./bookmark-key";
import { searchBookmarks } from "./bookmark-search";
import { normalizeUrl, autoTitle } from "../lib/validation";
import { ordered } from "../lib/model";
import { acquireIcon } from "../features/bookmarks/icons";
import { blobDataUrl, compressImage } from "../lib/images";
import { setNativeVisible } from "../lib/visibility";
import { browserPrefs } from "./browser-prefs";
import { addReadLater } from "../lib/read-later";
import { normalizePairCode } from "../features/pairing/types";
import { pairCommand } from "../features/pairing/bridge";
declare global {
  interface Window {
    kongjing?: { call: ReturnType<typeof createNativeDispatcher> };
  }
}
export function installAndroidBridge() {
  window.kongjing = {
    call: createNativeDispatcher(
      async (method, args) => {
        const s = useStore.getState();
        if (
          [
            "recordVisits",
            "setOpenTabs",
            "getDevices",
            "sendToDevice",
            "searchHistory",
            "openRelay",
            "pendingIncoming",
            "markIncomingRead",
          ].includes(method)
        ) {
          const { continuityCommand, openContinuity } = await import(
            "../features/continuity/bridge"
          );
          if (method === "openRelay") {
            if (args.tab !== "devices" && args.tab !== "history")
              throw Error("INVALID_ARGS");
            useStore.setState({ settingsOpen: false, overlay: null });
            openContinuity(args.tab);
            return {};
          }
          if (
            method === "recordVisits" &&
            (!Array.isArray(args.visits) || args.visits.length > 50)
          )
            throw Error("INVALID_ARGS");
          if (method === "setOpenTabs") {
            if (
              !Array.isArray(args.tabs) ||
              args.tabs.length > 200 ||
              !args.last ||
              typeof args.last !== "object"
            )
              throw Error("INVALID_ARGS");
            return continuityCommand(method, {
              windows: [{ focused: true, tabs: args.tabs }],
              last: args.last,
            });
          }
          if (
            method === "searchHistory" &&
            (typeof args.query !== "string" ||
              (args.limit !== undefined &&
                (typeof args.limit !== "number" ||
                  !Number.isInteger(args.limit) ||
                  args.limit < 1)))
          )
            throw Error("INVALID_ARGS");
          if (
            method === "sendToDevice" &&
            (typeof args.deviceId !== "string" ||
              typeof args.url !== "string" ||
              typeof args.title !== "string")
          )
            throw Error("INVALID_ARGS");
          return continuityCommand(method, args);
        }
        switch (method) {
          case "scrollToTop":
            for (const node of document.querySelectorAll<HTMLElement>(
              ".grid-scroll,.bookmark-grid,.bookmarks-scroll,#stage",
            ))
              node.scrollTo({ top: 0, behavior: "smooth" });
            window.scrollTo({ top: 0, behavior: "smooth" });
            return {};
          case "browserPrefsChanged":
            browserPrefs.refresh();
            return {};
          case "pairWithCode": {
            if (typeof args.code !== "string") throw Error("BAD_CODE");
            let input = args.code;
            if (input.startsWith("kongjing://pair?"))
              input = new URL(input).searchParams.get("code") || "";
            const code = normalizePairCode(input);
            if (!code) throw Error("BAD_CODE");
            await pairCommand("join-view");
            useStore.setState((state) => ({
              settingsOpen: true,
              settingsSection: "pairing",
              overlay: { type: "pairing" },
              pair: { ...state.pair, view: "join", code },
            }));
            return {};
          }
          case "addReadLater": {
            const url = normalizeUrl(String(args.url || ""));
            if (!url) throw Error("INVALID_URL");
            let icon: import("../lib/model").BookmarkIcon | undefined;
            if (
              typeof args.iconDataUrl === "string" &&
              /^data:image\/(png|webp);base64,/.test(args.iconDataUrl) &&
              args.iconDataUrl.length < 3 * 1024 * 1024
            )
              icon = {
                mode: "auto" as const,
                dataUrl: await blobDataUrl(
                  await compressImage(
                    await (await fetch(args.iconDataUrl)).blob(),
                    "icon",
                  ),
                ),
                fetchedAt: Date.now(),
              };
            let result!: { id: string; groupId: string };
            s.update((data) => {
              result = addReadLater(data, {
                url,
                title: String(args.title || ""),
                icon,
              });
            });
            await flushPersistence();
            nativeCall("haptic", "success");
            return result;
          }
          case "setVisible":
            if (typeof args.visible !== "boolean") throw Error("INVALID_ARGS");
            setNativeVisible(args.visible);
            return {};
          case "getGroups":
            return ordered(s.data.groups).map(({ id, name }) => ({ id, name }));
          case "searchBookmarks": {
            if (
              typeof args.query !== "string" ||
              (args.limit !== undefined &&
                (typeof args.limit !== "number" ||
                  !Number.isInteger(args.limit) ||
                  args.limit < 0))
            )
              throw Error("INVALID_ARGS");
            return searchBookmarks(s.data.bookmarks, args.query, args.limit);
          }
          case "findBookmark": {
            const b = findBookmark(s.data.bookmarks, String(args.url || ""));
            return b
              ? { found: true, groupId: b.groupId, id: b.id }
              : { found: false };
          }
          case "addBookmark": {
            const url = normalizeUrl(String(args.url || ""));
            if (!url) throw Error("INVALID_URL");
            const existing = findBookmark(s.data.bookmarks, url);
            const groupId =
              s.data.groups.find((g) => g.id === args.groupId)?.id ||
              existing?.groupId ||
              s.data.groups[0].id;
            const id = existing?.id || crypto.randomUUID(),
              now = Date.now();
            let icon = existing?.icon || { mode: "auto" as const };
            if (
              typeof args.iconDataUrl === "string" &&
              /^data:image\/(png|webp);base64,/.test(args.iconDataUrl) &&
              args.iconDataUrl.length < 3 * 1024 * 1024
            ) {
              icon = {
                mode: "auto",
                dataUrl: await blobDataUrl(
                  await compressImage(
                    await (await fetch(args.iconDataUrl)).blob(),
                    "icon",
                  ),
                ),
                fetchedAt: now,
              };
            }
            s.update((d) => {
              const fields = {
                title: String(args.title || autoTitle(url)).slice(0, 200),
                url,
                groupId,
                icon,
                updatedAt: now,
              };
              if (existing)
                Object.assign(d.bookmarks.find((b) => b.id === id)!, fields);
              else
                d.bookmarks.push({
                  id,
                  ...fields,
                  createdAt: now,
                  order: d.bookmarks.filter((b) => b.groupId === groupId)
                    .length,
                });
            });
            await flushPersistence();
            nativeCall("haptic", "success");
            if (!icon.dataUrl)
              void acquireIcon(url, s.status.relayUrl).then((icon) => {
                useStore.getState().update((d) => {
                  const b = d.bookmarks.find((b) => b.id === id);
                  if (b?.url === url && b.icon.mode === "auto") b.icon = icon;
                });
              });
            return { id, groupId };
          }
          case "removeBookmark": {
            if (typeof args.id !== "string") throw Error("INVALID_ARGS");
            s.update((d) => {
              d.bookmarks = d.bookmarks.filter((b) => b.id !== args.id);
              d.tombstones.push({
                id: args.id as string,
                kind: "bookmark",
                deletedAt: Date.now(),
              });
            });
            await flushPersistence();
            return {};
          }
          case "openSettings": {
            if (
              args.section !== undefined &&
              !["pairing", "data", "browser"].includes(String(args.section))
            )
              throw Error("INVALID_SECTION");
            useStore.setState({
              overlay: null,
              settingsOpen: true,
              settingsSection: String(args.section || ""),
            });
            return {};
          }
          case "getSearchTemplate":
            return { template: searchTemplate(s.data) };
          case "getTheme":
            return {
              theme:
                document.documentElement.dataset.theme === "light"
                  ? "light"
                  : "dark",
            };
          default:
            throw Error("UNKNOWN_METHOD");
        }
      },
      (id, json) => nativeCall("reply", id, json),
    ),
  };
}
