import { create } from "zustand";
import { ANDROID } from "../../lib/build";
import { extensionEnvironment } from "../../lib/storage";
import { initialStatus } from "../pairing/types";
import { continuityDefaults, type ContinuityState } from "./types";
export const useContinuity = create<
  ContinuityState & { open: boolean; tab: "devices" | "history" }
>(() => ({
  options: { ...continuityDefaults },
  slots: [],
  inbox: [],
  status: initialStatus(),
  available: false,
  historyGap: false,
  open: false,
  tab: "devices",
}));
export async function continuityCommand<T = unknown>(
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!ANDROID && extensionEnvironment()) {
    const result = await chrome.runtime.sendMessage({
      type: "kj:continuity",
      action,
      args,
    });
    if (result?.error) throw Error(result.error);
    return result as T;
  }
  const { continuityHost } = await import("./service");
  return (await continuityHost().execute(action, args)) as T;
}
let connecting: Promise<void> | undefined;
export function connectContinuity() {
  return (connecting ||= (async () => {
    if (!ANDROID && extensionEnvironment())
      chrome.runtime.onMessage.addListener((m) => {
        if (m.type === "kj:continuity-state") useContinuity.setState(m.state);
      });
    else {
      const { continuityHost } = await import("./service");
      continuityHost().subscribe((s) => useContinuity.setState(s));
    }
    useContinuity.setState(await continuityCommand<ContinuityState>("state"));
  })());
}
export function openContinuity(tab: "devices" | "history" = "devices") {
  useContinuity.setState({ open: true, tab });
}
