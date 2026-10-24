import { SheetFrame } from "../../components/Common/Sheet";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
} from "motion/react";
import { ArrowUpRight, Check, Search, Send, X } from "lucide-react";
import {
  Button,
  Choice,
  IconButton,
  Modal,
  Menu,
  MenuItem,
  Segments,
  Toggle,
  useFocusTrap,
} from "../../components/Common/Common";
import { useStore } from "../../app/store";
import { ANDROID } from "../../lib/build";
import { extensionEnvironment } from "../../lib/storage";
import { nativeOpen } from "../../platform/native";
import { normalizeUrl } from "../../lib/validation";
import { motionTransition, spring } from "../../lib/motion";
import { visibleTimeout } from "../../lib/visibility";
import { PairIllustration, platformIcon } from "../pairing/Pairing";
import { relativeTime } from "../pairing/status";
import { continuityCommand, useContinuity } from "./bridge";
import {
  otherDevices,
  type ContinuityOptions,
  type HistoryPage,
  type Visit,
} from "./types";
import { excludedHost } from "./privacy";
import { compactDeviceName, fittingPills } from "./device-name";
import { historyTitle } from "./history-title";
import { virtualWindow, DAY_HEIGHT, HISTORY_HEIGHT } from "./virtual";
import "./relay.css";

