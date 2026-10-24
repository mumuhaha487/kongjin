import { afterPaintIdle } from "../../lib/after-paint";
import { useShallow } from "zustand/react/shallow";
import { LayoutButton } from "../../lib/layout-budget";
import { useState, useEffect } from "react";
import { AnimatePresence } from "motion/react";
import { Moon, Sun, Settings, Camera, Link, Download } from "lucide-react";
import { useStore } from "../../app/store";
import { Logo } from "../Logo/Logo";
import { TileIcon } from "../TileIcon/TileIcon";
import { Menu, MenuItem } from "../Common/Common";
import { deviceLabel } from "../../lib/platform";
import { ANDROID, STORE } from "../../lib/build";
import { RelayButton } from "../../features/continuity/RelayButton";
export function Header() {
  useStore(
    useShallow((s) => [s.status, s.data.profile, s.data.settings.theme]),
  );
  const s = useStore.getState(),
    p = s.data.profile,
    [me, setMe] = useState(false),
    [warm, setWarm] = useState(false),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(p.nickname);
  useEffect(() => afterPaintIdle(() => setWarm(true)), []);
  const [systemLight, setSystemLight] = useState(
    () => matchMedia("(prefers-color-scheme: light)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: light)");
    const update = () => setSystemLight(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const light =
    s.data.settings.theme === "light" ||
    (s.data.settings.theme === "system" && systemLight);
  const paired = s.status.paired,
    status = paired
      ? "已配对 · " + s.status.devices.length + " 台设备"
      : "仅本机";
  function settings(section = "") {
    setMe(false);
    useStore.setState({ settingsOpen: true, settingsSection: section });
  }
  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          <Logo size={22} />
          <span>空境</span>
        </div>
        <div className="header-actions">
          {!STORE && <RelayButton />}
          <button
            className="icon-button theme-button"
            aria-label="切换主题"
            onClick={() =>
              s.setting(
                "theme",
                document.documentElement.dataset.theme === "dark"
                  ? "light"
                  : "dark",
              )
            }
          >
            <span key={s.data.settings.theme} className="theme-glyph">
              {light ? <Sun size={18} /> : <Moon size={18} />}
            </span>
          </button>
          {!ANDROID && (
            <button
              className="icon-button settings-trigger"
              aria-label="设置"
              onClick={() => settings()}
            >
              <Settings size={18} />
            </button>
          )}
          <div className="avatar-anchor">
            <button
              className="avatar-trigger"
              aria-label="我的"
              onClick={() => setMe(!me)}
            >
              <TileIcon
                title={p.nickname}
                url={p.nickname}
                avatar
                src={p.avatar}
              />
              {paired && (
                <span
                  className={
                    "pair-dot " +
                    (s.status.syncing ? "syncing" : s.status.connection)
                  }
                />
              )}
            </button>
            <div role="tooltip" className="avatar-tooltip glass">
              <span>{p.nickname || "设置昵称"}</span>
              <small>{status}</small>
            </div>
          </div>
        </div>
      </header>
      <AnimatePresence>
        {(me || (ANDROID && warm)) && (
          <Menu
            active={me}
            label="我的"
            onClose={() => setMe(false)}
            style={{
              position: "fixed",
              right: 24,
              top: 68,
              width: 300,
              padding: 16,
              borderRadius: "var(--r-lg)",
              transformOrigin: "top right",
            }}
          >
            <div className="me-summary">
              <LayoutButton
                layoutId={ANDROID ? undefined : "profile-avatar"}
                aria-label="编辑头像"
                className="me-avatar"
                onClick={() => {
                  setMe(false);
                  s.open({ type: "avatar", source: "profile-avatar" });
                }}
              >
                <TileIcon
                  title={p.nickname}
                  url={p.nickname}
                  avatar
                  src={p.avatar}
                />
                <span className="camera-overlay">
                  <Camera size={18} />
                  更换
                </span>
              </LayoutButton>
              <div>
                {editing ? (
                  <input
                    aria-label="昵称"
                    autoFocus
                    maxLength={20}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => {
                      s.profile({ nickname: name.trim() });
                      setEditing(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setEditing(false);
                    }}
                  />
                ) : (
                  <button
                    className="nickname-edit"
                    onClick={() => {
                      setName(p.nickname);
                      setEditing(true);
                    }}
                  >
                    {p.nickname || "设置昵称"}
                  </button>
                )}
                <small>{deviceLabel()}</small>
              </div>
            </div>
            <div className="menu-divider" />
            <MenuItem
              onClick={() => {
                setMe(false);
                s.open({ type: "avatar", source: "profile-avatar" });
              }}
            >
              <Camera size={16} />
              编辑头像
            </MenuItem>
            <MenuItem index={1} onClick={() => settings("pairing")}>
              <Link size={16} />
              配对与同步<small className="menu-status">{status}</small>
            </MenuItem>
            <MenuItem index={2} onClick={() => settings("data")}>
              <Download size={16} />
              导入与导出
            </MenuItem>
            <MenuItem index={3} onClick={() => settings()}>
              <Settings size={16} />
              设置
            </MenuItem>
          </Menu>
        )}
      </AnimatePresence>
    </>
  );
}
