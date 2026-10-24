import { stageAnimation } from "../lib/compositor";
import { motionTransition } from "../lib/motion";
import React, {
  lazy,
  memo,
  Profiler,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react";
import { Background } from "../components/Background/Background";
import { Header } from "../components/Header/Header";
import { Clock } from "../components/Clock/Clock";
import { Toasts, Modal } from "../components/Common/Common";
import { Search } from "../features/search/Search";
import { Bookmarks } from "../features/bookmarks/Bookmarks";
import { BookmarkDialog } from "../features/bookmarks/BookmarkDialog";
import { AvatarDialog } from "../features/profile/AvatarDialog";
import { PairingDialog } from "../features/pairing/Pairing";
import { syncFooter, syncPhase } from "../features/pairing/status";
import { Logo } from "../components/Logo/Logo";
import { Button } from "../components/Common/Common";
import { fillMissingIcons } from "../features/bookmarks/icons";
import { Confirmation, SettingsPanel } from "../features/settings/Settings";
import { initialize, useStore } from "./store";

import { spring } from "../lib/motion";
import "../styles/tokens.css";
import "../styles/app.css";
import "../styles/v2.css";
import "../styles/android.css";
import { ANDROID, STORE } from "../lib/build";
import { afterPaintIdle } from "../lib/after-paint";
import { useShallow } from "zustand/react/shallow";
import { installVisibility } from "../lib/visibility";
const RelayRoot = !STORE
  ? lazy(() =>
      import("../features/continuity/RelayUI").then((m) => ({
        default: m.RelayRoot,
      })),
    )
  : () => null;
const ResumePill = !STORE
  ? lazy(() =>
      import("../features/continuity/RelayUI").then((m) => ({
        default: m.ResumePill,
      })),
    )
  : () => null;
import { nativeCall, nativeOpen } from "../platform/native";
import {
  browserSettings,
  syncNativeSearch,
} from "../platform/android-settings";
import { installAndroidBridge } from "../platform/android-bridge";
const MemoBackground = memo(Background);
const MemoHeader = memo(Header);
const SceneGroup = ANDROID ? React.Fragment : LayoutGroup;
function App() {
  const {
      theme: themeSetting,
      accent,
      searchEngines,
    } = useStore(
      useShallow((v) => ({
        theme: v.data.settings.theme,
        accent: v.data.settings.accent,
        searchEngines: v.data.searchEngines,
      })),
    ),
    reduce = useReducedMotion(),
    [prewarmed, setPrewarmed] = useState(false),
    [relayReady, setRelayReady] = useState(false),
    settings = { theme: themeSetting, accent };
  useEffect(() => installVisibility(ANDROID), []);
  useEffect(() => {
    const warm = afterPaintIdle(() => setPrewarmed(true));
    const hydrate = () => {
      void initialize().then(async () => {
        if (!STORE) performance.mark("kongjing-storage-ready");
        if (!STORE) {
          const { connectContinuity, useContinuity } = await import(
            "../features/continuity/bridge"
          );
          await connectContinuity();
          void useContinuity;
          setRelayReady(true);
          performance.mark("kongjing-continuity-ready");
        }
        if (ANDROID) {
          installAndroidBridge();
          syncNativeSearch(useStore.getState().data);
          performance.mark("kongjing-native-ready");
          nativeCall("ready");
        }
        if (!ANDROID && typeof chrome !== "undefined" && chrome.runtime?.id)
          return;
        void fillMissingIcons(
          () => useStore.getState().data,
          (id, icon) =>
            useStore.getState().update((d) => {
              const b = d.bookmarks.find((b) => b.id === id);
              if (b) {
                b.icon = icon;
                b.updatedAt = Date.now();
              }
            }),
        );
      });
    };
    const cancel = STORE
      ? (hydrate(), () => {})
      : afterPaintIdle(() => {
          performance.mark("kongjing-hydration-start");
          hydrate();
        });
    if (!STORE)
      requestAnimationFrame(() => performance.mark("kongjing-first-frame"));
    performance.mark("kongjing-interactive");
    document.documentElement.dataset.ready = "true";
    return () => {
      cancel();
      warm();
    };
  }, []);
  useEffect(() => {
    if (!ANDROID) return;
    const openLink = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (link && /^https?:/.test(link.href)) {
        event.preventDefault();
        nativeOpen(link.href, link.target === "_blank");
      }
    };
    document.addEventListener("click", openLink);
    return () => document.removeEventListener("click", openLink);
  }, []);
  useEffect(() => {
    if (!ANDROID) return;
    const update = () => syncNativeSearch(useStore.getState().data);
    update();
    const unsubscribe = browserSettings.subscribe(update);
    return unsubscribe;
  }, [searchEngines]);
  useLayoutEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme =
        settings.theme === "system"
          ? matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark"
          : settings.theme;
      document.documentElement.dataset.accent = settings.accent;
      if (ANDROID)
        nativeCall(
          "setTheme",
          document.documentElement.dataset.theme as "light" | "dark",
        );
    };
    const theme =
      settings.theme === "system"
        ? matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : settings.theme;
    if (
      document.documentElement.dataset.theme !== theme &&
      document.startViewTransition &&
      !reduce
    ) {
      const point = lastPointer;
      const transition = document.startViewTransition(apply);
      void transition.ready.then(() => {
        const radius = Math.hypot(
          Math.max(point.x, innerWidth - point.x),
          Math.max(point.y, innerHeight - point.y),
        );
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${point.x}px ${point.y}px)`,
              `circle(${radius}px at ${point.x}px ${point.y}px)`,
            ],
          },
          {
            duration: 600,
            easing: "cubic-bezier(0.65,0,0.35,1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      });
    } else if (document.documentElement.dataset.theme !== theme) {
      const snapshot = document.createElement("div");
      snapshot.className = "theme-snapshot";
      snapshot.dataset.theme = document.documentElement.dataset.theme;
      snapshot.dataset.accent = document.documentElement.dataset.accent;
      snapshot.setAttribute("aria-hidden", "true");
      snapshot.inert = true;
      snapshot.append(document.getElementById("root")!.cloneNode(true));
      document.body.append(snapshot);
      apply();
      const fade = snapshot.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: reduce ? 150 : 200,
      });
      void fade.finished.finally(() => snapshot.remove());
    } else apply();
    const media = matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme, settings.accent, reduce]);
  return (
    <MotionConfig
      reducedMotion="user"
      transition={motionTransition(spring.smooth)}
    >
      <SceneGroup>
        <Profiler id="Background" onRender={homeProfiler}>
          <MemoBackground />
        </Profiler>
        <MemoHeader />
        <Stage relayReady={relayReady} />
        <SyncFooter />
        <Overlays prewarmed={prewarmed} />
        <Toasts />
        {!STORE && relayReady && (
          <Suspense fallback={null}>
            <RelayRoot />
          </Suspense>
        )}
      </SceneGroup>
    </MotionConfig>
  );
}

const homeProfiler: React.ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
) => {
  const target = window as unknown as { kjProfile?: unknown[] };
  if (import.meta.env.MODE === "qa" && target.kjProfile)
    target.kjProfile.push({ id, phase, actualDuration });
};
const HomeContent = memo(function HomeContent({
  relayReady,
}: {
  relayReady: boolean;
}) {
  return (
    <>
      <Profiler id="Clock" onRender={homeProfiler}>
        <Clock />
      </Profiler>
      <Profiler id="Search" onRender={homeProfiler}>
        <Search />
      </Profiler>
      <Profiler id="Bookmarks" onRender={homeProfiler}>
        <Bookmarks />
      </Profiler>
      {!STORE && relayReady && (
        <Suspense fallback={null}>
          <ResumePill />
        </Suspense>
      )}
    </>
  );
});
function Stage({ relayReady }: { relayReady: boolean }) {
  const stage = useRef<HTMLElement>(null),
    reduce = useReducedMotion();
  const { overlay, settingsOpen } = useStore(
    useShallow((s) => ({ overlay: !!s.overlay, settingsOpen: s.settingsOpen })),
  );
  const [relayOpen, setRelayOpen] = useState(false);
  useEffect(() => {
    if (STORE) return;
    let off: (() => void) | undefined;
    void import("../features/continuity/bridge").then(({ useContinuity }) => {
      setRelayOpen(useContinuity.getState().open);
      off = useContinuity.subscribe((s) => setRelayOpen(s.open));
    });
    return () => off?.();
  }, []);
  useEffect(() => {
    if (stage.current)
      stage.current.inert = overlay || settingsOpen || relayOpen;
  }, [overlay, settingsOpen, relayOpen]);
  useLayoutEffect(() => {
    if (!ANDROID || !stage.current) return;
    return stageAnimation(
      stage.current,
      settingsOpen ? -3 : relayOpen ? 3 : 0,
      overlay ? 0.97 : settingsOpen || relayOpen ? 0.985 : 1,
      overlay || settingsOpen || relayOpen,
      overlay ? 0.75 : 1,
    );
  }, [overlay, settingsOpen, relayOpen]);
  if (ANDROID)
    return (
      <main id="stage" ref={stage}>
        <HomeContent relayReady={relayReady} />
      </main>
    );
  const light = document.documentElement.dataset.theme === "light";
  return (
    <motion.main
      id="stage"
      ref={stage}
      animate={
        reduce
          ? { opacity: overlay ? 0.75 : 1 }
          : {
              x: settingsOpen ? "-3%" : relayOpen ? "3%" : 0,
              scale: overlay ? 0.97 : settingsOpen || relayOpen ? 0.985 : 1,
              ...(ANDROID
                ? {}
                : {
                    filter: overlay
                      ? `blur(6px) brightness(${light ? 0.96 : 0.82})`
                      : settingsOpen || relayOpen
                        ? "blur(0px) brightness(.85)"
                        : "blur(0px) brightness(1)",
                  }),
            }
      }
      transition={motionTransition(
        overlay || settingsOpen || relayOpen
          ? spring.smooth
          : { duration: 0.28 },
      )}
    >
      <HomeContent relayReady={relayReady} />
    </motion.main>
  );
}
function SyncFooter() {
  const status = useStore((s) => s.status);
  return (
    <button
      className={"sync-status " + syncPhase(status) + (!STORE && status.transport ? " " + status.transport : "")}
      onClick={() =>
        useStore.setState({ settingsOpen: true, settingsSection: "pairing" })
      }
    >
      <span />
      {syncFooter(status)}
    </button>
  );
}
function Overlays({ prewarmed }: { prewarmed: boolean }) {
  const s = useStore(
    useShallow((s) => ({
      overlay: s.overlay,
      settingsOpen: s.settingsOpen,
      open: s.open,
    })),
  );
  return (
    <>
      {ANDROID ? (
        (prewarmed || s.settingsOpen) && (
          <SettingsPanel active={s.settingsOpen} />
        )
      ) : (
        <AnimatePresence>
          {s.settingsOpen && <SettingsPanel key="settings" />}
        </AnimatePresence>
      )}
      {ANDROID && (prewarmed || s.overlay?.type === "bookmark") && (
        <BookmarkDialog active={s.overlay?.type === "bookmark"} />
      )}
      <AnimatePresence>
        {!ANDROID && s.overlay?.type === "bookmark" ? (
          <BookmarkDialog key="bookmark" />
        ) : s.overlay?.type === "avatar" ? (
          <AvatarDialog key="avatar" />
        ) : s.overlay?.type === "pairing" ? (
          <PairingDialog key="pairing" />
        ) : s.overlay?.type === "welcome" ? (
          <Modal title="空境 2.0" key="welcome">
            <div className="welcome">
              <motion.div
                initial={{ scale: 0.6, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={motionTransition(spring.smooth)}
              >
                <Logo size={64} />
              </motion.div>
              <h1>拾光，现在叫空境</h1>
              <p>
                数据只保存在你的设备上，原来的账户登录已移除，你的书签和设置都已保留在本机。想在多台设备之间同步，可以在设置里开启端到端加密的「实时配对」。
              </p>
              <div className="dialog-actions">
                <Button variant="secondary" onClick={() => s.open(null)}>
                  知道了
                </Button>
                <Button
                  onClick={() => {
                    s.open(null);
                    useStore.setState({
                      settingsOpen: true,
                      settingsSection: "pairing",
                    });
                  }}
                >
                  去开启配对
                </Button>
              </div>
            </div>
          </Modal>
        ) : (
          s.overlay &&
          s.overlay.type !== "bookmark" && (
            <Modal
              title={
                s.overlay.type === "permission"
                  ? "权限说明"
                  : s.overlay.type === "reset"
                    ? "恢复默认？"
                    : "确认"
              }
              key="confirm"
            >
              <Confirmation />
            </Modal>
          )
        )}
      </AnimatePresence>
    </>
  );
}

let lastPointer = { x: innerWidth - 120, y: 42 };
document.addEventListener("pointerdown", (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
});
if (ANDROID) document.documentElement.dataset.platform = "android";
if (import.meta.env.MODE === "qa") void import("../testing/harness");
createRoot(document.getElementById("root")!).render(<App />);