const closePanel = () => useContinuity.setState({ open: false });
const domain = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};
function openUrl(input: string, newTab = false) {
  const url = normalizeUrl(input);
  if (!url) return;
  if (ANDROID) nativeOpen(url, newTab);
  else if (newTab) {
    if (extensionEnvironment()) void chrome.tabs.create({ url, active: false });
    else window.open(url, "_blank", "noopener,noreferrer");
  } else location.href = url;
}
function errorToast(error: unknown) {
  useStore
    .getState()
    .toast(error instanceof Error ? error.message : "无法连接中转服务器");
}
export function RelayRoot() {
  const open = useContinuity((s) => s.open);
  return ANDROID ? (
    <RelayPanel active={open} />
  ) : (
    <AnimatePresence>{open && <RelayPanel />}</AnimatePresence>
  );
}
function RelayPanel({ active = true }: { active?: boolean }) {
  const s = useContinuity(),
    ref = useRef<HTMLElement>(null),
    drag = useDragControls(),
    reduce = useReducedMotion(),
    [clear, setClear] = useState(false),
    [permission, setPermission] = useState(false);
  const prev = useRef(s.tab),
    direction = s.tab === prev.current ? 0 : s.tab === "history" ? 1 : -1;
  useEffect(() => {
    prev.current = s.tab;
  }, [s.tab]);
  useFocusTrap(ref, closePanel, false, active && !clear && !permission);
  useEffect(() => {
    if (ref.current) ref.current.inert = !active || clear || permission;
  }, [active, clear, permission]);
  const panelContent = (
    <>
      <header>
        <h2>接力</h2>
        <Segments
          id="relay-tabs"
          value={s.tab}
          onChange={(v) =>
            useContinuity.setState({ tab: v as "devices" | "history" })
          }
          items={[
            { value: "devices", label: "设备" },
            { value: "history", label: "历史" },
          ]}
        />
        <IconButton label="关闭接力" onClick={closePanel}>
          <X size={18} />
        </IconButton>
      </header>
      <AnimatePresence mode="wait" custom={direction} initial={false}>
        <motion.div
          className="relay-page"
          key={s.tab}
          custom={direction}
          variants={{
            enter: (d: number) => ({ x: reduce ? 0 : d * 24, opacity: 0 }),
            show: { x: 0, opacity: 1 },
            leave: (d: number) => ({ x: reduce ? 0 : -d * 24, opacity: 0 }),
          }}
          initial="enter"
          animate="show"
          exit="leave"
          transition={motionTransition(spring.smooth)}
        >
          {s.tab === "devices" ? (
            <DevicesPage />
          ) : (
            <HistoryPageView
              onClear={() => setClear(true)}
              onEnable={() => setPermission(true)}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </>
  );
  return (
    <>
      {ANDROID ? (
        <SheetFrame
          active={active}
          title="接力"
          panelRef={ref}
          layerClass="settings-layer relay-layer"
          panelClass="relay-panel glass"
          close={closePanel}
        >
          {panelContent}
        </SheetFrame>
      ) : (
        <motion.div
          className="settings-layer relay-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) closePanel();
          }}
        >
          <motion.aside
            ref={ref}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="接力"
            className="relay-panel glass"
            drag={ANDROID ? "y" : false}
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 1 }}
            onDragEnd={(_, info) => {
              if (ANDROID && (info.offset.y > 120 || info.velocity.y > 520))
                closePanel();
            }}
            initial={
              reduce
                ? { opacity: 0 }
                : ANDROID
                  ? { y: "100%" }
                  : { x: -32, opacity: 0 }
            }
            animate={{ x: 0, y: 0, opacity: 1 }}
            exit={
              reduce
                ? { opacity: 0 }
                : ANDROID
                  ? { y: "100%" }
                  : { x: -32, opacity: 0 }
            }
            transition={motionTransition(spring.smooth)}
          >
            {ANDROID && (
              <div
                className="sheet-grip-zone"
                onPointerDown={(e) => drag.start(e)}
              >
                <span className="sheet-grip" />
              </div>
            )}
            {panelContent}
          </motion.aside>
        </motion.div>
      )}
      <AnimatePresence>
        {clear && <ClearHistory close={() => setClear(false)} />}
        {permission && (
          <SharePermission kind="history" close={() => setPermission(false)} />
        )}
      </AnimatePresence>
    </>
  );
}
function SiteIcon({ url, title }: { url: string; title: string }) {
  const icon = useStore(
    (s) => s.data.bookmarks.find((b) => b.url === url)?.icon.dataUrl,
  );
  return icon ? (
    <img className="relay-site-icon" src={icon} alt="" />
  ) : (
    <span className="relay-site-icon relay-letter" aria-hidden="true">
      {(title || domain(url)).slice(0, 1).toUpperCase()}
    </span>
  );
}
function DevicesPage() {
  const s = useContinuity();
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!s.status.paired)
    return (
      <div className="relay-empty">
        <PairIllustration />
        <p>与其他设备配对后，它们打开的网页会出现在这里</p>
        <Button
          onClick={() => {
            closePanel();
            useStore.setState({
              settingsOpen: true,
              settingsSection: "pairing",
            });
          }}
        >
          配对设备
        </Button>
      </div>
    );
  const openIncoming = async (id: string, u?: string, tx?: string) => {
    await continuityCommand("read", { id });
    if (u) openUrl(u);
    else if (tx) await navigator.clipboard.writeText(tx);
  };
  return (
    <div className="relay-devices">
      {s.inbox.length > 0 && (
        <section className="relay-inbox">
          <h3>收到的网页</h3>
          {s.inbox.slice(0, 20).map((item) => {
            const device = s.status.devices.find(
                (d) => d.deviceId === item.from,
              ),
              Icon = platformIcon(device?.platform || "");
            return (
              <div
                key={item.id}
                className={"relay-incoming " + (!item.read ? "unread" : "")}
              >
                <Icon size={18} />
                <div>
                  <span>{item.ti || item.tx || item.u}</span>
                  <small>
                    {compactDeviceName(item.from, s.status.devices)} ·{" "}
                    {relativeTime(item.at)}
                  </small>
                </div>
                <div className="relay-row-actions">
                  <button
                    className="text-button"
                    onClick={() => void openIncoming(item.id, item.u, item.tx)}
                  >
                    打开
                  </button>
                  <IconButton
                    label="移除收到的网页"
                    onClick={() =>
                      void continuityCommand("dismiss", { id: item.id })
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </section>
      )}
      {otherDevices(s.status).map((device) => {
        const Icon = platformIcon(device.platform),
          slot = s.slots.find((v) => v.dev === device.deviceId),
          tabs = slot?.payload.windows.flatMap((w) => w.tabs) || [],
          showAll = expanded.includes(device.deviceId);
        return (
          <section className="relay-device-card" key={device.deviceId}>
            <header>
              <Icon size={18} />
              <strong>{device.name}</strong>
              {device.joining ? <span className="self-pill joining-pill">等待加入</span> : device.transport && <span className={"self-pill transport-pill " + (device.online ? device.transport : "offline")}>{!device.online || device.transport === "offline" ? "离线" : device.transport === "direct" ? "直连" : "中转"}</span>}
              {!device.joining && <small>
                {device.online ? (
                  <>
                    <i className="device-online" />
                    在线
                  </>
                ) : (
                  relativeTime(device.lastSeenAt)
                )}
              </small>}
              {!device.joining && <IconButton
                label="发送当前标签页"
                onClick={() => void sendCurrent(device.deviceId)}
              >
                <Send size={16} />
              </IconButton>}
              {!device.joining && tabs.length > 1 && (
                <button
                  className="text-button"
                  onClick={() => tabs.forEach((t) => openUrl(t.u, true))}
                >
                  全部打开
                </button>
              )}
            </header>
            {!tabs.length ? (
              <p className="relay-no-tabs">这台设备没有共享打开的标签页</p>
            ) : (
              <>
                <motion.div
                  initial={false}
                  animate={{
                    height:
                      (showAll ? tabs.length : Math.min(8, tabs.length)) * 40,
                  }}
                  transition={motionTransition(spring.smooth)}
                  className="relay-tab-rows"
                >
                  {tabs.slice(0, showAll ? tabs.length : 8).map((tab, i) => (
                    <a
                      key={tab.u + i}
                      className={
                        "relay-tab-row " +
                        (slot?.payload.last?.u === tab.u ? "last" : "")
                      }
                      href={tab.u}
                      onClick={(e) => {
                        e.preventDefault();
                        openUrl(tab.u, e.ctrlKey || e.metaKey);
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          openUrl(tab.u, true);
                        }
                      }}
                    >
                      <SiteIcon url={tab.u} title={tab.ti} />
                      <span>{tab.ti || tab.u}</span>
                      <small>{domain(tab.u)}</small>
                    </a>
                  ))}
                </motion.div>
                {tabs.length > 8 && (
                  <button
                    className="text-button relay-more"
                    onClick={() =>
                      setExpanded(
                        showAll
                          ? expanded.filter((id) => id !== device.deviceId)
                          : [...expanded, device.deviceId],
                      )
                    }
                  >
                    {showAll ? "收起" : "显示另外 " + (tabs.length - 8) + " 个"}
                  </button>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
function dateLabel(at: number) {
  const date = new Date(at),
    today = new Date();
  today.setHours(0, 0, 0, 0);
  const stamp = new Date(at);
  stamp.setHours(0, 0, 0, 0);
  return stamp.getTime() === today.getTime()
    ? "今天 · " + (date.getMonth() + 1) + "月" + date.getDate() + "日"
    : stamp.getTime() === today.getTime() - 86400000
      ? "昨天"
      : date.getMonth() +
        1 +
        "月" +
        date.getDate() +
        "日 · " +
        date.toLocaleDateString("zh-CN", { weekday: "long" });
}
function HistoryPageView({
  onClear,
  onEnable,
}: {
  onClear: () => void;
  onEnable: () => void;
}) {
  const s = useContinuity(),
    [query, setQuery] = useState(""),
    [settled, setSettled] = useState(""),
    [device, setDevice] = useState(""),
    [page, setPage] = useState<HistoryPage>({ items: [] }),
    [scroll, setScroll] = useState(0),
    [height, setHeight] = useState(600),
    [hidden, setHidden] = useState<string[]>([]),
    scroller = useRef<HTMLDivElement>(null),
    loading = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(query), 150);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    let live = true;
    void continuityCommand<HistoryPage>("history", {
      query: settled,
      dev: device,
    })
      .then((p) => {
        if (live) {
          setPage(p);
          scroller.current?.scrollTo(0, 0);
          setScroll(0);
        }
      })
      .catch(errorToast);
    return () => {
      live = false;
    };
  }, [settled, device, s.inbox, s.status.lastSyncAt]);
  useEffect(() => {
    if (!scroller.current) return;
    const observer = new ResizeObserver(() =>
      setHeight(scroller.current?.clientHeight || 600),
    );
    observer.observe(scroller.current);
    return () => observer.disconnect();
  }, []);
  const rows = useMemo(() => {
    const rows: (
      | { day: string; v?: undefined }
      | { day?: undefined; v: Visit }
    )[] = [];
    let last = "";
    for (const v of page.items.filter((v) => !hidden.includes(v.id))) {
      const day = dateLabel(v.at);
      if (day !== last) {
        rows.push({ day });
        last = day;
      }
      rows.push({ v });
    }
    return rows;
  }, [page.items, hidden]);
  const heights = rows.map((r) => (r.day ? DAY_HEIGHT : HISTORY_HEIGHT)),
    window = virtualWindow(heights, scroll, height);
  const sticky = rows
    .slice(0, virtualWindow(heights, scroll, height, 0).start + 1)
    .reverse()
    .find((r) => r.day)?.day;
  const remove = (visit: Visit) => {
    setHidden((old) => [...old, visit.id]);
    const cancel = visibleTimeout(
      () =>
        void continuityCommand("delete", {
          ids: [visit.id],
          scope: "all",
        }).catch(errorToast),
      5000,
    );
    useStore.getState().toast("已删除 · 撤销", () => {
      cancel();
      setHidden((old) => old.filter((id) => id !== visit.id));
    });
  };
  const loadMore = () => {
    if (loading.current || !page.next) return;
    loading.current = true;
    void continuityCommand<HistoryPage>("history", {
      query: settled,
      dev: device,
      before: page.next,
    })
      .then((p) =>
        setPage((old) => ({ items: [...old.items, ...p.items], next: p.next })),
      )
      .finally(() => {
        loading.current = false;
      });
  };
  return (
    <div className="relay-history">
      <div className="relay-history-search">
        <Search size={16} />
        <input
          aria-label="搜索浏览记录"
          placeholder="搜索浏览记录"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="relay-device-filters">
        {[
          { id: "", name: "全部" },
          ...s.status.devices.map((d) => ({
            id: d.deviceId,
            name: d.self ? "本机" : d.name,
          })),
        ].map((d) => (
          <button
            key={d.id}
            aria-pressed={device === d.id}
            onClick={() => setDevice(d.id)}
          >
            {d.name}
          </button>
        ))}
      </div>
      {s.historyGap && <p className="help">部分较早的记录已过期</p>}
      {!page.items.length && !query && !s.options.history ? (
        <div className="relay-empty">
          <p>浏览记录同步未开启</p>
          <Button onClick={onEnable}>开启</Button>
        </div>
      ) : (
        <div className="relay-history-viewport">
          {scroll > 0 && sticky && (
            <div className="relay-sticky-date">{sticky}</div>
          )}
          <div
            ref={scroller}
            className="relay-history-list"
            onScroll={(e) => {
              const el = e.currentTarget;
              setScroll(el.scrollTop);
              if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200)
                loadMore();
            }}
          >
            <div style={{ height: window.total, position: "relative" }}>
              <div style={{ transform: "translateY(" + window.top + "px)" }}>
                {rows.slice(window.start, window.end).map((row) =>
                  row.day ? (
                    <div className="relay-date" key={row.day}>
                      {row.day}
                    </div>
                  ) : (
                    <div
                      className="relay-history-row"
                      key={row.v!.id}
                      data-history-id={row.v!.id}
                    >
                      <time>
                        {new Date(row.v!.at).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                      </time>
                      <SiteIcon url={row.v!.u} title={row.v!.ti} />
                      <a
                        href={row.v!.u}
                        onClick={(e) => {
                          e.preventDefault();
                          openUrl(row.v!.u, e.ctrlKey || e.metaKey);
                        }}
                      >
                        {historyTitle(row.v!)}
                      </a>
                      <small>{domain(row.v!.u)}</small>
                      {!device &&
                        row.v!.dev !==
                          s.status.devices.find((d) => d.self)?.deviceId && (
                          <span className="relay-source">
                            {compactDeviceName(row.v!.dev, s.status.devices)}
                          </span>
                        )}
                      <IconButton
                        label={"删除浏览记录 " + historyTitle(row.v!)}
                        onClick={() => remove(row.v!)}
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  ),
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <footer>
        <button className="text-button" onClick={onClear}>
          清除浏览记录…
        </button>
      </footer>
    </div>
  );
}
function ClearHistory({ close }: { close: () => void }) {
  const [range, setRange] = useState("1"),
    [scope, setScope] = useState("self");
  return (
    <Modal title="清除浏览记录" onClose={close}>
      <h1>清除浏览记录</h1>
      <div className="relay-clear-form">
        <label>时间范围</label>
        <Segments
          id="relay-clear-time"
          value={range}
          onChange={setRange}
          items={[
            { value: "1", label: "过去 1 小时" },
            { value: "24", label: "24 小时" },
            { value: "168", label: "7 天" },
            { value: "0", label: "全部" },
          ]}
        />
        <label>范围</label>
        {[
          { value: "self", label: "仅本机" },
          { value: "all", label: "所有设备" },
        ].map((v) => (
          <Choice
            key={v.value}
            type="radio"
            name="history-scope"
            label={v.label}
            checked={scope === v.value}
            onChange={() => setScope(v.value)}
          />
        ))}
        <p className="help">不会改动其他电脑浏览器自身的历史记录</p>
      </div>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={close}>
          取消
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            const now = Date.now();
            void continuityCommand("delete", {
              range: {
                from: Number(range) ? now - Number(range) * 3600000 : 0,
                to: now,
              },
              scope,
            })
              .then(() => {
                close();
                useStore.getState().toast("已清除浏览记录");
              })
              .catch(errorToast);
          }}
        >
          清除
        </Button>
      </div>
    </Modal>
  );
}
async function applyOption(key: keyof ContinuityOptions, value: unknown) {
  if (
    !ANDROID &&
    extensionEnvironment() &&
    value &&
    ["history", "tabs", "incoming"].includes(key)
  ) {
    const permission =
      key === "incoming" ? "notifications" : (key as "history" | "tabs");
    if (!(await chrome.permissions.request({ permissions: [permission] })))
      return { granted: false };
  }
  return continuityCommand<{ granted: boolean }>("option", { key, value });
}
function SharePermission({
  kind,
  close,
  denied,
}: {
  kind: "history" | "tabs";
  close: () => void;
  denied?: () => void;
}) {
  const text = kind === "history" ? "浏览记录" : "打开的网页";
  useEffect(() => {
    useStore.setState({ continuityConsent: true });
    return () => useStore.setState({ continuityConsent: false });
  }, []);
  return createPortal(
    <Modal
      title={kind === "history" ? "共享浏览记录？" : "共享打开的标签页？"}
      onClose={close}
    >
      <h1>{kind === "history" ? "共享浏览记录？" : "共享打开的标签页？"}</h1>
      <p className="muted">
        本机的{text}
        会在本机加密后，同步到你配对的设备。中转服务器无法读取内容。无痕窗口永远不会被记录。你可以随时关闭并清除。
      </p>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={close}>
          取消
        </Button>
        <Button
          onClick={() =>
            void applyOption(kind, true)
              .then((result) => {
                if (!result.granted) denied?.();
                close();
              })
              .catch(errorToast)
          }
        >
          开启
        </Button>
      </div>
    </Modal>,
    document.body,
  );
}
export function SharingSettings() {
  const s = useContinuity(),
    [permission, setPermission] = useState<"history" | "tabs" | null>(null),
    [denied, setDenied] = useState(""),
    [site, setSite] = useState("");
  const rows: { key: keyof ContinuityOptions; label: string; help?: string }[] =
    [
      { key: "profile", label: "个人资料与头像" },
      {
        key: "background",
        label: "背景图片",
        help: "本地上传的图片会加密同步",
      },
      {
        key: "history",
        label: "浏览记录",
        help: "端到端加密，保留 " + s.options.retentionDays + " 天",
      },
      {
        key: "tabs",
        label: "打开的标签页",
        help: "让其他设备看到本机打开的网页",
      },
      { key: "search", label: "搜索记录" },
      { key: "incoming", label: "接收发送的网页", help: "收到时显示系统通知" },
      { key: "resume", label: "显示「继续浏览」" },
    ];
  return (
    <div className="relay-sharing" id="settings-sharing">
      <h3>同步内容</h3>
      <div className="relay-setting-row">
        <span>
          书签、分组与设置<small>始终同步</small>
        </span>
        <button
          role="switch"
          aria-label="书签、分组与设置"
          aria-checked="true"
          className="toggle on"
          disabled
        >
          <span style={{ transform: "translateX(14px)" }} />
        </button>
      </div>
      {rows.map((row) => (
        <div key={row.key}>
          <div className="relay-setting-row">
            <span>
              {row.label}
              {row.help && <small>{row.help}</small>}
              {denied === row.key && <small>需要授权才能开启</small>}
            </span>
            <Toggle
              label={row.label}
              value={!!s.options[row.key]}
              onChange={() => {
                if (
                  !s.options[row.key] &&
                  (row.key === "history" || row.key === "tabs")
                )
                  setPermission(row.key);
                else
                  void applyOption(row.key, !s.options[row.key])
                    .then((r) => {
                      if (!r.granted) setDenied(row.key);
                    })
                    .catch(errorToast);
              }}
            />
          </div>
          {row.key === "history" && s.options.history && (
            <motion.div
              className="relay-history-options"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="relay-setting-row">
                <span>保留时间</span>
                <Segments
                  id="history-retention"
                  value={String(s.options.retentionDays)}
                  onChange={(v) => void applyOption("retentionDays", Number(v))}
                  items={[
                    { value: "30", label: "30 天" },
                    { value: "90", label: "90 天" },
                  ]}
                />
              </div>
              <label>不记录的网站</label>
              {s.options.excluded.map((host) => (
                <div className="hidden-site" key={host}>
                  {host}
                  <IconButton
                    label={"移除排除网站 " + host}
                    onClick={() =>
                      void applyOption(
                        "excluded",
                        s.options.excluded.filter((s) => s !== host),
                      )
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const host = excludedHost(site.trim());
                  if (host) {
                    void applyOption("excluded", [
                      ...new Set([...s.options.excluded, host]),
                    ]);
                    setSite("");
                  }
                }}
              >
                <input
                  aria-label="不记录的网站"
                  placeholder="添加网站，例如 bank.com"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                />
                <Button type="submit" variant="secondary">
                  添加
                </Button>
              </form>
            </motion.div>
          )}
        </div>
      ))}
      <AnimatePresence>
        {permission && (
          <SharePermission
            kind={permission}
            close={() => setPermission(null)}
            denied={() => setDenied(permission)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
export function ResumePill() {
  const s = useContinuity(),
    [ready, setReady] = useState(false),
    [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    return visibleTimeout(() => setReady(true), 600);
  }, []);
  const self = s.status.devices.find((d) => d.self)?.deviceId;
  const own = [
    ...(s.localUrls || []),
    ...(s.slots
      .find((slot) => slot.dev === self)
      ?.payload.windows.flatMap((w) => w.tabs.map((t) => t.u)) || []),
  ];
  const candidates = s.slots
    .filter(
      (slot) =>
        slot.dev !== self &&
        slot.payload.last &&
        slot.payload.last.at >= Date.now() - 30 * 60000 &&
        !own.includes(slot.payload.last.u) &&
        !hidden.includes(slot.payload.last.u),
    )
    .sort((a, b) => (b.payload.last?.at || 0) - (a.payload.last?.at || 0));
  const slot = candidates[0],
    last = slot?.payload.last,
    device = s.status.devices.find((d) => d.deviceId === slot?.dev),
    Icon = platformIcon(device?.platform || "");
  if (!ready || !s.options.resume || !last || !s.status.paired) return null;
  return (
    <motion.div
      className="relay-resume"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motionTransition(spring.smooth)}
    >
      <button onClick={() => openUrl(last.u)}>
        <span className="relay-resume-icon">
          <Icon size={14} />
        </span>
        <small>继续浏览</small>
        <span className="relay-resume-title">{last.ti || last.u}</span>
        <small>· {compactDeviceName(slot.dev, s.status.devices)}</small>
        <ArrowUpRight size={14} />
      </button>
      <IconButton
        label="隐藏继续浏览"
        onClick={() => setHidden([...hidden, last.u])}
      >
        <X size={14} />
      </IconButton>
    </motion.div>
  );
}
async function sendCurrent(deviceId: string, url?: string, title?: string) {
  if (!ANDROID && extensionEnvironment() && !url) {
    const tab = (
      await chrome.tabs.query({ active: true, currentWindow: true })
    )[0];
    if (tab?.incognito) return;
    url = tab?.url;
    title = tab?.title;
  }
  if (!url || !normalizeUrl(url)) {
    useStore.getState().toast("这个页面无法发送");
    return false;
  }
  try {
    await continuityCommand("sendToDevice", {
      deviceId,
      url,
      title: title || url,
    });
    const device = useContinuity
      .getState()
      .status.devices.find((d) => d.deviceId === deviceId);
    useStore
      .getState()
      .toast(
        device?.online
          ? "已发送到 " + device.name
          : (device?.name || "设备") + " 上线后会收到",
      );
    return true;
  } catch (e) {
    errorToast(e);
    return false;
  }
}
export function SendRow({ url, title }: { url: string; title: string }) {
  const s = useContinuity(),
    [sent, setSent] = useState<string[]>([]),
    [more, setMore] = useState(false),
    [count, setCount] = useState(0),
    rail = useRef<HTMLDivElement>(null),
    measure = useRef<HTMLDivElement>(null),
    overflow = useRef<HTMLButtonElement>(null),
    devices = otherDevices(s.status);
  const closeMenu = useCallback(() => setMore(false), []);
  useLayoutEffect(() => {
    const fit = () => {
      if (!rail.current || !measure.current) return;
      const widths = Array.from(
        measure.current.children,
        (el) => el.getBoundingClientRect().width,
      );
      const moreWidth = widths.pop() || 28;
      setCount(fittingPills(widths, rail.current.clientWidth, moreWidth));
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (rail.current) observer.observe(rail.current);
    if (measure.current) observer.observe(measure.current);
    void document.fonts.ready.then(fit);
    return () => observer.disconnect();
  }, [s.status.devices]);
  if (!devices.length) return null;
  const send = (id: string) => {
    setMore(false);
    void sendCurrent(id, url, title).then((ok) => {
      if (ok) setSent((old) => [...old, id]);
    });
  };
  const contents = (d: (typeof devices)[number]) => {
    const Icon = platformIcon(d.platform);
    return (
      <>
        {sent.includes(d.deviceId) ? (
          <Check size={14} color="var(--success)" />
        ) : (
          <Icon size={14} />
        )}
        {compactDeviceName(d.deviceId, s.status.devices)}
      </>
    );
  };
  const bounds = overflow.current?.getBoundingClientRect();
  return (
    <div className="relay-send-row">
      <small>发送到</small>
      <div ref={rail} className="relay-send-rail">
        {devices.slice(0, count).map((d) => (
          <button
            key={d.deviceId}
            className="relay-send-pill"
            title={d.name}
            style={{ opacity: d.online ? 1 : 0.6 }}
            onClick={() => send(d.deviceId)}
          >
            {contents(d)}
          </button>
        ))}
        {count < devices.length && (
          <button
            ref={overflow}
            className="relay-send-pill"
            aria-label="更多设备"
            aria-haspopup="menu"
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            ···
          </button>
        )}
        <div ref={measure} className="relay-send-measure" aria-hidden="true">
          {devices.map((d) => (
            <span key={d.deviceId} className="relay-send-pill">
              {contents(d)}
            </span>
          ))}
          <span className="relay-send-pill">···</span>
        </div>
      </div>
      {createPortal(
        <AnimatePresence>
          {more && bounds && (
            <Menu
              label="发送到设备"
              onClose={closeMenu}
              style={{
                position: "fixed",
                width: 200,
                left: Math.max(
                  8,
                  Math.min(bounds.right - 200, innerWidth - 208),
                ),
                top: Math.max(
                  8,
                  Math.min(
                    bounds.bottom + 8,
                    innerHeight - (devices.length - count) * 40 - 16,
                  ),
                ),
                maxHeight: "calc(100vh - 16px)",
                overflowY: "auto",
              }}
            >
              {devices.slice(count).map((d, i) => (
                <MenuItem
                  key={d.deviceId}
                  index={i}
                  onClick={() => send(d.deviceId)}
                >
                  {contents(d)}
                </MenuItem>
              ))}
            </Menu>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
