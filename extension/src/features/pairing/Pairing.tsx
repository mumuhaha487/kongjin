import { useShallow } from "zustand/react/shallow";
import { LayoutDiv } from "../../lib/layout-budget";
import { PairQr } from "./PairQr";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  useLayoutEffect,
  useRef,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { Monitor, Laptop, Smartphone, ShieldOff } from "lucide-react";
import { Modal, Button } from "../../components/Common/Common";
import { useStore } from "../../app/store";
import { deviceLabel } from "../../lib/platform";
import { pairCommand } from "./bridge";
import { privacyUrl } from "../../lib/build";
import { ANDROID, STORE } from "../../lib/build";
const SharingSettings = !STORE
  ? lazy(() =>
      import("../continuity/RelayUI").then((m) => ({
        default: m.SharingSettings,
      })),
    )
  : () => null;
import { nativeCall } from "../../platform/native";
import {
  onPageVisibility,
  pageVisible,
  visibleTimeout,
} from "../../lib/visibility";
import { relativeTime, syncMessage, syncPhase, syncFooter } from "./status";
const V3Advanced = lazy(() => import("./V3Advanced").then((m) => ({ default: m.V3Advanced })));
import {
  formatPairCode,
  formatSas,
  normalizePairCode,
  displayPairInput,
  pairingError,
} from "./types";
export function PairIllustration({ state = "intro" }: { state?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (
      state !== "success" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    for (const circle of ref.current?.querySelectorAll<HTMLElement>(
      ".pair-point",
    ) || []) {
      const start = new DOMMatrix(getComputedStyle(circle).transform);
      circle.style.animation = "none";
      let x = 1,
        v = 0;
      const frames: Keyframe[] = [];
      for (let i = 0; i <= 48; i++) {
        frames.push({
          transform: `translate(${start.e * x}px,${start.f * x}px)`,
          opacity: i === 48 ? 0 : 1,
        });
        v += (-300 * x - 32 * v) / 120;
        x += v / 120;
      }
      circle.animate(frames, { duration: 400, fill: "both" });
    }
  }, [state]);
  return (
    <div ref={ref} className={"pair-illustration " + state} aria-hidden="true">
      <svg viewBox="0 0 72 72">
        <g transform="rotate(-12 36 36)">
          <ellipse
            cx="36"
            cy="36"
            rx="30"
            ry="10"
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth="1.5"
          />
        </g>
        {state === "success" ? (
          <path
            className="pair-check"
            d="m26 36 7 7 14-16"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M36 28 C37 33 39 35 44 36 C39 37 37 39 36 44 C35 39 33 37 28 36 C33 35 35 33 36 28Z"
            fill="var(--text)"
          />
        )}
      </svg>
      <div className="orbit-points">
        <span className="pair-point" />
        <span className="pair-point second" />
      </div>
    </div>
  );
}
const notice = STORE
  ? "同步经由所选 Cloudflare 或 EO 服务器中转，数据在本机加密。网络恢复后会重试；使用备案域名部署 EO 可改善国内连接体验。"
  : "优先通过设备直连同步，无法直连时使用同步服务器中转；数据端到端加密，服务器只能看到密文。";
export const platformIcon = (platform: string) =>
  /phone|android|ios/i.test(platform)
    ? Smartphone
    : /mac|laptop/i.test(platform)
      ? Laptop
      : Monitor;
