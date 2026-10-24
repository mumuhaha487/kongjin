import { useStore } from "../app/store";
import { acquireIcon } from "../features/bookmarks/icons";
import { compressImage, blobDataUrl, imageTone } from "../lib/images";
import { defaults } from "../lib/model";
import { encodeBackup, decodeBackup } from "../lib/backup";
import { importData } from "../app/store";
import { STORE } from "../lib/build";
import { ambient } from "../lib/ambient";
import { appData, withAppDataLock } from "../lib/app-data";
import { storage } from "../lib/storage";
import { merge } from "../lib/merge";
const harness = {
  getState: useStore.getState,
  setState: useStore.setState,
  defaults,
  compressImage,
  blobDataUrl,
  imageTone,
  acquireIcon,
  encodeBackup,
  decodeBackup,
  importData,
  ambient,
  appData,
  withAppDataLock,
  storage,
  merge,
};
(window as unknown as { kjTest: typeof harness }).kjTest = harness;
if (!STORE)
  void import("../features/continuity/bridge").then((m) => {
    Object.assign(harness, {
      continuity: m.continuityCommand,
      relayState: m.useContinuity,
      openRelay: m.openContinuity,
      // QA-only host for the shared SendRow at the mobile drawer's real width.
      async showSendPreview() {
        const [{ createElement }, { createRoot }, { Modal }, { SendRow }] =
          await Promise.all([
            import("react"),
            import("react-dom/client"),
            import("../components/Common/Common"),
            import("../features/continuity/RelayUI"),
          ]);
        const node = document.createElement("div");
        document.body.append(node);
        const root = createRoot(node);
        root.render(
          createElement(Modal, {
            title: "发送到设备",
            onClose: () => {
              // The QA-only mobile host keeps its drawer while the portalled menu handles Esc.
              if (document.activeElement?.closest('[role="menu"]')) return;
              root.unmount();
              node.remove();
            },
            children: [
              createElement("h1", { key: "title" }, "发送到设备"),
              createElement(SendRow, {
                key: "send",
                url: "https://kongjing.inc.re/",
                title: "空境 — 安静的新标签页",
              }),
            ],
          }),
        );
      },
    });
  });
