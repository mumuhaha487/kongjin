import { SheetFrame } from "./Sheet";
import { LayoutDiv, LayoutSpan } from "../../lib/layout-budget";
import { motionTransition } from "../../lib/motion";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  useAnimationControls,
  useDragControls,
  usePresence,
} from "motion/react";
import { Check, X, LoaderCircle, ChevronDown, ShieldOff } from "lucide-react";
import { useStore } from "../../app/store";
import { spring, easeOut, sharedContentDelay } from "../../lib/motion";
import { ANDROID } from "../../lib/build";
export function IconButton({
  label,
  onClick,
  children,
  className = "",
  style,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={`icon-button ${className}`}
      onClick={onClick}
      style={style}
    >
      {children}
    </button>
  );
}
export function Button({
  children,
  onClick,
  variant = "primary",
  disabled = false,
  busy = false,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <motion.button
      type={type}
      whileTap={{ scale: 0.98 }}
      className={`button ${variant} ${className}`}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <span style={{ opacity: busy ? 0 : 1 }}>{children}</span>
      {busy && <LoaderCircle className="spinner" size={16} />}
    </motion.button>
  );
}
export function Segments({
  items,
  value,
  onChange,
  id,
}: {
  items: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  return (
    <div className="segments" role="group">
      {items.map((i) => (
        <button
          type="button"
          key={i.value}
          aria-pressed={value === i.value}
          onClick={() => onChange(i.value)}
        >
          {value === i.value && (
            <LayoutSpan
              className="segment-slider"
              layoutId={id}
              transition={motionTransition(spring.snappy)}
            />
          )}
          <span>{i.label}</span>
        </button>
      ))}
    </div>
  );
}
export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      role="switch"
      aria-checked={value}
      className={`toggle ${value ? "on" : ""}`}
      onClick={onChange}
    >
      <LayoutSpan
        animate={{ x: value ? 14 : 0 }}
        whileTap={{ scaleX: 22 / 18 }}
        transition={motionTransition(spring.snappy)}
      />
    </motion.button>
  );
}
export function useFocusTrap(
  ref: React.RefObject<HTMLElement>,
  close: () => void,
  locked = false,
  enabled = true,
  initialFocus: "first" | "container" = "container",
) {
  const saved = useRef<HTMLElement | null>(null),
    callback = useRef(close);
  callback.current = close;
  useLayoutEffect(() => {
    if (!enabled) return;
    saved.current = document.activeElement as HTMLElement;
    const root = ref.current;
    if (!root) return;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select,textarea,[tabindex="0"],a[href]',
        ),
      ).filter((el) => el.getClientRects().length > 0);
    if (!root.contains(document.activeElement))
      (initialFocus === "container" ? root : focusable()[0] || root).focus({
        preventScroll: true,
      });
    const handler = (e: KeyboardEvent) => {
      const activeLayer = document.activeElement?.closest(
        '[role="dialog"],[role="menu"]',
      );
      if (activeLayer && activeLayer !== root && root.contains(activeLayer))
        return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!locked) callback.current();
      }
      if (e.key === "Tab") {
        const list = focusable();
        if (!list.length) {
          e.preventDefault();
          return;
        }
        const first = list[0],
          last = list[list.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            !list.includes(document.activeElement as HTMLElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !list.includes(document.activeElement as HTMLElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      saved.current?.focus();
    };
  }, [ref, locked, enabled, initialFocus]);
}
export function Modal({
  children,
  title,
  source,
  auth = false,
  locked = false,
  shake = 0,
  exiting = false,
  onClose,
  active = true,
}: {
  children: ReactNode;
  title: string;
  source?: string;
  auth?: boolean;
  locked?: boolean;
  shake?: number;
  exiting?: boolean;
  onClose?: () => void;
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    close = onClose || (() => useStore.getState().open(null)),
    reduce = useReducedMotion(),
    shakeControls = useAnimationControls(),
    dragControls = useDragControls();
  useEffect(() => {
    if (shake && !reduce)
      void shakeControls.start({
        x: [0, -10, 8, -6, 4, -2, 0],
        transition: { duration: 0.42 },
      });
  }, [shake, reduce, shakeControls]);
  const [present, safeToRemove] = usePresence(ANDROID);
  useFocusTrap(ref, close, locked, active && present);
  if (ANDROID)
    return (
      <SheetFrame
        active={active && present}
        title={title}
        panelRef={ref}
        close={close}
        locked={locked}
        onClosed={safeToRemove || undefined}
      >
        {!locked && (
          <IconButton label="关闭" className="modal-close" onClick={close}>
            <X size={18} />
          </IconButton>
        )}
        <div>{children}</div>
      </SheetFrame>
    );
  return (
    <LayoutDiv
      className="modal-layer"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={motionTransition({ duration: 0.32 })}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !locked) close();
      }}
    >
      <LayoutDiv
        className="shake-shell"
        animate={shakeControls}
        transition={motionTransition({ duration: 0.42 })}
      >
        <LayoutDiv
          ref={ref}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          layout
          layoutId={ANDROID || reduce ? undefined : source}
          drag={ANDROID && !locked ? "y" : false}
          dragControls={dragControls}
          dragListener={false}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 1 }}
          onDragEnd={(_, info) => {
            if (
              ANDROID &&
              !locked &&
              (info.offset.y > 120 || info.velocity.y > 520)
            )
              close();
          }}
          className={`modal glass ${auth ? "auth-card" : ""}`}
          initial={
            ANDROID
              ? reduce
                ? { opacity: 0 }
                : { y: "100%", opacity: 1 }
              : source
                ? false
                : { opacity: 0, scale: reduce ? 1 : 0.94, y: reduce ? 0 : 8 }
          }
          animate={{
            opacity: exiting ? 0 : 1,
            scale: exiting && !reduce ? 0.94 : 1,
            y: 0,
            filter: exiting && !reduce ? "blur(8px)" : "blur(0px)",
          }}
          exit={
            ANDROID
              ? reduce
                ? { opacity: 0 }
                : { y: "100%" }
              : { opacity: 0, scale: reduce ? 1 : 0.94 }
          }
          transition={motionTransition(
            exiting
              ? { duration: 0.36, ease: [0.55, 0, 1, 0.45] }
              : spring.smooth,
          )}
        >
          {ANDROID && (
            <div
              className="sheet-grip-zone"
              onPointerDown={(event) => {
                if (!locked) dragControls.start(event);
              }}
            >
              <span className="sheet-grip" />
            </div>
          )}
          {!locked && (
            <IconButton label="关闭" className="modal-close" onClick={close}>
              <X size={18} />
            </IconButton>
          )}
          <LayoutDiv
            initial={{ opacity: source ? 0 : 1 }}
            animate={{ opacity: 1 }}
            transition={motionTransition({
              delay: !ANDROID && source && !reduce ? sharedContentDelay : 0,
              duration: reduce ? 0.15 : 0.2,
            })}
          >
            {children}
          </LayoutDiv>
        </LayoutDiv>
      </LayoutDiv>
    </LayoutDiv>
  );
}
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <LayoutDiv
            layout
            key={t.id}
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 12, opacity: 0 }}
            transition={motionTransition(spring.snappy)}
            className="toast glass"
          >
            {t.type === "removed" ? (
              <ShieldOff
                size={16}
                className="toast-warning"
                aria-hidden="true"
              />
            ) : (
              <Check size={16} />
            )}
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.();
                  useStore.setState((s) => ({
                    toasts: s.toasts.filter((x) => x.id !== t.id),
                  }));
                }}
              >
                {t.label}
              </button>
            )}
          </LayoutDiv>
        ))}
      </AnimatePresence>
    </div>
  );
}
export function Menu({
  children,
  onClose,
  style,
  label,
  active = true,
}: {
  active?: boolean;
  children: ReactNode;
  onClose: () => void;
  style?: CSSProperties;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sheetPointerArmed = useRef(false);
  const sheet = ANDROID && ["我的", "书签菜单", "分组菜单"].includes(label);
  const menuKeys = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"),
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };
  useFocusTrap(ref, onClose, false, !sheet && active);
  useEffect(() => {
    if (sheet || !active) return;
    const f = (e: Event) => {
      if (e.type === "scroll" || !ref.current?.contains(e.target as Node))
        onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", f);
      window.addEventListener("scroll", f, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", f);
      window.removeEventListener("scroll", f, true);
    };
  }, [onClose, sheet, active]);
  if (sheet)
    return (
      <Modal title={label} onClose={onClose} active={active}>
        <h1>{label}</h1>
        <div
          className="mobile-action-sheet"
          onKeyDown={menuKeys}
          onPointerDownCapture={() => {
            sheetPointerArmed.current = true;
          }}
          onClickCapture={(event) => {
            // A long press can open the sheet below the still-held finger.
            // Its release must not activate a newly exposed menu item.
            if (!sheetPointerArmed.current && event.detail > 0) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          {children}
        </div>
      </Modal>
    );
  return (
    <LayoutDiv
      role="menu"
      aria-label={label}
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const items = Array.from(
            e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"),
          );
          const index = items.indexOf(document.activeElement as HTMLElement);
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? items.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                  items.length;
          items[next]?.focus();
        }
      }}
      className="menu glass"
      style={style}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: motionTransition({ duration: 0.12 }) }}
      transition={motionTransition({ duration: 0.2, ease: easeOut })}
    >
      {children}
    </LayoutDiv>
  );
}
export function MenuItem({
  children,
  onClick,
  danger = false,
  index = 0,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  index?: number;
}) {
  return (
    <motion.button
      role="menuitem"
      className={danger ? "danger-text" : ""}
      onClick={onClick}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motionTransition({
        duration: 0.2,
        delay: index * 0.018,
        ease: easeOut,
      })}
    >
      {children}
    </motion.button>
  );
}
export function Dropdown({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false),
    id = useId();
  return (
    <div className="dropdown">
      <button
        type="button"
        className="dropdown-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span>
          {items.find((i) => i.value === value)?.label || items[0]?.label}
        </span>
        <ChevronDown size={14} />
      </button>
      <AnimatePresence>
        {open && (
          <Menu
            label={label}
            onClose={() => setOpen(false)}
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              minWidth: "100%",
            }}
          >
            <div id={id}>
              {items.map((i, index) => (
                <MenuItem
                  key={i.value}
                  index={index}
                  onClick={() => {
                    onChange(i.value);
                    setOpen(false);
                  }}
                >
                  {i.label}
                  {i.value === value && <Check size={14} />}
                </MenuItem>
              ))}
            </div>
          </Menu>
        )}
      </AnimatePresence>
    </div>
  );
}
export function Choice({
  label,
  checked,
  onChange,
  type = "checkbox",
  name,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  type?: "checkbox" | "radio";
  name?: string;
}) {
  return (
    <label className="choice-label">
      <span className={"choice-control " + type}>
        <input type={type} checked={checked} onChange={onChange} name={name} />
        <span className="choice-box" aria-hidden="true">
          {type === "checkbox" ? (
            checked && <Check size={14} className="choice-check" />
          ) : (
            <LayoutSpan
              className="choice-dot"
              animate={{ scale: checked ? 1 : 0 }}
              transition={motionTransition(spring.snappy)}
            />
          )}
        </span>
      </span>
      {label}
    </label>
  );
}
