import { useShallow } from "zustand/react/shallow";
import {
  LayoutDiv,
  LayoutSpan,
  LayoutAnchor,
  LayoutButton,
} from "../../lib/layout-budget";
import { motionTransition } from "../../lib/motion";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { useStore } from "../../app/store";
import { ordered, type Bookmark } from "../../lib/model";
import { spring, easeOut, easeIn } from "../../lib/motion";
import { TileIcon } from "../../components/TileIcon/TileIcon";
import { Menu, MenuItem } from "../../components/Common/Common";
import { navigate } from "../search/Search";
import { ANDROID } from "../../lib/build";
import { browserSettings } from "../../platform/android-settings";
import { nativeCall } from "../../platform/native";
interface Drag {
  id: string;
  kind: "bookmark" | "group";
  x: number;
  y: number;
  dx: number;
  dy: number;
  active: boolean;
  left: number;
  top: number;
  width: number;
  lastOver?: string;
  dropping?: boolean;
  dropX?: number;
  dropY?: number;
  target?: string;
  hoverAt?: number;
  ready?: boolean;
  held?: boolean;
}
export function removeBookmark(bookmark: Bookmark) {
  const s = useStore.getState();
  s.update((d) => {
    d.bookmarks = d.bookmarks.filter((b) => b.id !== bookmark.id);
    d.tombstones.push({
      id: bookmark.id,
      kind: "bookmark",
      deletedAt: Date.now(),
    });
  });
  s.toast(`已删除「${bookmark.title}」`, () =>
    s.update((d) => {
      d.tombstones = d.tombstones.filter((t) => t.id !== bookmark.id);
      d.bookmarks.push({ ...bookmark, updatedAt: Date.now() });
    }),
  );
}
export function Bookmarks() {
  useStore(
    useShallow((s) => [
      s.focused,
      s.selected,
      s.data.groups,
      s.data.bookmarks,
      s.data.settings.columns,
      s.data.settings.labels,
    ]),
  );
  const s = useStore.getState(),
    groups = ordered(s.data.groups),
    active = groups.find((g) => g.id === s.selected) || groups[0],
    items = ordered(s.data.bookmarks.filter((b) => b.groupId === active?.id)),
    [direction, setDirection] = useState(1),
    [editing, setEditing] = useState(""),
    [name, setName] = useState(""),
    [menu, setMenu] = useState<{
      x: number;
      y: number;
      kind: "group" | "bookmark";
      id: string;
    } | null>(null),
    drag = useRef<Drag | null>(null),
    [dragView, setDragView] = useState<Drag | null>(null),
    timer = useRef<ReturnType<typeof setTimeout>>(),
    hoverTimer = useRef<ReturnType<typeof setTimeout>>(),
    entered = useRef(false),
    clickBlocked = useRef(false),
    reduce = useReducedMotion();
  const grid = useRef<HTMLDivElement>(null),
    [viewport, setViewport] = useState(innerWidth);
  useEffect(() => {
    if (!ANDROID) return;
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancelDrag);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancelDrag);
    };
  });
  useEffect(() => {
    const entry = setTimeout(() => {
      entered.current = true;
    }, 900);
    const resize = () => {
      setViewport(innerWidth);
      if (grid.current) {
        grid.current.style.setProperty(
          "--grid-top",
          grid.current.getBoundingClientRect().top + "px",
        );
        grid.current.classList.toggle(
          "overflowing",
          grid.current.scrollHeight > grid.current.clientHeight,
        );
      }
    };
    resize();
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    if (grid.current) observer.observe(grid.current);
    const preventHeldScroll = (event: TouchEvent) => {
      if (ANDROID && drag.current?.held) event.preventDefault();
    };
    document.addEventListener("touchmove", preventHeldScroll, {
      passive: false,
    });
    return () => {
      clearTimeout(entry);
      clearTimeout(timer.current);
      clearTimeout(hoverTimer.current);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("touchmove", preventHeldScroll);
    };
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (
        e.altKey &&
        /^[1-9]$/.test(e.key) &&
        !useStore.getState().overlay &&
        !useStore.getState().settingsOpen
      ) {
        const b = items[Number(e.key) - 1];
        if (b) {
          e.preventDefault();
          navigate(b.url);
        }
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [items]);
  const select = (id: string) => {
    setDirection(
      groups.findIndex((g) => g.id === id) >
        groups.findIndex((g) => g.id === active.id)
        ? 1
        : -1,
    );
    useStore.setState({ selected: id });
  };
  function begin(e: ReactPointerEvent, id: string, kind: "bookmark" | "group") {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const start: Drag = {
      id,
      kind,
      x: e.clientX,
      y: e.clientY,
      dx: 0,
      dy: 0,
      active: false,
      left: rect.left,
      top: rect.top,
      width: rect.width,
    };
    drag.current = start;
    clickBlocked.current = false;
    timer.current = setTimeout(
      () => {
        if (drag.current) {
          if (ANDROID) {
            drag.current.held = true;
            clickBlocked.current = true;
            nativeCall("haptic", "light");
            setMenu({
              x: drag.current.x,
              y: drag.current.y,
              kind: drag.current.kind,
              id: drag.current.id,
            });
            return;
          }
          drag.current.active = true;
          setDragView({ ...drag.current });
        }
      },
      ANDROID ? 450 : 180,
    );
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    if (Math.hypot(d.dx, d.dy) > 6) {
      if (ANDROID && !d.held) {
        clearTimeout(timer.current);
        drag.current = null;
        return;
      }
      d.active = true;
    }
    if (!d.active) return;
    if (ANDROID) setMenu(null);
    clickBlocked.current = true;
    const hits = ANDROID
      ? document.elementsFromPoint(e.clientX, e.clientY)
      : [document.elementFromPoint(e.clientX, e.clientY)];
    const group = hits
      .map((el) => el?.closest<HTMLElement>("[data-group]"))
      .find(Boolean);
    if (d.kind === "bookmark" && group) {
      const target = group.dataset.group;
      if (d.target !== target) {
        clearTimeout(hoverTimer.current);
        d.ready = false;
        d.target = target;
        d.hoverAt = Date.now();
        hoverTimer.current = setTimeout(() => {
          if (drag.current === d && d.target === target) {
            d.ready = true;
            setDragView({ ...d });
          }
        }, 400);
      }
    } else {
      d.target = undefined;
      d.hoverAt = undefined;
      d.ready = false;
      clearTimeout(hoverTimer.current);
    }
    const hit = hits
        .map((el) =>
          el?.closest<HTMLElement>(
            d.kind === "bookmark" ? "[data-bookmark]" : "[data-group]",
          ),
        )
        .find(Boolean),
      id = hit?.dataset[d.kind === "bookmark" ? "bookmark" : "group"];
    if (id && id !== d.id && id !== d.lastOver && !d.target) {
      d.lastOver = id;
      s.update((data) => {
        const list = ordered<{ id: string; order: number; updatedAt: number }>(
            d.kind === "bookmark"
              ? data.bookmarks.filter((b) => b.groupId === active.id)
              : data.groups,
          ),
          from = list.findIndex((b) => b.id === d.id),
          to = list.findIndex((b) => b.id === id);
        if (from >= 0 && to >= 0) {
          const [item] = list.splice(from, 1);
          list.splice(to, 0, item);
          list.forEach((b, i) => {
            b.order = i;
            b.updatedAt = Date.now();
          });
        }
      });
    }
    setDragView({ ...d });
  }
  function end() {
    clearTimeout(timer.current);
    clearTimeout(hoverTimer.current);
    const d = drag.current;
    if (!d) return;
    if (ANDROID && d?.held && !d.active) {
      setMenu({ x: d.x, y: d.y, kind: d.kind, id: d.id });
      clickBlocked.current = true;
    }
    if (d?.active) {
      clickBlocked.current = true;
      if (d.target && d.hoverAt && Date.now() - d.hoverAt >= 400)
        s.update((data) => {
          const b = data.bookmarks.find((b) => b.id === d.id);
          if (b) {
            b.groupId = d.target!;
            b.order = data.bookmarks.filter(
              (x) => x.groupId === d.target,
            ).length;
            b.updatedAt = Date.now();
          }
        });
    }
    drag.current = null;
    if (d?.active && d.kind === "bookmark") {
      requestAnimationFrame(() => {
        const target = document
          .querySelector<HTMLElement>(
            d.target
              ? `[data-group="${CSS.escape(d.target)}"]`
              : `[data-bookmark="${CSS.escape(d.id)}"]`,
          )
          ?.getBoundingClientRect();
        setDragView({
          ...d,
          dropping: true,
          dropX: target?.left ?? d.left,
          dropY: target?.top ?? d.top,
        });
      });
    } else setDragView(null);
    setTimeout(() => (clickBlocked.current = false), ANDROID ? 320 : 0);
  }
  function cancelDrag() {
    clearTimeout(timer.current);
    clearTimeout(hoverTimer.current);
    drag.current = null;
    setDragView(null);
    setTimeout(() => (clickBlocked.current = false), 320);
  }
  function finishGroup() {
    const newId = crypto.randomUUID();
    if (editing === "new" && name.trim())
      useStore.setState({ selected: newId });
    if (name.trim())
      s.update((d) => {
        if (editing === "new")
          d.groups.push({
            id: newId,
            name: name.trim(),
            order: d.groups.length,
            updatedAt: Date.now(),
          });
        else {
          const g = d.groups.find((g) => g.id === editing);
          if (g) {
            g.name = name.trim();
            g.updatedAt = Date.now();
          }
        }
      });
    setEditing("");
    setName("");
  }
  const contextBookmark = s.data.bookmarks.find((b) => b.id === menu?.id);
  const draggedBookmark = s.data.bookmarks.find((b) => b.id === dragView?.id);
  return (
    <motion.section
      className="bookmarks-section"
      animate={{
        opacity: s.focused ? 0.35 : 1,
        filter: s.focused && !reduce ? "blur(1.5px)" : "blur(0px)",
      }}
      transition={motionTransition(spring.smooth)}
    >
      <LayoutDiv
        className={`groups segments ${editing ? "editing" : ""}`}
        layout
        transition={motionTransition(spring.snappy)}
        role="tablist"
        aria-label="书签分组"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        {groups.map((g) => (
          <LayoutDiv
            layout
            key={g.id}
            data-group={g.id}
            className={`group-wrap ${dragView?.target === g.id && dragView.ready ? "drop-target" : ""}`}
            style={
              dragView?.id === g.id
                ? {
                    transform: `translate(${dragView.dx}px,${dragView.dy}px)`,
                    zIndex: 10,
                    pointerEvents: dragView.active ? "none" : undefined,
                  }
                : undefined
            }
            onPointerDown={(e) => {
              if (!editing) begin(e, g.id, "group");
            }}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={ANDROID ? cancelDrag : end}
            onClick={() => {
              if (!editing && !clickBlocked.current) select(g.id);
            }}
            onDoubleClick={() => {
              if (!editing) {
                setEditing(g.id);
                setName(g.name);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (ANDROID) return;
              setMenu({ x: e.clientX, y: e.clientY, kind: "group", id: g.id });
            }}
          >
            {editing === g.id ? (
              <input
                autoFocus
                aria-label="分组名称"
                maxLength={12}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={finishGroup}
                onKeyDown={(e) => {
                  if (e.key === "Enter") finishGroup();
                  if (e.key === "Escape") setEditing("");
                }}
              />
            ) : (
              <button role="tab" aria-selected={g.id === active?.id}>
                {active?.id === g.id && (
                  <LayoutSpan
                    className="segment-slider"
                    layoutId="bookmark-group"
                    transition={motionTransition(spring.snappy)}
                  />
                )}
                <span>{g.name}</span>
              </button>
            )}
          </LayoutDiv>
        ))}
        {editing === "new" ? (
          <motion.input
            initial={{ width: 120 }}
            style={{ marginRight: 28 }}
            className="new-group"
            placeholder="新分组"
            maxLength={12}
            animate={{ width: 120 }}
            transition={motionTransition(spring.snappy)}
            autoFocus
            aria-label="新分组名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={finishGroup}
            onKeyDown={(e) => {
              if (e.key === "Enter") finishGroup();
              if (e.key === "Escape") setEditing("");
            }}
          />
        ) : (
          <button
            className="group-add"
            aria-label="新建分组"
            onClick={() => {
              setEditing("new");
              setName("");
            }}
          >
            <Plus size={14} />
          </button>
        )}
      </LayoutDiv>
      <LayoutDiv
        className="grid-scroll"
        ref={grid}
        onScroll={(e) =>
          e.currentTarget.classList.toggle(
            "scrolled",
            e.currentTarget.scrollTop > 0,
          )
        }
        layout
        transition={motionTransition(spring.smooth)}
        style={
          {
            "--columns": ANDROID
              ? 4
              : viewport < 760
                ? Math.min(
                    s.data.settings.columns,
                    Math.max(1, Math.floor((viewport - 48) / 88)),
                  )
                : s.data.settings.columns,
          } as CSSProperties
        }
      >
        <AnimatePresence mode="wait" custom={direction}>
          <LayoutDiv
            key={active?.id}
            className="bookmark-grid"
            custom={direction}
            initial={{ opacity: 0, x: reduce ? 0 : direction * 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{
              opacity: 0,
              x: reduce ? 0 : direction * -24,
              transition: motionTransition({ duration: 0.18, ease: easeIn }),
            }}
            transition={motionTransition({ duration: 0.32, ease: easeOut })}
          >
            <AnimatePresence mode="popLayout">
              {items.map((b, i) => (
                <LayoutDiv
                  layout
                  transition={motionTransition(spring.smooth)}
                  key={b.id}
                  data-bookmark={b.id}
                  className={`bookmark ${dragView?.id === b.id && dragView.active ? "dragging" : ""}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{
                    opacity: dragView?.id === b.id && dragView.active ? 0 : 1,
                    y: 0,
                    transition: motionTransition({
                      duration: entered.current ? 0.32 : 0.42,
                      ease: easeOut,
                      delay: dragView
                        ? 0
                        : entered.current
                          ? i * 0.016
                          : 0.26 + i * 0.028,
                    }),
                  }}
                  exit={{
                    scale: 0.6,
                    opacity: 0,
                    transition: motionTransition({ duration: 0.22 }),
                  }}
                  style={{
                    zIndex: dragView?.id === b.id ? 20 : undefined,
                    pointerEvents:
                      dragView?.id === b.id && dragView.active
                        ? "none"
                        : undefined,
                  }}
                >
                  <LayoutAnchor
                    layoutId={`tile-${b.id}`}
                    className="bookmark-link"
                    draggable={false}
                    href={b.url}
                    aria-label={b.title}
                    onClick={(e) => {
                      if (clickBlocked.current) {
                        e.preventDefault();
                        return;
                      }
                      if (ANDROID) {
                        e.preventDefault();
                        navigate(b.url, browserSettings.get().bookmarkNewTab);
                        return;
                      }
                      if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        navigate(b.url, true);
                      }
                    }}
                    onPointerDown={(e) => begin(e, b.id, "bookmark")}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={ANDROID ? cancelDrag : end}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (ANDROID) return;
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        kind: "bookmark",
                        id: b.id,
                      });
                    }}
                    whileTap={{ scale: 0.94 }}
                  >
                    <TileIcon title={b.title} url={b.url} />
                    {s.data.settings.labels && (
                      <span className="bookmark-name">{b.title}</span>
                    )}
                  </LayoutAnchor>
                </LayoutDiv>
              ))}
              <LayoutDiv
                key="add"
                className="bookmark"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={motionTransition({
                  delay: 0.26 + items.length * 0.028,
                  duration: 0.42,
                  ease: easeOut,
                })}
              >
                <LayoutButton
                  layoutId="add-bookmark"
                  className="bookmark-link add-bookmark"
                  aria-label="添加书签"
                  onClick={() =>
                    s.open({
                      type: "bookmark",
                      source: "add-bookmark",
                      id: active?.id,
                    })
                  }
                >
                  <span className="tile-icon">
                    <Plus size={20} />
                  </span>
                  {s.data.settings.labels && (
                    <span className="bookmark-name">添加</span>
                  )}
                </LayoutButton>
              </LayoutDiv>
            </AnimatePresence>
          </LayoutDiv>
        </AnimatePresence>
      </LayoutDiv>
      {dragView?.kind === "bookmark" &&
        dragView.active &&
        draggedBookmark &&
        createPortal(
          <LayoutDiv
            className="bookmark dragging drag-overlay"
            style={ANDROID ? { width: dragView.width } : undefined}
            initial={false}
            animate={{
              x: dragView.dropping
                ? dragView.dropX
                : dragView.left + dragView.dx,
              y: dragView.dropping
                ? dragView.dropY
                : dragView.top + dragView.dy,
              scale: dragView.dropping ? 1 : 1.08,
              opacity: dragView.dropping && !!dragView.target ? 0 : 1,
            }}
            transition={motionTransition(
              dragView.dropping ? spring.smooth : { duration: 0 },
            )}
            onAnimationComplete={() => {
              if (dragView.dropping) setDragView(null);
            }}
          >
            <div className="bookmark-link">
              <TileIcon
                title={draggedBookmark.title}
                url={draggedBookmark.url}
              />
              {s.data.settings.labels && (
                <span className="bookmark-name">{draggedBookmark.title}</span>
              )}
            </div>
          </LayoutDiv>,
          document.body,
        )}
      {createPortal(
        <AnimatePresence>
          {menu && (
            <Menu
              label={menu.kind === "group" ? "分组菜单" : "书签菜单"}
              onClose={closeMenu}
              style={{
                position: "fixed",
                left: Math.min(menu.x, innerWidth - 216),
                top: Math.min(menu.y, innerHeight - 180),
                transformOrigin: "top left",
              }}
            >
              {menu.kind === "bookmark" && contextBookmark ? (
                <>
                  <MenuItem
                    onClick={() => {
                      navigate(contextBookmark.url);
                      if (ANDROID) closeMenu();
                    }}
                  >
                    <ArrowUpRight size={16} />
                    打开
                  </MenuItem>
                  <MenuItem
                    index={1}
                    onClick={() => {
                      navigate(contextBookmark.url, true);
                      if (ANDROID) closeMenu();
                    }}
                  >
                    <ExternalLink size={16} />
                    在新标签页中打开
                  </MenuItem>
                  <MenuItem
                    index={2}
                    onClick={() => {
                      s.open({
                        type: "bookmark",
                        id: contextBookmark.id,
                        source: `tile-${contextBookmark.id}`,
                      });
                      setMenu(null);
                    }}
                  >
                    <Pencil size={16} />
                    编辑
                  </MenuItem>
                  <div className="menu-divider" />
                  <MenuItem
                    index={3}
                    danger
                    onClick={() => {
                      removeBookmark(contextBookmark);
                      setMenu(null);
                    }}
                  >
                    <Trash2 size={16} />
                    删除
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuItem
                    onClick={() => {
                      setEditing(menu.id);
                      setName(groups.find((g) => g.id === menu.id)?.name || "");
                      setMenu(null);
                    }}
                  >
                    <Pencil size={16} />
                    重命名
                  </MenuItem>
                  <MenuItem
                    danger
                    index={1}
                    onClick={() => {
                      if (groups.length === 1) {
                        s.toast("至少保留一个分组");
                        setMenu(null);
                        return;
                      }
                      const id = menu.id;
                      s.update((d) => {
                        d.groups = d.groups.filter((g) => g.id !== id);
                        d.tombstones.push({
                          id,
                          kind: "group",
                          deletedAt: Date.now(),
                        });
                        const target = ordered(d.groups)[0].id;
                        d.bookmarks.forEach((b) => {
                          if (b.groupId === id) {
                            b.groupId = target;
                            b.updatedAt = Date.now();
                          }
                        });
                      });
                      setMenu(null);
                    }}
                  >
                    <Trash2 size={16} />
                    删除分组
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </motion.section>
  );
}
