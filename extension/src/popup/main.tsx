import { lazy, Suspense, useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, Settings, BookmarkPlus, BookOpen } from "lucide-react";
import { useStore, initialize } from "../app/store";
import { Logo } from "../components/Logo/Logo";
import { TileIcon } from "../components/TileIcon/TileIcon";
import { Button, Toggle, Segments, Toasts } from "../components/Common/Common";
import { extensionEnvironment } from "../lib/storage";
import { acquireIcon } from "../features/bookmarks/icons";
import { normalizeUrl } from "../lib/validation";
import { STORE } from "../lib/build";
import { addReadLater } from "../lib/read-later";
import "../styles/tokens.css";
import "../styles/app.css";
import "../styles/v2.css";
import "./popup.css";
const SendRow = !STORE
  ? lazy(() =>
      import("../features/continuity/RelayUI").then((m) => ({
        default: m.SendRow,
      })),
    )
  : () => null;
function Popup() {
  const s = useStore(),
    root = useRef<HTMLDivElement>(null),
    [tab, setTab] = useState<chrome.tabs.Tab>(),
    [title, setTitle] = useState(""),
    [group, setGroup] = useState(s.data.settings.quickGroup),
    [gridGroup, setGridGroup] = useState(s.data.groups[0]?.id),
    [success, setSuccess] = useState(false),
    [permission, setPermission] = useState(false),
    [loading, setLoading] = useState(false),
    [candidate, setCandidate] = useState<import("../lib/model").BookmarkIcon>({
      mode: "auto",
    });
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
    void initialize({ home: false }).then(async () => {
      if (!STORE) {
        if (import.meta.env.MODE === "qa" && !extensionEnvironment()) {
          const { connectPairing } = await import("../features/pairing/bridge");
          await connectPairing((status, pair) =>
            useStore.setState({ status, pair }),
          );
        }
        const { connectContinuity } = await import(
          "../features/continuity/bridge"
        );
        await connectContinuity();
      }
      let active: chrome.tabs.Tab | undefined;
      if (extensionEnvironment())
        active = (
          await chrome.tabs.query({ active: true, currentWindow: true })
        )[0];
      else if (import.meta.env.MODE === "qa")
        try {
          active = JSON.parse(localStorage.getItem("kj:popup") || "{}");
        } catch {
          /* fixture */
        }
      setTab(active);
      setTitle(active?.title || "");
      const state = useStore.getState();
      const found = state.data.bookmarks.find(
        (b) => b.url.replace(/\/$/, "") === active?.url?.replace(/\/$/, ""),
      );
      setTitle(found?.title || active?.title || "");
      setGroup(found?.groupId || state.data.settings.quickGroup);
      setGridGroup(state.data.groups[0].id);
      if (active?.url && normalizeUrl(active.url)) {
        setLoading(true);
        void acquireIcon(
          active.url,
          state.status.relayUrl,
          active.favIconUrl,
        ).then((icon) => {
          setCandidate(icon);
          setLoading(false);
        });
      }
    });
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme =
      s.data.settings.theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : s.data.settings.theme;
    el.dataset.accent = s.data.settings.accent;
  }, [s.data.settings.theme, s.data.settings.accent]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.close();
      if (
        e.key === "Enter" &&
        valid &&
        !success &&
        !(
          e.target instanceof Element &&
          e.target.closest("input,textarea,button,[contenteditable=true]")
        )
      ) {
        e.preventDefault();
        void save().catch(() => {});
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  });
  const valid =
      !!tab?.url &&
      !!normalizeUrl(tab.url) &&
      !/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/.test(
        tab.url,
      ),
    saved = s.data.bookmarks.find(
      (b) => b.url.replace(/\/$/, "") === tab?.url?.replace(/\/$/, ""),
    );
  async function save() {
    if (!valid || !tab?.url) return;
    await s.update((d) => {
      const now = Date.now();
      if (saved)
        Object.assign(d.bookmarks.find((b) => b.id === saved.id)!, {
          title: title.trim() || tab.title,
          url: tab.url,
          groupId: group,
          updatedAt: now,
        });
      else
        d.bookmarks.push({
          id: crypto.randomUUID(),
          title: title.trim() || tab.title || new URL(tab.url!).hostname,
          url: tab.url!,
          groupId: group,
          order: d.bookmarks.filter((b) => b.groupId === group).length,
          icon: candidate,
          createdAt: now,
          updatedAt: now,
        });
    });
    setSuccess(true);
    if (s.data.settings.autoClose) setTimeout(() => window.close(), 900);
  }
  async function remove() {
    if (!saved) return;
    await s.update((d) => {
      d.bookmarks = d.bookmarks.filter((b) => b.id !== saved.id);
      d.tombstones.push({
        id: saved.id,
        kind: "bookmark",
        deletedAt: Date.now(),
      });
    });
    s.toast("已移除书签");
  }
  async function saveReadLater() {
    if (!valid || !tab?.url) return;
    await s.update((data) =>
      addReadLater(data, { url: tab.url!, title, icon: candidate }),
    );
    s.toast("已加入稍后阅读");
    if (s.data.settings.autoClose) setTimeout(() => window.close(), 900);
  }
  function open(url: string, newTab = false) {
    if (extensionEnvironment()) {
      if (newTab) void chrome.tabs.create({ url, active: false });
      else if (tab?.id) void chrome.tabs.update(tab.id, { url });
      window.close();
    } else window.open(url, newTab ? "_blank" : "_self");
  }
  function openHome(settings = false) {
    if (extensionEnvironment()) {
      if (settings) void chrome.storage.local.set({ openSettings: "profile" });
      void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
      window.close();
    }
  }
  return (
    <div className="popup-app" ref={root} tabIndex={-1}>
      <header className="popup-header">
        <div className="wordmark">
          <Logo size={18} />
          <span>空境</span>
        </div>
        <div>
          <button aria-label="打开空境" onClick={() => openHome()}>
            <ArrowUpRight size={16} />
          </button>
          <button aria-label="设置" onClick={() => openHome(true)}>
            <Settings size={16} />
          </button>
        </div>
      </header>
      <section className={"current-card " + (success ? "saved-success" : "")}>
        {valid ? (
          <>
            {saved && (
              <span className="saved-pill">
                已在「{s.data.groups.find((g) => g.id === saved.groupId)?.name}
                」中
              </span>
            )}
            <div className="current-title">
              <div className={loading ? "icon-fetching" : ""}>
                <TileIcon
                  title={title}
                  url={tab!.url!}
                  icon={saved?.icon || candidate}
                />
              </div>
              <div>
                <input
                  aria-label="网页标题"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <p>{new URL(tab!.url!).hostname}</p>
              </div>
            </div>
            <div className="popup-groups">
              {s.data.groups.map((g) => (
                <button
                  key={g.id}
                  className={g.id === group ? "selected" : ""}
                  onClick={() => setGroup(g.id)}
                >
                  {g.name}
                </button>
              ))}
            </div>
            <div className="current-actions">
              {success ? (
                <Button disabled>
                  <svg
                    className="popup-success-check"
                    role="img"
                    aria-label="已收藏"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="m7 12 3 3 7-7" />
                  </svg>
                </Button>
              ) : saved ? (
                <>
                  <Button onClick={() => void save().catch(() => {})}>更新</Button>
                  <Button
                    variant="secondary"
                    className="danger-text"
                    onClick={() => void remove().catch(() => {})}
                  >
                    移除
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={() => void save().catch(() => {})}>
                    <BookmarkPlus size={16} />
                    收藏到空境
                  </Button>
                  <Button variant="secondary" onClick={() => void saveReadLater().catch(() => {})}>
                    <BookOpen size={16} />
                    稍后阅读
                  </Button>
                </>
              )}
            </div>
            {!STORE && (
              <Suspense fallback={null}>
                <SendRow url={tab!.url!} title={title} />
              </Suspense>
            )}
          </>
        ) : (
          <p className="unsupported">这个页面无法收藏</p>
        )}
      </section>
      <section className="popup-bookmarks">
        <div className="popup-bookmarks-heading">
          <h3>书签</h3>
          <Segments
            id="popup-groups"
            value={gridGroup}
            items={s.data.groups.map((g) => ({ value: g.id, label: g.name }))}
            onChange={setGridGroup}
          />
        </div>
        <div className="popup-grid">
          {s.data.bookmarks
            .filter((b) => b.groupId === gridGroup)
            .sort((a, b) => a.order - b.order)
            .map((b) => (
              <button
                key={b.id}
                onClick={(e) => open(b.url, e.ctrlKey || e.metaKey)}
                onAuxClick={(e) => {
                  if (e.button === 1) open(b.url, true);
                }}
              >
                <TileIcon title={b.title} url={b.url} icon={b.icon} />
                <span className="popup-name">{b.title}</span>
              </button>
            ))}
        </div>
      </section>
      <footer>
        {STORE ? (
          <>
            <span>Alt+K</span>
            <button className="text-button" onClick={() => openHome(true)}>
              设置
            </button>
          </>
        ) : (
          <>
            <span>空境栏</span>
            <Toggle
              label="空境栏"
              value={s.data.settings.barEnabled}
              onChange={() =>
                s.data.settings.barEnabled
                  ? s.setting("barEnabled", false)
                  : setPermission(true)
              }
            />
            <small>Alt+K</small>
          </>
        )}
      </footer>
      {!STORE && permission && (
        <div className="popup-permission">
          <h2>在网页中显示空境栏？</h2>
          <p className="help">
            空境栏会出现在你访问的网页顶部，需要「读取和更改所有网站上的数据」权限才能显示。空境栏不会读取网页内容，只有在你点击「收藏本页」时才读取网址和标题。
          </p>
          <div className="button-row">
            <Button variant="secondary" onClick={() => setPermission(false)}>
              暂不
            </Button>
            <Button
              onClick={() =>
                void (async () => {
                  if (
                    extensionEnvironment() &&
                    (await chrome.permissions.request({
                      origins: ["<all_urls>"],
                    }))
                  )
                    s.setting("barEnabled", true);
                  setPermission(false);
                })()
              }
            >
              开启
            </Button>
          </div>
        </div>
      )}
      <Toasts />
    </div>
  );
}
if (import.meta.env.MODE === "qa") void import("../testing/harness");
createRoot(document.getElementById("root")!).render(<Popup />);
