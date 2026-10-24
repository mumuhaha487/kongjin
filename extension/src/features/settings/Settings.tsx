import { SheetFrame } from "../../components/Common/Sheet";
import { useShallow } from "zustand/react/shallow";
import {
  Profiler,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { profileRender } from "../../lib/profile-render";
import { motion, useDragControls } from "motion/react";
import { X, Check } from "lucide-react";
import { useStore, resetData, importData } from "../../app/store";
import { accents, type Settings } from "../../lib/model";
import { ANDROID, STORE, version, privacyUrl } from "../../lib/build";
import { normalizeUrl } from "../../lib/validation";
import { extensionEnvironment, imageFile } from "../../lib/storage";
import {
  Button,
  IconButton,
  Segments,
  Toggle,
  useFocusTrap,
  Dropdown,
} from "../../components/Common/Common";
import { TileIcon } from "../../components/TileIcon/TileIcon";
import { PairingSettings } from "../pairing/Pairing";
import { DataSettings } from "../data/DataSettings";
import { pairCommand } from "../pairing/bridge";
import { spring, motionTransition } from "../../lib/motion";
import { BrowserSettings } from "../../platform/BrowserSettings";
import { nativeCall, androidVersion } from "../../platform/native";
import { fillMissingIcons } from "../bookmarks/icons";
export function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}
const toggle = (field: keyof Settings, label: string) => (
  <SettingToggle field={field} label={label} />
);
const segments = (
  field: keyof Settings,
  items: { value: string; label: string }[],
) => <SettingSegments field={field} items={items} />;

const ProfileSection = memo(function ProfileSection() {
  useStore(useShallow((s) => [s.data.profile]));
  const s = useStore.getState();

  return (
    <section id="settings-profile">
      <h3>我的</h3>
      <div className="profile-setting">
        <button
          aria-label="编辑头像"
          onClick={() => s.open({ type: "avatar" })}
        >
          <TileIcon
            title={s.data.profile.nickname}
            url={s.data.profile.nickname}
            avatar
            src={s.data.profile.avatar}
          />
        </button>
        <input
          aria-label="昵称"
          placeholder="设置昵称"
          maxLength={20}
          value={s.data.profile.nickname}
          onChange={(e) => s.profile({ nickname: e.target.value })}
        />
      </div>
    </section>
  );
});

const AppearanceSection = memo(function AppearanceSection() {
  useStore(
    useShallow((s) => [s.data.settings.background, s.data.settings.imageUrl]),
  );
  const s = useStore.getState(),
    settings = s.data.settings;
  const upload = useRef<HTMLInputElement>(null);
  return (
    <section id="settings-appearance">
      <h3>外观</h3>
      <Row label="主题">
        {segments("theme", [
          { value: "system", label: "跟随系统" },
          { value: "light", label: "浅色" },
          { value: "dark", label: "深色" },
        ])}
      </Row>
      <Row label="强调色">
        <AccentColors />
      </Row>
      <Row label="背景">
        {segments("background", [
          { value: "kongjing", label: "空境" },
          { value: "solid", label: "纯色" },
          { value: "image", label: "图片" },
        ])}
      </Row>
      {settings.background === "image" && (
        <>
          <input
            aria-label="背景图片网址"
            placeholder="图片网址"
            value={settings.imageUrl === "local" ? "" : settings.imageUrl}
            onChange={(e) => s.setting("imageUrl", e.target.value)}
          />
          <Button variant="secondary" onClick={() => upload.current?.click()}>
            上传图片
          </Button>
          <input
            hidden
            ref={upload}
            type="file"
            accept="image/*"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                try {
                  if (!STORE) {
                    const { shareBackground } = await import(
                      "../continuity/background-image"
                    );
                    const reference = await shareBackground(file);
                    if (reference)
                      s.update((d) =>
                        Object.assign(d.settings, {
                          backgroundImage: reference,
                        }),
                      );
                  } else await imageFile(file);
                  s.setting("imageUrl", "local");
                } catch (error) {
                  s.toast(
                    error instanceof Error ? error.message : "无法读取这张图片",
                  );
                }
              }
            }}
          />
        </>
      )}
      <Row label="背景动效">{toggle("animated", "背景动效")}</Row>
      <Row label="流畅优先">{toggle("smoothFirst", "流畅优先")}</Row>
      <Row label="颗粒质感">{toggle("grain", "颗粒质感")}</Row>
    </section>
  );
});

