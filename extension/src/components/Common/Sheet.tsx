import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { spring as generateSpring } from "motion";
import { spring } from "../../lib/motion";

// Sample the existing spring once per distance. WAAPI then runs transform on
// the compositor, without a React/motion frame callback on the main thread.
const curves = new Map<number, { frames: Keyframe[]; duration: number }>();
function curve(distance: number, from: number, to: number) {
  const key = Math.round(distance);
  let result = curves.get(key);
  if (!result) {
    const response = generateSpring({ ...spring.smooth, keyframes: [key, 0] });
    const values: number[] = [];
    for (let time = 0; time <= 2000; time += 1000 / 60) {
      const frame = response.next(time);
      values.push(1 - frame.value / (key || 1));
      if (frame.done) break;
    }
    values[values.length - 1] = 1;
    result = {
      frames: values.map((value, i) => ({
        offset: i / (values.length - 1),
        value,
      })),
      duration: ((values.length - 1) * 1000) / 60,
    };
    curves.set(key, result);
  }
  return {
    duration: result.duration,
    frames: result.frames.map((frame) => ({
      offset: frame.offset,
      transform: `translateY(${from + (to - from) * Number(frame.value)}%)`,
    })),
  };
}

export function SheetFrame({
  active,
  title,
  children,
  panelRef,
  layerClass = "modal-layer",
  panelClass = "modal glass",
  close,
  locked = false,
  onClosed,
}: {
  active: boolean;
  title: string;
  children: ReactNode;
  panelRef: RefObject<HTMLElement>;
  layerClass?: string;
  panelClass?: string;
  close: () => void;
  locked?: boolean;
  onClosed?: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const running = useRef<Animation[]>([]);
  const first = useRef(true);
  const height = useRef(0);
  const closedCallback = useRef(onClosed);
  closedCallback.current = onClosed;
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const measured =
        entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
      if (measured > 0) height.current = measured;
    });
    observer.observe(panelRef.current!);
    return () => observer.disconnect();
  }, [panelRef]);
  useLayoutEffect(() => {
    const root = layer.current!,
      panel = panelRef.current!,
      shade = scrim.current!;
    delete root.dataset.settled;
    root.inert = !active;
    root.dataset.open = String(active);
    root.setAttribute("aria-hidden", String(!active));
    if (first.current && !active) {
      first.current = false;
      // Warm layout at rest, including content-visibility sections, after the
      // first paint. Opening must not be the first request for their geometry.
      panel.style.transform = "none";
      const sections = Array.from(
        panel.querySelectorAll<HTMLElement>("section"),
      );
      sections.forEach((section) => {
        section.style.contentVisibility = "visible";
      });
      height.current = panel.getBoundingClientRect().height;
      sections.forEach((section) => {
        section.getBoundingClientRect();
      });
      sections.forEach((section) => {
        section.style.contentVisibility = "";
      });
      panel.style.transform = "translateY(100%)";
      root.dataset.settled = "closed";
      return;
    }
    first.current = false;
    running.current.forEach((a) => a.cancel());
    root.style.visibility = "visible";
    panel.style.willChange = "transform";
    shade.style.willChange = "opacity";
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sampled = curve(
      height.current || innerHeight,
      active ? 100 : 0,
      active ? 0 : 100,
    );
    const move = panel.animate(
      reduced
        ? [{ opacity: active ? 0 : 1 }, { opacity: active ? 1 : 0 }]
        : sampled.frames,
      { duration: reduced ? 150 : sampled.duration, fill: "forwards" },
    );
    const fade = shade.animate(
      [{ opacity: active ? 0 : 1 }, { opacity: active ? 1 : 0 }],
      {
        duration: reduced ? 150 : 320,
        easing: "cubic-bezier(.25,.1,.35,1)",
        fill: "forwards",
      },
    );
    panel.style.transform = active ? "translateY(0%)" : "translateY(100%)";
    shade.style.opacity = active ? "1" : "0";
    running.current = [move, fade];
    void Promise.all([move.finished, fade.finished])
      .then(() => {
        panel.style.willChange = "";
        shade.style.willChange = "";
        if (!active) {
          root.style.visibility = "hidden";
          root.dataset.settled = "closed";
          closedCallback.current?.();
        }
        running.current.forEach((a) => a.cancel());
      })
      .catch(() => {});
    return () => running.current.forEach((a) => a.cancel());
  }, [active, panelRef]);
  const touch = useRef<{ y: number; at: number }>();
  return (
    <div
      ref={layer}
      className={`${layerClass} persistent-sheet`}
      style={{ visibility: "hidden" }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !locked) close();
      }}
    >
      <div ref={scrim} className="sheet-scrim" aria-hidden="true" />
      <div
        className={
          layerClass.includes("modal-layer")
            ? "shake-shell"
            : "sheet-panel-shell"
        }
      >
        <div
          ref={panelRef as RefObject<HTMLDivElement>}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={panelClass}
          style={{ transform: "translateY(100%)" }}
        >
          <div
            className="sheet-grip-zone"
            onPointerDown={(e) => {
              if (locked) return;
              touch.current = { y: e.clientY, at: performance.now() };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!touch.current) return;
              panelRef.current!.style.transform = `translateY(${Math.max(0, e.clientY - touch.current.y)}px)`;
            }}
            onPointerUp={(e) => {
              if (!touch.current) return;
              const distance = e.clientY - touch.current.y;
              const speed =
                (distance / (performance.now() - touch.current.at)) * 1000;
              touch.current = undefined;
              if (distance > 120 || speed > 520) close();
              else panelRef.current!.style.transform = "translateY(0%)";
            }}
            onPointerCancel={() => {
              touch.current = undefined;
              panelRef.current!.style.transform = "translateY(0%)";
            }}
          >
            <span className="sheet-grip" />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
