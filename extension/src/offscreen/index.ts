import { PairController } from "../features/pairing/controller";
import { continuityHost } from "../features/continuity/service";
import { storage } from "../lib/storage";
import { defaults } from "../lib/model";
import type { AppData } from "../lib/model";

const publish = (message: object) => chrome.runtime.sendMessage(message).catch(() => {});
const controller = new PairController(
  async () => (await storage.get<AppData>("data")) || defaults(),
  async (data) => { await storage.set("data", data); },
  (status, pair) => { void publish({ type: "kj:status", status, pair }); },
);
const initialized = controller.init().then(() => {
  const service = continuityHost();
  service.subscribe((state) => { void publish({ type: "kj:continuity-state", state }); });
  service.setCollector(async (key, enabled) => {
    const result = await chrome.runtime.sendMessage({ type: "kj:host-collect", key, enabled });
    return result?.granted === true;
  });
  service.notifyIncoming = async (item) => {
    await chrome.runtime.sendMessage({ type: "kj:host-notify", item });
  };
});
const methods = new Set(["state", "publish", "setOption", "recordVisits", "setOpenTabs", "historyRemoved", "read", "send", "execute"]);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "kj:host-rpc") return;
  const run = async () => {
    await initialized;
    if (message.kind === "pair") {
      const result = await controller.command(message.action, message.args);
      return { ...result, status: controller.status, pair: controller.pair };
    }
    if (message.kind === "notify") { await controller.notify(); return {}; }
    if (message.kind === "continuity" && methods.has(message.action)) {
      const service = continuityHost();
      return Reflect.apply(Reflect.get(service, message.action), service, message.params || []);
    }
    throw Error("UNKNOWN_METHOD");
  };
  void run().then((value) => respond({ ok: true, value })).catch(() => respond({ ok: false, error: "NETWORK" }));
  return true;
});
