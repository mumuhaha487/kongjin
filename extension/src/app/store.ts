import { create } from "zustand";
import { structuralShare } from "../lib/structural-share";
import { defaults, type AppData, type Settings } from "../lib/model";
import {
  mirror,
  readMirror,
  storage,
  extensionEnvironment,
} from "../lib/storage";
import { validateData } from "../lib/validation";
import { migrate } from "../lib/migration";
import { merge } from "../lib/merge";
import {
  initialStatus,
  type SyncStatus,
  type PairState,
} from "../features/pairing/types";
import {
  connectPairing,
  notifyPairing,
  pairCommand,
} from "../features/pairing/bridge";
import { ANDROID, STORE } from "../lib/build";
import { visibleTimeout } from "../lib/visibility";
import { appData, rebaseChange } from "../lib/app-data";
export type Overlay = {
  type:
    | "bookmark"
    | "avatar"
    | "pairing"
    | "welcome"
    | "reset"
    | "replace"
    | "permission"
    | "remove-device"
    | "leave"
    | "clear-browser";
  id?: string;
  source?: string;
  data?: AppData;
  background?: string;
  kind?: "icons" | "bar";
  name?: string;
} | null;
export interface Toast {
  id: number;
  text: string;
  type?: "success" | "removed";
  action?: () => void;
  label?: string;
}
interface State {
  data: AppData;
  history: string[];
  status: SyncStatus;
  pair: PairState;
  overlay: Overlay;
  settingsOpen: boolean;
  settingsSection: string;
  continuityConsent?: boolean;
  focused: boolean;
  selected: string;
  toasts: Toast[];
  update: (fn: (d: AppData) => void) => Promise<void>;
  setting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  open: (overlay: Overlay) => void;
  toast: (
    text: string,
    action?: () => void,
    label?: string,
    duration?: number,
    type?: Toast["type"],
  ) => void;
  addHistory: (q: string) => void;
  profile: (value: Partial<AppData["profile"]>) => void;
}
let seq = 0,
  persistence = Promise.resolve();
