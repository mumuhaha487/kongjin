/** Keep hydration and optional modules out of the first painted frame. */
export function afterPaintIdle(task: () => void): () => void {
  let frame = 0,
    idle = 0,
    timer = 0,
    cancelled = false;
  let scheduled = false;
  let observer: PerformanceObserver | undefined;
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      const run = () => {
        if (!cancelled) task();
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        observer?.disconnect();
        clearTimeout(timer);
        if (cancelled) return;
        if (typeof requestIdleCallback === "function")
          idle = requestIdleCallback(run, { timeout: 1000 });
        else timer = window.setTimeout(run, 0);
      };
      if (
        typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes?.includes("paint") &&
        !performance.getEntriesByName("first-contentful-paint").length
      ) {
        observer = new PerformanceObserver((entries) => {
          if (
            entries
              .getEntries()
              .some((e) => e.name === "first-contentful-paint")
          )
            schedule();
        });
        observer.observe({ type: "paint", buffered: true });
        // Hidden extension tabs may not expose PaintTiming. Never block hydration indefinitely.
        timer = window.setTimeout(schedule, 1000);
      } else schedule();
    });
  });
  return () => {
    cancelled = true;
    observer?.disconnect();
    cancelAnimationFrame(frame);
    if (idle) cancelIdleCallback(idle);
    clearTimeout(timer);
  };
}