export function JoinRetryContent({ failed }: { failed: boolean }) {
  return (
    <>
      <PairIllustration state={failed ? "failure" : "preparing"} />
      <h1>{failed ? "没有完成加入" : "正在完成加入…"}</h1>
      <p className={failed ? "muted" : "help"}>
        {failed
          ? "网络恢复后可以继续，不需要重新输入配对码。"
          : "请保持网络连接，网络不稳定时会自动重试"}
      </p>
      <div className="pair-actions">
        {failed && (
          <Button onClick={() => void pairCommand("retry-join")}>重试</Button>
        )}
        <Button variant="secondary" onClick={() => void pairCommand("cancel")}>
          取消
        </Button>
      </div>
    </>
  );
}
export function PairingDialog() {
  const s = useStore(
      useShallow((s) => ({
        status: s.status,
        pair: s.pair,
        overlay: s.overlay,
        open: s.open,
        toast: s.toast,
      })),
    ),
    p = s.pair,
    [code, setCode] = useState(p.code ? formatPairCode(p.code) : ""),
    [name, setName] = useState(deviceLabel),
    [now, setNow] = useState(Date.now()),
    [decoded, setDecoded] = useState(""),
    reduce = useReducedMotion();
  useEffect(() => {
    if (p.view === "join" && p.code) setCode(formatPairCode(p.code));
  }, [p.view, p.code]);
  useEffect(
    () => () => {
      void pairCommand(STORE ? "cancel" : "detach");
    },
    [],
  );
  useEffect(() => {
    if (p.view !== "invite") return;
    let timer: ReturnType<typeof setInterval>;
    const update = () => {
      clearInterval(timer);
      if (pageVisible()) {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 250);
      }
    };
    const unsubscribe = onPageVisibility(update);
    update();
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [p.view]);
  useEffect(() => {
    if (p.view !== "success") return;
    if (ANDROID) nativeCall("haptic", "success");
    return visibleTimeout(() => s.open(null), 1400);
  }, [p.view]);
  useEffect(() => {
    if (!p.code) return;
    const target = formatPairCode(p.code);
    if (reduce) {
      setDecoded(target);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      if (!pageVisible()) return;
      const progress = (performance.now() - started) / 760;
      setDecoded(
        [...target]
          .map((c, i) =>
            c === "-" || i < progress * target.length
              ? c
              : "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[
                  Math.floor(Math.random() * 32)
                ],
          )
          .join(""),
      );
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    tick();
    const unsubscribe = onPageVisibility(() => {
      cancelAnimationFrame(frame);
      if (pageVisible()) tick();
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [p.code, reduce]);
  const remaining = Math.max(0, Math.ceil(((p.expiresAt || 0) - now) / 1000));
  const title =
    p.view === "completing"
      ? "正在完成加入…"
      : p.view === "join-failed"
        ? "没有完成加入"
        : p.view === "intro"
          ? "实时配对"
          : p.view === "preparing"
            ? "正在建立安全通道…"
            : p.view === "invite"
              ? "添加设备"
              : p.view === "join"
                ? "加入配对组"
                : p.view === "sas"
                  ? "核对安全码"
                  : p.view === "success"
                    ? "配对成功"
                    : pairingError(p.error || "NETWORK", p.retryAfter);
  return (
    <Modal
      title={title}
      source={s.overlay?.source}
      shake={p.view === "failure" ? 1 : 0}
    >
      <div className="pair-content">
        {(p.view === "completing" || p.view === "join-failed") ? (
          <JoinRetryContent failed={p.view === "join-failed"} />
        ) : (
          <>
            <PairIllustration state={p.view} />
            <h1>{title}</h1>
          </>
        )}
        {p.view === "intro" && (
          <>
            <p className="muted">在你的多台设备之间同步书签、设置和头像。</p>
            <div className="pair-actions vertical">
              {ANDROID && (
                <Button onClick={() => void pairCommand("join-view")}>
                  加入已有配对组
                </Button>
              )}
              <Button
                variant={ANDROID ? "secondary" : "primary"}
                onClick={() => void pairCommand("create", { name })}
              >
                创建配对组
              </Button>
              {!ANDROID && (
                <Button
                  variant="secondary"
                  onClick={() => void pairCommand("join-view")}
                >
                  加入已有配对组
                </Button>
              )}
            </div>
            <p className="fixed-notice">{notice}</p>
            <a
              className="pair-privacy"
              href={privacyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              隐私政策
            </a>
          </>
        )}
        {p.view === "preparing" && <p className="help">首次需要几秒钟</p>}
        {p.view === "invite" && (
          <>
            {remaining ? (
              <>
                <div className="pair-code" aria-label={decoded}>
                  {ANDROID ? (
                    <>
                      <span>{decoded.slice(0, 8)}</span>
                      <span className="pair-code-separator">-</span>
                      <span>{decoded.slice(9)}</span>
                    </>
                  ) : (
                    decoded
                  )}
                </div>
                <PairQr code={p.code || ""} />
                <div className="countdown">
                  <svg width="20" height="20" viewBox="0 0 20 20">
                    <circle
                      cx="10"
                      cy="10"
                      r="8"
                      fill="none"
                      stroke="var(--border)"
                      strokeWidth="2"
                    />
                    <circle
                      cx="10"
                      cy="10"
                      r="8"
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth="2"
                      strokeDasharray="50.265"
                      strokeDashoffset={50.265 * (1 - remaining / 600)}
                      transform="rotate(-90 10 10)"
                    />
                  </svg>
                  {String(Math.floor(remaining / 60)).padStart(2, "0")}:
                  {String(remaining % 60).padStart(2, "0")} 后失效
                </div>
                <p className="muted">
                  在另一台设备上打开空境 → 设置 → 配对与同步 →
                  加入已有配对组，输入这个配对码。
                </p>
                <div className="pair-actions">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(formatPairCode(p.code || ""))
                        .then(() => s.toast("已复制配对码"))
                    }
                  >
                    复制配对码
                  </Button>
                  <button
                    className="text-button"
                    onClick={() => {
                      void pairCommand("cancel");
                      s.open(null);
                    }}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="pair-code">配对码已失效</div>
                <Button onClick={() => void pairCommand("invite")}>
                  重新生成
                </Button>
              </>
            )}
          </>
        )}
        {p.view === "join" && (
          <>
            <input
              className="pair-input"
              aria-label="配对码"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              placeholder="KJ-XXXXX-XXXXX"
              value={code}
              onChange={(e) => setCode(displayPairInput(e.target.value))}
            />
            <input
              aria-label="本机名称"
              placeholder="本机名称"
              value={name}
              maxLength={32}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="pair-actions">
              <Button
                disabled={!normalizePairCode(code) || !name.trim()}
                onClick={() =>
                  void pairCommand("join", {
                    code: normalizePairCode(code)!,
                    name,
                  })
                }
              >
                连接
              </Button>
            </div>
            <p className="fixed-notice">{notice}</p>
          </>
        )}
        {p.view === "sas" && (
          <>
            <div className="sas-code">
              {[...formatSas(p.sas || "")].map((c, i) => (
                <motion.span
                  key={i}
                  initial={{ y: 8, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{
                    delay: (i - (i > 3 ? 1 : 0)) * 0.04,
                    duration: 0.2,
                  }}
                >
                  {c}
                </motion.span>
              ))}
            </div>
            <p className="help">对方设备：{p.peerName}</p>
            <p className="muted">
              请确认两台设备上的数字完全一致。如果不一致，说明连接可能被第三方截获，请取消。
            </p>
            <div className="pair-actions">
              <Button
                variant="secondary"
                className="danger-text"
                onClick={() => {
                  void pairCommand("cancel", { reason: "SAS_MISMATCH" });
                }}
              >
                不一致
              </Button>
              <Button
                busy={p.waiting}
                onClick={() => void pairCommand("confirm")}
              >
                {p.waiting ? "等待对方确认…" : "一致"}
              </Button>
            </div>
          </>
        )}
        {p.view === "success" && (
          <div className="device-pills">
            {s.status.devices.map((d, i) => {
              const Icon =
                ANDROID && d.self ? Smartphone : platformIcon(d.platform);
              return (
                <motion.span
                  key={d.deviceId}
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: i * 0.06 }}
                >
                  <Icon size={18} />
                  {d.name}
                </motion.span>
              );
            })}
          </div>
        )}
        {p.view === "failure" && (
          <div className="pair-actions">
            <Button onClick={() => void pairCommand("intro")}>重试</Button>
            <Button variant="secondary" onClick={() => s.open(null)}>
              关闭
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
export function PairingSettings() {
  const s = useStore(),
    status = s.status,
    [renaming, setRenaming] = useState(false),
    [deviceName, setDeviceName] = useState("");
  const start = (action: string) => {
    s.open({ type: "pairing", source: "pairing-trigger" });
    void pairCommand(action);
  };
  return (
    <section id="settings-pairing">
      <h3>配对与同步</h3>
      {status.removedNotice && (
        <div className="removed-notice" role="status">
          <ShieldOff size={18} aria-hidden="true" />
          <div>
            <strong>本设备已被移出配对组</strong>
            <p>
              {new Date(status.removedNotice.at).toLocaleString("zh-CN", {
                hour12: false,
              })}
              。书签和设置已保留在本机，不会再同步到其他设备。
            </p>
          </div>
          <button
            className="text-button"
            onClick={() => void pairCommand("dismiss-removed-notice")}
          >
            知道了
          </button>
        </div>
      )}
      {status.joinPhase ? (
        <div
          className="pair-summary-card pair-content"
          data-join-phase={status.joinPhase}
        >
          <JoinRetryContent failed={status.joinPhase === "failed"} />
        </div>
      ) : !status.paired ? (
        <LayoutDiv layoutId="pairing-trigger" className="pair-summary-card">
          <div className="pair-summary-heading">
            <PairIllustration />
            <div>
              <strong>实时配对</strong>
              <small>端到端加密，在多台设备间同步</small>
            </div>
          </div>
          <div className="button-row">
            {ANDROID && (
              <Button onClick={() => start("join-view")}>加入已有配对组</Button>
            )}
            <Button
              variant={ANDROID ? "secondary" : "primary"}
              onClick={() => start("create")}
            >
              创建配对组
            </Button>
            {!ANDROID && (
              <Button variant="secondary" onClick={() => start("join-view")}>
                加入已有配对组
              </Button>
            )}
          </div>
        </LayoutDiv>
      ) : (
        <>
          <button
            className={
              "status-line " +
              syncPhase(status) +
              (!STORE && status.transport ? " " + status.transport : "")
            }
            onClick={() => void pairCommand("sync")}
          >
            <span className="status-point" />
            {STORE ? syncMessage(status) : syncFooter(status)}
            {STORE &&
              syncPhase(status) === "online" &&
              " · " + status.devices.length + " 台设备"}
            <small>
              {STORE && status.lastSyncAt
                ? relativeTime(status.lastSyncAt) + "同步"
                : ""}
            </small>
          </button>
          <div className="device-list">
            {status.devices.map((d) => {
              const Icon =
                ANDROID && d.self ? Smartphone : platformIcon(d.platform);
              return (
                <div className="device-row" key={d.deviceId}>
                  <Icon size={20} aria-hidden="true" />
                  <div className="device-info">
                    {d.self && renaming ? (
                      <input
                        autoFocus
                        aria-label="本机名称"
                        maxLength={32}
                        value={deviceName}
                        onChange={(e) => setDeviceName(e.target.value)}
                        onBlur={() => {
                          if (deviceName.trim())
                            void pairCommand("rename", {
                              name: deviceName.trim(),
                            });
                          setRenaming(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") setRenaming(false);
                        }}
                      />
                    ) : (
                      <span className="device-name" title={d.name}>
                        {d.name}
                      </span>
                    )}
                    <div className="device-meta">
                      {!STORE && d.joining ? (
                        <span className="self-pill joining-pill">等待加入</span>
                      ) : d.self ? (
                        <span className="self-pill">本机</span>
                      ) : (
                        <span className="device-presence">
                          <i
                            className={
                              "device-online" + (d.online ? "" : " offline")
                            }
                            aria-hidden="true"
                          />
                          {d.online ? "在线" : "离线"}
                        </span>
                      )}
                      {!STORE && !d.joining && (
                        <span
                          className={
                            "transport-pill " +
                            (d.online ? d.transport : "offline")
                          }
                        >
                          {!d.online || d.transport === "offline"
                            ? "离线"
                            : d.transport === "direct"
                              ? "直连"
                              : "中转"}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className={
                      d.self ? "text-button" : "text-button danger-text"
                    }
                    onClick={() => {
                      if (d.self) {
                        setDeviceName(d.name);
                        setRenaming(true);
                      } else
                        s.open({
                          type: "remove-device",
                          id: d.deviceId,
                          name: d.name,
                        });
                    }}
                  >
                    {d.self ? "重命名" : "移除"}
                  </button>
                </div>
              );
            })}
          </div>
          {!STORE && (
            <Suspense fallback={null}>
              <SharingSettings />
            </Suspense>
          )}
          <div className="button-row">
            <Button onClick={() => start("invite")}>添加设备</Button>
            <Button
              variant="secondary"
              onClick={() => void pairCommand("sync")}
            >
              立即同步
            </Button>
          </div>
          <button
            className="text-button danger-text"
            onClick={() => s.open({ type: "leave" })}
          >
            离开配对组
          </button>
        </>
      )}
      {status.error && (STORE || !status.joinPhase) && (
        <p className="field-error">
          {/^[A-Z_]+$/.test(status.error)
            ? pairingError(status.error)
            : status.error}
        </p>
      )}
      <Suspense fallback={null}><V3Advanced /></Suspense>
    </section>
  );
}
