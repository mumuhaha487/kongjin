import { initialStatus, type PairState } from "../features/pairing/types";
import type { ContinuityService } from "../features/continuity/service";
import {
  continuityDefaults,
  type ContinuityState,
} from "../features/continuity/types";
let creating: Promise<void> | undefined;
export function ensureOffscreen() {
  return (creating ||= (async () => {
    // getContexts avoids races after a worker restart; the document owns the singleton.
    const exists = chrome.runtime.getContexts
      ? (
          await chrome.runtime.getContexts({
            contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
          })
        ).length > 0
      : (
          await (
            globalThis as unknown as {
              clients: { matchAll(): Promise<{ url: string }[]> };
            }
          ).clients.matchAll()
        ).some((c) => c.url === chrome.runtime.getURL("offscreen.html"));
    if (!exists)
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WEB_RTC],
        justification: "在持久页面中运行端到端加密的 WebRTC 多设备同步",
      });
  })().finally(() => {
    creating = undefined;
  }));
}
async function rpc(
  kind: string,
  action?: string,
  params?: unknown[],
  args?: Record<string, string>,
) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    type: "kj:host-rpc",
    kind,
    action,
    params,
    args,
  });
  if (!response?.ok) throw Error(response?.error || "NETWORK");
  return response.value;
}
let state: ContinuityState = {
  options: { ...continuityDefaults },
  slots: [],
  inbox: [],
  status: initialStatus(),
  available: true,
  historyGap: false,
};
const listeners = new Set<(s: ContinuityState) => void>();
let collector: Parameters<ContinuityService["setCollector"]>[0] | undefined;
let notifyIncoming: ContinuityService["notifyIncoming"];
const service = {
  get options() {
    return state.options;
  },
  subscribe(fn: (s: ContinuityState) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  setCollector(fn: typeof collector) {
    collector = fn;
  },
  get notifyIncoming() {
    return notifyIncoming;
  },
  set notifyIncoming(fn: typeof notifyIncoming) {
    notifyIncoming = fn;
  },
  deviceName(id: string) {
    return state.status.devices.find((d) => d.deviceId === id)?.name || id;
  },
};
export const remoteContinuity = new Proxy(service, {
  get(target, key) {
    if (key in target || key === "rebuildMenus")
      return Reflect.get(target, key);
    return (...params: unknown[]) => rpc("continuity", String(key), params);
  },
}) as unknown as ContinuityService;
export class OffscreenController {
  status = initialStatus();
  pair: PairState = { view: "intro" };
  async init() {
    await this.command("status");
  }
  async command(action: string, args: Record<string, string> = {}) {
    const response = await rpc("pair", action, undefined, args);
    this.status = response.status;
    this.pair = response.pair;
    return response;
  }
  notify() {
    return rpc("notify");
  }
  update(status: typeof this.status, pair: PairState) {
    this.status = status;
    this.pair = pair;
  }
}
export function receiveHostState(next: ContinuityState) {
  state = next;
  listeners.forEach((fn) => fn(next));
}
export async function hostCollect(
  key: "history" | "tabs" | "incoming",
  enabled: boolean,
) {
  return { granted: (await collector?.(key, enabled)) || false };
}
export async function hostNotify(
  item: Parameters<NonNullable<typeof notifyIncoming>>[0],
) {
  await notifyIncoming?.(item);
}