let returnFocus: HTMLElement | null = null;
const initialMirror = readMirror();
const pendingChanges: { before: AppData; after: AppData }[] = [];
function present(data: AppData) {
  for (const change of pendingChanges)
    data = rebaseChange(data, change.before, change.after);
  useStore.setState({ data: structuralShare(useStore.getState().data, data) });
}
function persist(before: AppData, after: AppData) {
  const change = { before, after };
  pendingChanges.push(change);
  const result = persistence
    .catch(() => {})
    .then(async () => {
      const data = await appData.change(before, after);
      pendingChanges.splice(pendingChanges.indexOf(change), 1);
      present(data);
      mirror(data);
      await notifyPairing();
    });
  persistence = result;
  // Observe the rejection for UI feedback without turning a failed commit into success.
  void result.catch(async () => {
    const index = pendingChanges.indexOf(change);
    if (index >= 0) pendingChanges.splice(index, 1);
    try {
      present(await appData.read());
    } catch {
      /* storage unavailable: keep the current UI and report failure */
    }
    useStore.getState().toast("本机存储空间不足，请导出数据");
  });
  return result;
}
export const useStore = create<State>((set, get) => ({
  data: initialMirror,
  history: [],
  status: initialStatus(),
  pair: { view: "intro" },
  overlay: null,
  settingsOpen: false,
  settingsSection: "",
  focused: false,
  selected: "default-common",
  toasts: [],
  update(fn) {
    const before = get().data;
    let data = structuredClone(before);
    fn(data);
    data = structuralShare(get().data, data);
    set({ data });
    return persist(before, data);
  },
  setting(key, value) {
    get().update((d) => {
      if (
        !STORE &&
        ((key === "background" && value !== "image") ||
          (key === "imageUrl" && value !== "local"))
      ) {
        const settings = d.settings as Settings & {
          backgroundImage?: { blobId: string };
        };
        if (settings.backgroundImage) {
          const blobId = settings.backgroundImage.blobId;
          delete settings.backgroundImage;
          void import("../features/continuity/bridge")
            .then(({ continuityCommand }) =>
              continuityCommand("deleteBackground", { blobId }),
            )
            .catch(() => {});
        }
      }
      d.settings[key] = value;
      d.settings.updatedAt = Math.max(Date.now(), d.settings.updatedAt + 1);
    });
  },
  profile(value) {
    get().update((d) => {
      Object.assign(d.profile, value, {
        updatedAt: Math.max(Date.now(), d.profile.updatedAt + 1),
      });
    });
  },
  open(overlay) {
    if (overlay) returnFocus = document.activeElement as HTMLElement;
    set({ overlay, focused: false });
    if (!overlay)
      setTimeout(() => {
        if (returnFocus?.isConnected) returnFocus.focus();
      }, 320);
  },
  toast(text, action, label = "撤销", duration, type = "success") {
    const id = ++seq;
    set((s) => ({
      toasts: [...s.toasts, { id, text, action, label, type }].slice(-3),
    }));
    visibleTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      duration ?? (action ? 5000 : 2600),
    );
  },
  addHistory(q) {
    if (!get().data.settings.history) return;
    const history = [q, ...get().history.filter((x) => x !== q)].slice(0, 50);
    set({ history });
    void storage.set("history", history);
    if (!STORE)
      void import("../features/continuity/bridge")
        .then(({ continuityCommand }) =>
          continuityCommand("search", { query: q }),
        )
        .catch(() => {});
  },
}));
export async function initialize({ home = true } = {}) {
  const [raw, oldSession, history, welcomed] = await Promise.all([
    storage.get<unknown>("data"),
    storage.get<{ user?: { username?: string } }>("session"),
    storage.get<string[]>("history"),
    storage.get<boolean>("v2-migrated"),
  ]);
  const pending = await storage.get<boolean>("v2WelcomePending");
  const section = await storage.get<string>("openSettings");
  if (section) {
    useStore.setState({ settingsOpen: true, settingsSection: section });
    await storage.remove("openSettings");
  }
  if (pending && !welcomed) {
    useStore.getState().open({ type: "welcome" });
    await storage.set("v2-migrated", true);
    await storage.remove("v2WelcomePending");
  }
  const upgraded =
    !!raw &&
    typeof raw === "object" &&
    (raw as { schema?: number }).schema === 1;
  let data =
    migrate(raw, oldSession?.user?.username) || useStore.getState().data;
  if (!STORE && useStore.getState().data !== initialMirror)
    data = merge(data, useStore.getState().data);
  useStore.setState({
    data,
    history: history || [],
    selected: data.groups[0]?.id || "default-common",
  });
  mirror(data);
  if (raw && JSON.stringify(raw) !== JSON.stringify(data))
    data = await appData.mergeRemote(data);
  if (upgraded) {
    if (!welcomed) useStore.getState().open({ type: "welcome" });
    await storage.set("v2-migrated", true);
  }
  for (const k of ["session", "server", "syncMeta"]) await storage.remove(k);
  try {
    localStorage.removeItem("shiguang:mirror");
  } catch {
    /* SW has no localStorage */
  }
  storage.subscribe((key, value) => {
    if (key === "data" && validateData(value)) {
      const data = migrate(value)!;
      present(data);
      mirror(data);
    }
    if (key === "history")
      useStore.setState({ history: (value as string[]) || [] });
  });
  window.addEventListener("kj:merged", (event) => {
    const data = (event as CustomEvent<AppData>).detail;
    if (validateData(data)) {
      const clean = migrate(data)!;
      present(clean);
      mirror(clean);
    }
  });
  let claimingNotice = false;
  const showRemovedToast = async () => {
    const notice = useStore.getState().status.removedNotice;
    if (!home || !notice || claimingNotice || document.hidden) return;
    claimingNotice = true;
    try {
      const response = await pairCommand("claim-removed-toast", {
        at: String(notice.at),
      });
      if (response?.noticeToast)
        useStore
          .getState()
          .toast("本设备已被移出配对组", undefined, undefined, 6000, "removed");
    } finally {
      claimingNotice = false;
    }
  };
  await connectPairing((status, pair) => {
    useStore.setState({ status, pair });
    void showRemovedToast();
  });
  document.addEventListener("visibilitychange", () => void showRemovedToast());
  void import("../features/bookmarks/icons").then(({ fillMissingTones }) =>
    fillMissingTones(
      () => useStore.getState().data,
      (id, icon) =>
        useStore.getState().update((d) => {
          const b = d.bookmarks.find((b) => b.id === id);
          if (b) b.icon = icon;
        }),
    ),
  );
  if (!ANDROID && extensionEnvironment())
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden)
        void chrome.runtime.sendMessage({ type: "kj:pair", action: "status" });
    });
}
export async function flushPersistence() {
  await persistence;
}
export function resetData() {
  return useStore.getState().update((d) => {
    const fresh = defaults(),
      now = Date.now();
    for (const g of d.groups)
      if (!fresh.groups.some((x) => x.id === g.id))
        fresh.tombstones.push({ id: g.id, kind: "group", deletedAt: now });
    for (const b of d.bookmarks)
      if (!fresh.bookmarks.some((x) => x.id === b.id))
        fresh.tombstones.push({ id: b.id, kind: "bookmark", deletedAt: now });
    fresh.groups.forEach((g) => (g.updatedAt = now));
    fresh.bookmarks.forEach((b) => (b.updatedAt = now));
    fresh.settings.updatedAt = now;
    fresh.profile.updatedAt = now;
    Object.assign(d, fresh);
  });
}
export function importData(data: AppData, replace = false) {
  return useStore
    .getState()
    .update((d) => Object.assign(d, replace ? data : merge(d, data)));
}
