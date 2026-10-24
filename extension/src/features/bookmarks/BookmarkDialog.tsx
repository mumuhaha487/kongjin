import { useLayoutEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useStore } from "../../app/store";
import { autoTitle, normalizeUrl } from "../../lib/validation";
import { Button, Modal, Segments } from "../../components/Common/Common";
import { TileIcon } from "../../components/TileIcon/TileIcon";
import { removeBookmark } from "./Bookmarks";
import { acquireIcon } from "./icons";
import { compressImage, blobDataUrl, imageTone } from "../../lib/images";
import { extensionEnvironment } from "../../lib/storage";
import type { BookmarkIcon } from "../../lib/model";
import { spring, motionTransition } from "../../lib/motion";
import { STORE, ANDROID } from "../../lib/build";
import { nativeCall } from "../../platform/native";
export function BookmarkDialog({ active = true }: { active?: boolean }) {
  const s = useStore(
      useShallow((s) => ({
        data: s.data,
        status: s.status,
        overlay: s.overlay,
        update: s.update,
        open: s.open,
        toast: s.toast,
      })),
    ),
    lastOverlay = useRef(s.overlay?.type === "bookmark" ? s.overlay : null),
    o = (active && s.overlay?.type === "bookmark"
      ? (lastOverlay.current = s.overlay)
      : lastOverlay.current) || { type: "bookmark" },
    original = s.data.bookmarks.find((b) => b.id === o.id),
    [url, setUrl] = useState(original?.url || ""),
    [title, setTitle] = useState(original?.title || ""),
    [group, setGroup] = useState(
      original?.groupId || o.id || s.data.groups[0].id,
    ),
    [icon, setIcon] = useState<BookmarkIcon>(
      original?.icon || { mode: "auto" },
    ),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [customError, setCustomError] = useState(""),
    [permission, setPermission] = useState(false),
    [allowed, setAllowed] = useState(false),
    upload = useRef<HTMLInputElement>(null),
    [nameEdited, setNameEdited] = useState(!!original);
  useLayoutEffect(() => {
    if (!ANDROID || !active) return;
    setUrl(original?.url || "");
    setTitle(original?.title || "");
    setGroup(original?.groupId || o.id || s.data.groups[0].id);
    setIcon(original?.icon || { mode: "auto" });
    setError("");
    setCustomError("");
    setNameEdited(!!original);
    setPermission(false);
    if (upload.current) upload.current.value = "";
  }, [active, o.id]);
  useEffect(() => {
    if (!ANDROID && !STORE && extensionEnvironment())
      void chrome.permissions
        .contains({ origins: ["<all_urls>"] })
        .then(setAllowed);
  }, []);
  useEffect(() => {
    let mounted = true;
    if (!active || icon.mode !== "auto" || !normalizeUrl(url)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(
      () =>
        void acquireIcon(normalizeUrl(url)!, s.status.relayUrl).then(
          (value) => {
            if (mounted) {
              setIcon(value);
              setLoading(false);
            }
          },
        ),
      400,
    );
    return () => {
      mounted = false;
      clearTimeout(t);
    };
  }, [url, icon.mode, s.status.relayUrl, active]);
  async function save() {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError("请输入有效的网址");
      return;
    }
    if (icon.mode === "custom" && icon.url && !normalizeUrl(icon.url)) {
      setCustomError("请输入有效的网址");
      return;
    }
    await s.update((d) => {
      const now = Date.now(),
        fields = {
          url: normalized,
          title: title.trim() || autoTitle(url),
          groupId: group,
          icon,
          updatedAt: now,
        };
      if (original)
        Object.assign(d.bookmarks.find((b) => b.id === original.id)!, fields);
      else
        d.bookmarks.push({
          id: crypto.randomUUID(),
          ...fields,
          order: d.bookmarks.filter((b) => b.groupId === group).length,
          createdAt: now,
        });
    });
    if (ANDROID) nativeCall("haptic", "success");
    s.open(null);
  }
  const empty = !normalizeUrl(url),
    display = title || autoTitle(url) || "未命名";
  if (!ANDROID && !STORE && permission)
    return (
      <Modal title="允许读取网站图标？" source={o.source}>
        <h1>允许读取网站图标？</h1>
        <p className="muted" style={{ marginTop: 16 }}>
          空境会直接访问你收藏的网站首页，只为读取它的图标。不会读取网页里的其他内容，也不会上传任何数据。
        </p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setPermission(false)}>
            暂不
          </Button>
          <Button
            onClick={() =>
              void (async () => {
                const granted = extensionEnvironment()
                  ? await chrome.permissions.request({
                      origins: ["<all_urls>"],
                    })
                  : false;
                setAllowed(granted);
                setPermission(false);
                if (!granted) s.toast("未获得权限");
              })()
            }
          >
            允许
          </Button>
        </div>
      </Modal>
    );
  return (
    <Modal
      active={active}
      title={original ? "编辑书签" : "添加书签"}
      source={o.source}
    >
      <h1>{original ? "编辑书签" : "添加书签"}</h1>
      <div
        className={
          "bookmark-preview " + (loading ? "icon-fetching" : "icon-found")
        }
      >
        {empty ? (
          <span className="empty-icon">
            <svg viewBox="0 0 24 24">
              <path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0Z" />
            </svg>
          </span>
        ) : (
          <TileIcon title={display} url={normalizeUrl(url)!} icon={icon} />
        )}
        <span
          className="bookmark-name"
          style={empty ? { color: "var(--text-3)" } : undefined}
        >
          {display}
        </span>
      </div>
      {!empty && !loading && icon.mode === "auto" && icon.failedAt && (
        <p className="help">未找到网站图标，已使用字母图标</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save().catch(() => {});
        }}
      >
        <label className="field-label">
          网址
          <input
            value={url}
            aria-invalid={!!error}
            onChange={(e) => {
              setUrl(e.target.value);
              setError("");
              if (!nameEdited) setTitle(autoTitle(e.target.value));
            }}
            placeholder="https://"
          />
        </label>
        {error && <p className="field-error">{error}</p>}
        <label className="field-label">
          名称
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setNameEdited(true);
            }}
          />
        </label>
        <label className="field-label">图标</label>
        <div className="icon-segments">
          <Segments
            id="bookmark-icon"
            items={[
              { value: "auto", label: "自动" },
              { value: "letter", label: "字母" },
              { value: "custom", label: "自定义" },
            ]}
            value={icon.mode}
            onChange={(mode) => setIcon({ mode: mode as BookmarkIcon["mode"] })}
          />
        </div>
        {!ANDROID && !STORE && icon.mode === "auto" && !allowed && (
          <p className="help">
            授权后可直接从网站获取更清晰的图标{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setPermission(true)}
            >
              去授权
            </button>
          </p>
        )}
        {icon.mode === "custom" && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={motionTransition(spring.smooth)}
          >
            <div className="custom-icon-area">
              {icon.dataUrl || icon.url ? (
                <TileIcon title={display} url={url} icon={icon} />
              ) : (
                <span className="empty-icon" />
              )}
              <div>
                <Button
                  variant="secondary"
                  onClick={() => upload.current?.click()}
                >
                  上传图片
                </Button>
                <input
                  aria-label="图标网址"
                  placeholder="或粘贴图标网址"
                  value={icon.url || ""}
                  onChange={(e) => {
                    setCustomError("");
                    setIcon({ mode: "custom", url: e.target.value });
                  }}
                  onBlur={() => {
                    if (icon.url && !normalizeUrl(icon.url))
                      setCustomError("请输入有效的网址");
                  }}
                />
              </div>
            </div>
            {customError && <p className="field-error">{customError}</p>}
          </motion.div>
        )}
        <input
          ref={upload}
          hidden
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.ico"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const compressed = await compressImage(file, "icon");
              setIcon({
                mode: "custom",
                dataUrl: await blobDataUrl(compressed),
                tone: await imageTone(compressed),
              });
              setCustomError("");
            } catch (e) {
              setCustomError(
                e instanceof Error ? e.message : "无法读取这张图片",
              );
            }
          }}
        />
        <label className="field-label">分组</label>
        <Segments
          id="dialog-group"
          items={s.data.groups.map((g) => ({ value: g.id, label: g.name }))}
          value={group}
          onChange={setGroup}
        />
        <div className="dialog-actions">
          {original && (
            <button
              type="button"
              className="text-button danger-text delete-action"
              onClick={() => {
                removeBookmark(original);
                s.open(null);
              }}
            >
              删除
            </button>
          )}
          <Button variant="secondary" onClick={() => s.open(null)}>
            取消
          </Button>
          <Button type="submit" disabled={!!customError}>
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}
