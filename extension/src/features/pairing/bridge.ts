import { extensionEnvironment } from "../../lib/storage";
import type { SyncStatus, PairState } from "./types";
import { ANDROID, STORE } from "../../lib/build";
import { onPageVisibility, pageVisible } from "../../lib/visibility";
import { relayDefault } from "./types";
import { foregroundPort } from "./foreground";
let local: import("./controller").PairController | undefined;
let listener: ((status: SyncStatus, pair: PairState) => void) | undefined;
export async function connectPairing(
  cb: (s: SyncStatus, p: PairState) => void,
) {
  listener = cb;
  if (!ANDROID && extensionEnvironment()) {
    if (!STORE) {
      const disconnect = foregroundPort(
        () => chrome.runtime.connect({ name: "kj:foreground" }),
        pageVisible,
        onPageVisibility,
      );
      window.addEventListener("pagehide", disconnect, { once: true });
    }
    const { documentId } = await chrome.runtime.sendMessage({
      type: "kj:hello",
    });
    const workers = new Map<string, Worker>();
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message.type === "kj:status") cb(message.status, message.pair);
      if (message.target !== documentId) return;
      if (message.type === "kj:pow-cancel") {
        workers.get(message.id)?.terminate();
        workers.delete(message.id);
      }
      if (message.type === "kj:pow") {
        const worker = new Worker(chrome.runtime.getURL("pow.worker.js"), {
          type: "module",
        });
        workers.set(message.id, worker);
        worker.onmessage = (event) => {
          respond(event.data);
          worker.terminate();
          workers.delete(message.id);
        };
        worker.onerror = () => {
          respond({ error: "POW_INVALID" });
          worker.terminate();
          workers.delete(message.id);
        };
        worker.postMessage(message.challenge);
        return true;
      }
    });
    await pairCommand("status");
  } else if (ANDROID || import.meta.env.MODE === "qa") {
    const [{ PairController }, { storage }] = await Promise.all([
      import("./controller"),
      import("../../lib/storage"),
    ]);
    const { defaults } = await import("../../lib/model");
    local = new PairController(
      async () => (await storage.get("data")) || defaults(),
      async (data) => {
        await storage.set("data", data);
        window.dispatchEvent(new CustomEvent("kj:merged", { detail: data }));
      },
      cb,
    );
    await local.init();
    if (ANDROID) {
      const update = () =>
        void local?.command("foreground", { visible: String(pageVisible()) });
      onPageVisibility(update);
      update();
      const { browserSettings } = await import(
        "../../platform/android-settings"
      );
      await browserSettings.load();
      storage.subscribe((key) => {
        if (key === "data") local?.notify();
      });
      window.addEventListener("online", () => void local?.command("sync"));
    }
  }
}
export async function pairCommand(
  action: string,
  args: Record<string, string> = {},
) {
  if (!ANDROID && extensionEnvironment())
    return chrome.runtime.sendMessage({ type: "kj:pair", action, args });
  if (local) return local.command(action, args);
  if (action === "intro" || action === "join-view")
    listener?.(
      {
        paired: false,
        connection: "offline",
        syncing: false,
        devices: [],
        relayUrl: relayDefault,
      },
      { view: action === "intro" ? "intro" : "join" },
    );
  else
    listener?.(
      {
        paired: false,
        connection: "offline",
        syncing: false,
        devices: [],
        relayUrl: relayDefault,
      },
      { view: "failure", error: "NETWORK" },
    );
}
export async function notifyPairing() {
  if (ANDROID) await local?.notify();
  else if (extensionEnvironment()) {
    const response = await chrome.runtime.sendMessage({
      type: "kj:local-committed",
    });
    if (response?.error) throw Error(response.error);
  }
}
