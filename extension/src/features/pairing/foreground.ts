/** A sleeping MV3 worker drops ports. Reconnect and resend the actual UI state. */
export function foregroundPort(
  connect: () => chrome.runtime.Port,
  visible: () => boolean,
  subscribe: (update: () => void) => () => void,
) {
  let port: chrome.runtime.Port | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const update = () => {
    try { port?.postMessage({ visible: visible() }); } catch { /* reconnect on disconnect */ }
  };
  const open = () => {
    if (disposed) return;
    try {
      const current = connect();
      port = current;
      current.onDisconnect.addListener(() => {
        if (port !== current) return;
        port = undefined;
        if (!disposed) timer = setTimeout(open, 100);
      });
      update();
    } catch { /* extension was disabled or reloaded */ }
  };
  const unsubscribe = subscribe(update);
  open();
  return () => {
    disposed = true;
    clearTimeout(timer);
    unsubscribe();
    port?.disconnect();
    port = undefined;
  };
}
