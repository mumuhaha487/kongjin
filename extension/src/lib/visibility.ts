// Page visibility is independent of the event-driven sync host.
import { ambient } from "./ambient";
let nativeVisible = true;
const listeners = new Set<() => void>();
export const pageVisible = () => nativeVisible && !document.hidden;
export function setNativeVisible(visible: boolean) {
  nativeVisible = visible;
  listeners.forEach((fn) => fn());
}
export function onPageVisibility(fn: () => void) {
  listeners.add(fn);
  document.addEventListener("visibilitychange", fn);
  return () => {
    listeners.delete(fn);
    document.removeEventListener("visibilitychange", fn);
  };
}
export function visibleTimeout(fn: () => void, delay: number) {
  if (typeof document === "undefined" || !document.addEventListener) {
    const timer = setTimeout(fn, delay);
    return () => clearTimeout(timer);
  }
  let remaining = delay,
    started = 0,
    timer: ReturnType<typeof setTimeout>;
  let unsubscribe = () => {};
  const update = () => {
    clearTimeout(timer);
    if (started)
      remaining = Math.max(0, remaining - (performance.now() - started));
    started = 0;
    if (pageVisible()) {
      started = performance.now();
      timer = setTimeout(() => {
        unsubscribe();
        fn();
      }, remaining);
    }
  };
  unsubscribe = onPageVisibility(update);
  update();
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
export function installVisibility(android: boolean) {
  const root = document.documentElement;
  const paused = new Set<Animation>();
  let touching = false;
  let resume: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const visible = pageVisible();
    root.classList.toggle("page-hidden", !visible);
    const backgroundPaused =
      !visible ||
      (android &&
        (touching ||
          !!document.querySelector(
            '.modal-layer:not([data-settled="closed"]),.settings-layer:not([data-settled="closed"])',
          )));
    if (android)
      ambient.configure({ visible, paused: backgroundPaused && visible });
    // Keep the diagnostic flag on html, but scope animation selectors to the
    // actual scenery/spark nodes. Touch input must not restyle the whole page.
    root.classList.toggle("background-paused", backgroundPaused);
    document.querySelectorAll(".background,.clock-spark").forEach((node) => {
      node.classList.toggle("is-paused", backgroundPaused);
    });
    if (!visible) {
      for (const animation of document.getAnimations()) {
        if (animation.playState === "running") {
          paused.add(animation);
          animation.pause();
        }
      }
      clearTimeout(resume);
    } else {
      for (const animation of paused) {
        if (animation.playState === "paused") animation.play();
      }
      paused.clear();
    }
  };
  const observer = new MutationObserver(update);
  // Portalled action sheets live beside #root and must pause scenery too.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-open", "data-settled"],
  });
  const start = () => {
    clearTimeout(resume);
    ambient.wake();
    touching = false;
    update();
  };
  const scroll = () => {
    ambient.wake();
    touching = true;
    update();
    end();
  };
  const end = () => {
    clearTimeout(resume);
    if (!pageVisible()) {
      touching = false;
      update();
      return;
    }
    resume = setTimeout(() => {
      touching = false;
      update();
    }, 600);
  };
  if (android) {
    document.addEventListener("keydown", start, { passive: true });
    document.addEventListener("scroll", scroll, {
      passive: true,
      capture: true,
    });
    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", end, { passive: true });
  }
  const unsubscribe = onPageVisibility(update);
  update();
  return () => {
    observer.disconnect();
    unsubscribe();
    clearTimeout(resume);
    document.removeEventListener("touchstart", start);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", end);
    document.removeEventListener("keydown", start);
    document.removeEventListener("scroll", scroll, true);
    if (android) ambient.configure({ visible: false });
  };
}
