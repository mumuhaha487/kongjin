/** Pause only extension timers. WebView.pauseTimers would pause every tab in the process. */
export function installBackground(runtime: any, scope: any = globalThis): void {
  if (runtime.config.type === 'content') return;
  const nativeTimeout = scope.setTimeout.bind(scope), nativeClear = scope.clearTimeout.bind(scope);
  const timers = new Map<number, { fn: (...args: any[]) => void; args: any[]; delay: number; repeat: boolean; handle?: number; due: number }>();
  let next = 0, paused = false;
  const arm = (id: number, remaining?: number) => {
    const timer = timers.get(id); if (!timer || paused) return;
    timer.due = Date.now() + (remaining ?? timer.delay);
    timer.handle = nativeTimeout(() => {
      if (!timers.has(id)) return;
      if (!timer.repeat) timers.delete(id);
      try { timer.fn(...timer.args); } finally { if (timer.repeat && timers.has(id)) arm(id); }
    }, Math.max(0, remaining ?? timer.delay));
  };
  const schedule = (fn: (...args: any[]) => void, delay: number, repeat: boolean, args: any[]) => {
    if (typeof fn !== 'function') throw new TypeError('String timers are not supported in extension backgrounds');
    const id = ++next; timers.set(id, { fn, args, delay: Math.max(0, Number(delay) || 0), repeat, due: Date.now() + Math.max(0, Number(delay) || 0) }); arm(id); return id;
  };
  scope.setTimeout = (fn: any, delay = 0, ...args: any[]) => schedule(fn, delay, false, args);
  scope.setInterval = (fn: any, delay = 0, ...args: any[]) => schedule(fn, Math.max(1, delay), true, args);
  scope.clearTimeout = scope.clearInterval = (id: number) => { const t = timers.get(id); if (t) nativeClear(t.handle); timers.delete(id); };
  runtime.chrome.runtime.onSuspend = runtime.chrome.runtime.onSuspend || { addListener() {}, removeListener() {}, hasListeners: () => false };
  runtime.setVisible = (visible: boolean) => {
    if (paused === !visible) return;
    paused = !visible;
    if (paused) timers.forEach(t => { nativeClear(t.handle); });
    else timers.forEach((t, id) => arm(id, Math.max(0, t.due - Date.now())));
  };
}
