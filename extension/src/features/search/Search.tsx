import { useShallow } from "zustand/react/shallow";
import { LayoutDiv } from "../../lib/layout-budget";
import { motionTransition } from "../../lib/motion";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, cancelFrame, frame, motion } from "motion/react";
import {
  Check,
  ChevronDown,
  Clock3,
  CornerDownLeft,
  X,
  Search as SearchIcon,
} from "lucide-react";
import { siGoogle, siMicrosoftbing, siBaidu, siDuckduckgo } from "simple-icons";
import { useStore } from "../../app/store";
import { builtins } from "../../lib/model";
import { storage } from "../../lib/storage";
import { Menu, MenuItem } from "../../components/Common/Common";
import { easeOut, spring } from "../../lib/motion";
import { searchPlaceholder } from "./placeholder";
import { executeSearch } from "./execute";
import { ANDROID, STORE } from "../../lib/build";
import {
  browserSettings,
  mobileEngines,
} from "../../platform/android-settings";
import { useSyncExternalStore } from "react";
export { navigate } from "./execute";
const paths: Record<string, string> = {
  google: siGoogle.path,
  bing: siMicrosoftbing.path,
  baidu: siBaidu.path,
  duckduckgo: siDuckduckgo.path,
};
export function EngineIcon({ id, name }: { id: string; name: string }) {
  return id === "default" ? (
    <SearchIcon size={20} color="var(--text-2)" />
  ) : paths[id] ? (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d={paths[id]} fill="currentColor" />
    </svg>
  ) : (
    <span>{name.slice(0, 1)}</span>
  );
}
export function Search() {
  const browser = useSyncExternalStore(
    browserSettings.subscribe,
    browserSettings.get,
  );
  useStore(
    useShallow((s) => [
      s.focused,
      s.history,
      s.data.searchEngines,
      s.data.settings.newTab,
      s.data.settings.history,
    ]),
  );
  const s = useStore.getState(),
    [query, setQuery] = useState(""),
    [menu, setMenu] = useState(false),
    [selected, setSelected] = useState(-1),
    [engineId, setEngineId] = useState("default"),
    input = useRef<HTMLInputElement>(null),
    root = useRef<HTMLDivElement>(null),
    popovers = useRef<HTMLDivElement>(null),
    engines = ANDROID
      ? mobileEngines(s.data)
      : [...builtins, ...s.data.searchEngines],
    engine =
      engines.find((e) => e.id === (ANDROID ? browser.engine : engineId)) ||
      (ANDROID ? engines.find((e) => e.id === "bing")! : engines[0]);
  const chooseEngine = (id: string) => {
    if (ANDROID) void browserSettings.set({ engine: id });
    else setEngineId(id);
  };
  useEffect(() => {
    if (!ANDROID) return;
    const keepVisible = () => {
      if (document.activeElement !== input.current) return;
      const rect = root.current?.getBoundingClientRect(),
        bottom =
          (visualViewport?.height || innerHeight) +
          (visualViewport?.offsetTop || 0);
      if (rect && rect.bottom > bottom - 20)
        window.scrollBy({ top: rect.bottom - bottom + 20, behavior: "smooth" });
    };
    visualViewport?.addEventListener("resize", keepVisible);
    input.current?.addEventListener("focus", keepVisible);
    return () => {
      visualViewport?.removeEventListener("resize", keepVisible);
      input.current?.removeEventListener("focus", keepVisible);
    };
  }, []);
  const matches = s.data.settings.history
    ? s.history
        .filter((q) => q.toLowerCase().startsWith(query.toLowerCase()))
        .slice(0, 8)
    : [];
  const closeMenu = useCallback(() => setMenu(false), []);
  useLayoutEffect(() => {
    if (!s.focused && !menu) return;
    const position = () => {
      const rect = root.current?.getBoundingClientRect();
      if (rect && popovers.current) {
        Object.assign(popovers.current.style, {
          left: `${rect.left}px`,
          top: `${rect.bottom + 8}px`,
          width: `${rect.width}px`,
        });
      }
    };
    position();
    frame.postRender(position, true);
    return () => cancelFrame(position);
  }, [s.focused, menu]);
  useEffect(() => {
    const slash = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName) &&
        !useStore.getState().overlay &&
        !useStore.getState().settingsOpen
      ) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", slash);
    return () => window.removeEventListener("keydown", slash);
  }, []);
  const run = (value = query) => {
    if (!value.trim()) return;
    s.addHistory(value.trim());
    void executeSearch(value, engine, s.data.settings.newTab).catch((error) =>
      console.warn("[空境] Chrome Search API unavailable", error),
    );
  };
  const cycle = (direction: number) => {
    const index = engines.findIndex((e) => e.id === engine.id);
    chooseEngine(
      engines[(index + direction + engines.length) % engines.length].id,
    );
  };
  const focused = s.focused;
  return (
    <LayoutDiv
      className="search-enter"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={motionTransition({ ...spring.smooth, delay: 0.18 })}
    >
      <LayoutDiv
        layout
        ref={root}
        className={`search-wrap ${focused ? "focused" : ""}`}
        style={{ width: ANDROID ? "100%" : focused ? 680 : 600 }}
        transition={motionTransition(spring.smooth)}
        onFocus={() => useStore.setState({ focused: true })}
        onBlur={(e) => {
          if (
            !e.currentTarget.contains(e.relatedTarget as Node) &&
            !popovers.current?.contains(e.relatedTarget as Node)
          )
            useStore.setState({ focused: false });
        }}
      >
        <form
          className="search-box glass"
          role="search"
          onClick={(e) => {
            if (ANDROID && !(e.target as Element).closest("button"))
              input.current?.focus();
          }}
          onSubmit={(e) => {
            e.preventDefault();
            run(selected >= 0 ? matches[selected] : query);
          }}
        >
          <button
            className="engine-trigger"
            type="button"
            aria-label="选择搜索引擎"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
            onWheel={(e) => {
              e.preventDefault();
              cycle(e.deltaY > 0 ? 1 : -1);
            }}
          >
            <span className="engine-wheel">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={engine.id}
                  initial={{ y: "100%", opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: "-100%", opacity: 0 }}
                  transition={motionTransition(spring.snappy)}
                >
                  <EngineIcon id={engine.id} name={engine.name} />
                </motion.span>
              </AnimatePresence>
            </span>
            <ChevronDown size={10} />
          </button>
          <span className="search-divider" />
          <div className="search-input-wrap">
            <input
              ref={input}
              aria-label="搜索"
              autoComplete="off"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.preventDefault();
                  cycle(e.shiftKey ? -1 : 1);
                }
                if (e.key === "Escape") {
                  if (menu) setMenu(false);
                  else input.current?.blur();
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelected((i) =>
                    matches.length
                      ? (i +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          matches.length) %
                        matches.length
                      : -1,
                  );
                }
              }}
            />
            {!query && (
              <AnimatePresence mode="popLayout">
                <motion.span
                  className="search-placeholder"
                  key={engine.id}
                  initial={{ opacity: 0, filter: "blur(4px)" }}
                  animate={{ opacity: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, filter: "blur(4px)" }}
                  transition={motionTransition({ duration: 0.2 })}
                >
                  {searchPlaceholder(engine.name, engine.id)}
                </motion.span>
              </AnimatePresence>
            )}
          </div>
          <AnimatePresence>
            {query && (
              <motion.button
                type="submit"
                className="search-hint"
                aria-label="搜索"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <CornerDownLeft size={12} />
              </motion.button>
            )}
          </AnimatePresence>
        </form>
        {createPortal(
          <div ref={popovers} className="search-popovers">
            <AnimatePresence>
              {menu && (
                <Menu
                  label="搜索引擎"
                  onClose={closeMenu}
                  style={{ top: 0, left: 0 }}
                >
                  {engines.map((e, i) => (
                    <MenuItem
                      key={e.id}
                      index={i}
                      onClick={() => {
                        chooseEngine(e.id);
                        setMenu(false);
                        input.current?.focus();
                      }}
                    >
                      <EngineIcon id={e.id} name={e.name} />
                      <span>{e.name}</span>
                      {engine.id === e.id && (
                        <Check size={16} className="accent" />
                      )}
                    </MenuItem>
                  ))}
                </Menu>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {focused && !menu && matches.length > 0 && (
                <LayoutDiv
                  className="history-menu glass"
                  role="listbox"
                  aria-label="搜索历史"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={motionTransition({
                    duration: 0.2,
                    ease: easeOut,
                  })}
                >
                  {matches.map((q, i) => (
                    <div
                      key={q}
                      role="option"
                      aria-selected={selected === i}
                      className={`history-row ${selected === i ? "active" : ""}`}
                    >
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => run(q)}
                      >
                        <Clock3 size={16} />
                        <span>{q}</span>
                      </button>
                      <button
                        aria-label={`删除历史 ${q}`}
                        className="history-remove"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          const history = s.history.filter((x) => x !== q);
                          useStore.setState({ history });
                          void storage.set("history", history);
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="history-clear"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      useStore.setState({ history: [] });
                      void storage.set("history", []);
                      if (!STORE)
                        void import("../continuity/bridge")
                          .then(({ continuityCommand }) =>
                            continuityCommand("clearSearch"),
                          )
                          .catch(() => {});
                    }}
                  >
                    清除搜索历史
                  </button>
                </LayoutDiv>
              )}
            </AnimatePresence>
          </div>,
          document.body,
        )}
      </LayoutDiv>
    </LayoutDiv>
  );
}