const ClockSection = memo(function ClockSection() {
  return (
    <section>
      <h3>时钟与问候</h3>
      <Row label="24 小时制">{toggle("hour24", "24 小时制")}</Row>
      <Row label="显示秒数">{toggle("seconds", "显示秒数")}</Row>
      <Row label="显示问候">{toggle("greeting", "显示问候")}</Row>
    </section>
  );
});

const SearchSection = memo(function SearchSection() {
  useStore(useShallow((s) => [s.data.searchEngines]));
  const s = useStore.getState();
  const [engineName, setEngineName] = useState(""),
    [engineUrl, setEngineUrl] = useState("");
  return (
    <section>
      <h3>搜索</h3>
      {!ANDROID && (
        <p className="search-settings-notice">
          搜索使用浏览器的默认搜索引擎，可在 Chrome 设置 →
          搜索引擎中更改。也可以在搜索框左侧临时切换到其他引擎。
        </p>
      )}
      <Row label="新标签页打开">{toggle("newTab", "新标签页打开")}</Row>
      <Row label="搜索历史">{toggle("history", "搜索历史")}</Row>
      <button
        className="text-button"
        onClick={() => {
          useStore.setState({ history: [] });
          void import("../../lib/storage").then(({ storage }) =>
            storage.remove("history"),
          );
          s.toast("已清空搜索历史");
          if (!STORE)
            void import("../continuity/bridge")
              .then(({ continuityCommand }) => continuityCommand("clearSearch"))
              .catch(() => {});
        }}
      >
        清空搜索历史
      </button>
      <details>
        <summary>自定义搜索引擎</summary>
        <input
          aria-label="引擎名称"
          placeholder="引擎名称"
          value={engineName}
          onChange={(e) => setEngineName(e.target.value)}
        />
        <input
          aria-label="搜索地址"
          placeholder="搜索网址，以 %s 代表关键词"
          value={engineUrl}
          onChange={(e) => setEngineUrl(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={
            !engineName.trim() ||
            !engineUrl.includes("%s") ||
            !normalizeUrl(engineUrl.replace("%s", "x"))
          }
          onClick={() => {
            s.update((d) =>
              d.searchEngines.push({
                id: crypto.randomUUID(),
                name: engineName.trim(),
                url: engineUrl,
                updatedAt: Date.now(),
              }),
            );
            setEngineName("");
            setEngineUrl("");
          }}
        >
          添加
        </Button>
        {s.data.searchEngines.map((e) => (
          <div className="hidden-site" key={e.id}>
            {e.name}
            <button
              aria-label={"删除引擎" + e.name}
              onClick={() =>
                s.update((d) => {
                  d.tombstones.push({ id: e.id, kind: "searchEngine", deletedAt: Math.max(Date.now(), e.updatedAt + 1) });
                  d.searchEngines = d.searchEngines.filter(
                    (x) => x.id !== e.id,
                  );
                })
              }
            >
              ×
            </button>
          </div>
        ))}
      </details>
    </section>
  );
});

const BookmarksSection = memo(function BookmarksSection() {
  useStore(useShallow((s) => [s.status.relayUrl]));
  const s = useStore.getState();

  return (
    <section>
      <h3>书签</h3>
      <Row label="图标风格">
        {segments("iconStyle", [
          { value: "favicon", label: "网站图标" },
          { value: "letter", label: "字母" },
        ])}
      </Row>
      <Row label="显示名称">{toggle("labels", "显示名称")}</Row>
      {!ANDROID && (
        <Row label="每行数量">
          {segments(
            "columns",
            [6, 7, 8].map((n) => ({
              value: String(n),
              label: String(n),
            })),
          )}
        </Row>
      )}
      <div className="button-row">
        {!ANDROID && !STORE && (
          <Button
            variant="secondary"
            onClick={() => s.open({ type: "permission", kind: "icons" })}
          >
            允许读取网站图标
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() =>
            void fillMissingIcons(
              () => useStore.getState().data,
              (id, icon) =>
                s.update((d) => {
                  const b = d.bookmarks.find((b) => b.id === id);
                  if (b) {
                    b.icon = icon;
                    b.updatedAt = Date.now();
                  }
                }),
              s.status.relayUrl,
              true,
            ).then(() => s.toast("图标已更新"))
          }
        >
          重新获取全部图标
        </Button>
      </div>
    </section>
  );
});

const QuickSection = memo(function QuickSection() {
  useStore(
    useShallow((s) => [
      s.data.groups,
      s.data.settings.barEnabled,
      s.data.settings.hiddenSites,
      s.data.settings.quickGroup,
    ]),
  );
  const s = useStore.getState(),
    settings = s.data.settings;

  return (
    <section id="settings-bar">
      <h3>空境栏与快速收藏</h3>
      {!ANDROID && (
        <>
          <Row label="空境栏">
            <Toggle
              label="空境栏"
              value={settings.barEnabled}
              onChange={() =>
                settings.barEnabled
                  ? s.setting("barEnabled", false)
                  : s.open({ type: "permission", kind: "bar" })
              }
            />
          </Row>
          <Row label="位置">
            {segments("barPosition", [
              { value: "top", label: "顶部" },
              { value: "left", label: "左侧" },
              { value: "right", label: "右侧" },
            ])}
          </Row>
          {settings.hiddenSites.map((site) => (
            <div className="hidden-site" key={site}>
              {site}
              <button
                aria-label={"取消隐藏" + site}
                onClick={() =>
                  s.setting(
                    "hiddenSites",
                    settings.hiddenSites.filter((x) => x !== site),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </>
      )}
      <Row label="快速收藏默认分组">
        <Dropdown
          label="快速收藏默认分组"
          value={settings.quickGroup}
          onChange={(value) => s.setting("quickGroup", value)}
          items={s.data.groups.map((g) => ({
            value: g.id,
            label: g.name,
          }))}
        />
      </Row>
      <Row label="收藏后自动关闭弹窗">
        {toggle("autoClose", "收藏后自动关闭弹窗")}
      </Row>
      <p className="help">
        Alt+K 打开快速收藏，可在 chrome://extensions/shortcuts 修改
      </p>
    </section>
  );
});

const AboutSection = memo(function AboutSection() {
  return (
    <section id="settings-about">
      <h3>关于</h3>
      <Row label="空境 Kongjing">
        <span className="muted">
          {ANDROID ? androidVersion(version) : version}
        </span>
      </Row>
      <Row label="隐私政策">
        <a
          className="text-button"
          href={privacyUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          查看
        </a>
      </Row>
      {!ANDROID && (
        <p className="help">
          / 搜索 · Ctrl/⌘+K 搜索 · Ctrl/⌘+, 设置
          <br />
          Alt+K 快速收藏{!ANDROID && " · Alt+J 空境栏"}
          <br />
          1–9 切换分组 · Esc 关闭
        </p>
      )}
    </section>
  );
});

function SettingsContent() {
  return (
    <>
      <header>
        <h2>设置</h2>
        <IconButton
          label="关闭设置"
          onClick={() => useStore.setState({ settingsOpen: false })}
        >
          <X size={18} />
        </IconButton>
      </header>
      <div className="settings-content">
        <ProfileSection />
        <PairingSettings />
        <AppearanceSection />
        <ClockSection />
        <SearchSection />
        <BookmarksSection />
        {!ANDROID && <QuickSection />}
        {ANDROID && <BrowserSettings />}
        <DataSettings />
        <AboutSection />
      </div>
    </>
  );
}

const SettingToggle = memo(function SettingToggle({
  field,
  label,
}: {
  field: keyof Settings;
  label: string;
}) {
  const value = useStore((s) => !!s.data.settings[field]);
  return (
    <Profiler id={"setting:" + field} onRender={profileRender}>
      <Toggle
        label={label}
        value={value}
        onChange={() => useStore.getState().setting(field, !value as never)}
      />
    </Profiler>
  );
});
const SettingSegments = memo(
  function SettingSegments({
    field,
    items,
  }: {
    field: keyof Settings;
    items: { value: string; label: string }[];
  }) {
    const value = useStore((s) => String(s.data.settings[field]));
    return (
      <Segments
        id={"settings-" + field}
        items={items}
        value={value}
        onChange={(v) =>
          useStore
            .getState()
            .setting(field, (field === "columns" ? Number(v) : v) as never)
        }
      />
    );
  },
  (a, b) =>
    a.field === b.field &&
    a.items.length === b.items.length &&
    a.items.every(
      (v, i) => v.value === b.items[i].value && v.label === b.items[i].label,
    ),
);
function AccentColors() {
  const accent = useStore((s) => s.data.settings.accent);
  return (
    <div className="accent-colors">
      {accents.map((a, i) => (
        <button
          key={a}
          aria-label={["空蓝", "青岚", "暮霞", "星紫", "樱"][i]}
          className={"accent-dot " + (accent === a ? "selected" : "")}
          style={{ background: "var(--" + a + ")" }}
          onClick={() => useStore.getState().setting("accent", a)}
        >
          {accent === a && <Check size={12} />}
        </button>
      ))}
    </div>
  );
}
const MemoSettingsContent = memo(SettingsContent);
export function SettingsPanel({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLElement>(null),
    drag = useDragControls();
  const { overlay, consent, section } = useStore(
    useShallow((s) => ({
      overlay: !!s.overlay,
      consent: !STORE && !!s.continuityConsent,
      section: s.settingsSection,
    })),
  );
  const close = () => useStore.setState({ settingsOpen: false });
  useFocusTrap(ref, close, false, active && !overlay && !consent, "container");
  useEffect(() => {
    if (ref.current) ref.current.inert = !active || overlay || consent;
  }, [active, overlay, consent]);
  useEffect(() => {
    if (!active || !section) return;
    const t = setTimeout(
      () =>
        document
          .getElementById("settings-" + section)
          ?.scrollIntoView({ block: "start" }),
      200,
    );
    return () => clearTimeout(t);
  }, [active, section]);
  const content = <MemoSettingsContent />;
  if (ANDROID)
    return (
      <SheetFrame
        active={active}
        title="设置"
        panelRef={ref}
        layerClass="settings-layer"
        panelClass="settings-panel glass"
        close={close}
      >
        {content}
      </SheetFrame>
    );
  return (
    <motion.div
      className="settings-layer"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <motion.aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="settings-panel glass"
        drag={false}
        dragControls={drag}
        initial={{ x: 32, opacity: 0 }}
        animate={{ x: 0, y: 0, opacity: 1 }}
        exit={{ x: 32, opacity: 0 }}
        transition={motionTransition(spring.smooth)}
      >
        {content}
      </motion.aside>
    </motion.div>
  );
}

export function Confirmation() {
  const s = useStore(),
    [o] = useState(() => s.overlay!);
  const permission = o.type === "permission",
    bar = o.kind === "bar";
  const title =
    o.type === "clear-browser"
      ? "清除浏览数据？"
      : permission
        ? bar
          ? "在网页中显示空境栏？"
          : "允许读取网站图标？"
        : o.type === "reset"
          ? "恢复默认？"
          : o.type === "replace"
            ? "替换当前数据？"
            : o.type === "leave"
              ? "离开配对组？"
              : "移除「" + o.name + "」？";
  const body =
    o.type === "clear-browser"
      ? "Cookie、缓存、历史"
      : permission
        ? bar
          ? "空境栏会出现在你访问的网页顶部，需要「读取和更改所有网站上的数据」权限才能显示。空境栏不会读取网页内容，只有在你点击「收藏本页」时才读取网址和标题。"
          : "空境会直接访问你收藏的网站首页，只为读取它的图标。不会读取网页里的其他内容，也不会上传任何数据。"
        : o.type === "replace"
          ? "替换后，本机现有的书签和设置将被覆盖。"
          : o.type === "remove-device"
            ? "这台设备将无法再接收同步数据。其余设备会自动更换加密密钥。"
            : o.type === "leave"
              ? "本机数据会保留在这台设备上。"
              : "书签和设置将恢复为默认值。";
  return (
    <>
      <h1>{title}</h1>
      <p className="muted" style={{ marginTop: 16 }}>
        {body}
      </p>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={() => s.open(null)}>
          {permission ? "暂不" : "取消"}
        </Button>
        <Button
          variant={permission ? "primary" : "danger"}
          onClick={() =>
            void (async () => {
              if (permission) {
                const granted =
                  !ANDROID && extensionEnvironment()
                    ? await chrome.permissions.request({
                        origins: ["http://*/*", "https://*/*"],
                        ...(bar ? { permissions: ["scripting"] } : {}),
                      })
                    : false;
                if (granted) {
                  if (bar) s.setting("barEnabled", true);
                  s.toast(bar ? "空境栏已开启" : "已允许读取网站图标");
                } else s.toast("未获得权限");
              } else if (o.type === "clear-browser")
                nativeCall(
                  "clearBrowsingData",
                  JSON.stringify(["cookies", "cache", "history"]),
                );
              else if (o.type === "reset") await resetData();
              else if (o.type === "replace" && o.data) {
                await importData(o.data, true);
                if (o.background)
                  await imageFile(await (await fetch(o.background)).blob());
                s.toast("导入成功");
              } else if (o.type === "remove-device")
                await pairCommand("remove", { id: o.id! });
              else if (o.type === "leave") await pairCommand("leave");
              s.open(null);
            })().catch(() => {})
          }
        >
          {o.type === "clear-browser"
            ? "清除"
            : permission
              ? bar
                ? "开启"
                : "允许"
              : o.type === "reset"
                ? "恢复默认"
                : o.type === "replace"
                  ? "替换"
                  : o.type === "leave"
                    ? "离开"
                    : "移除"}
        </Button>
      </div>
    </>
  );
}
