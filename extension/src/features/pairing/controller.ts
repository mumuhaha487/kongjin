import { deviceLabel } from "../../lib/platform";
import { KongjingSync } from "@kongjing/protocol";
import { createEngine, type ManagedClient } from "./engine";
import type { AppData } from "../../lib/model";
import { IndexedDBSecretStore } from "./secrets";
import { merge } from "../../lib/merge";
import { ANDROID, STORE } from "../../lib/build";
import { storage, type StorageAdapter } from "../../lib/storage";
import { withAppDataLock } from "../../lib/app-data";
import { RemovedNotices } from "./removed-notice";
import {
  mergeSnapshots,
  normalizeSnapshot,
  snapshotForSharing,
} from "../continuity/snapshot";
import { attachContinuity, continuityHost } from "../continuity/service";
import { installDesktopContinuity } from "../continuity/desktop";
import {
  initialStatus,
  type PairState,
  type InviteSession,
  type JoinSession,
  type SyncStatus,
  relayDefault,
} from "./types";
export class PairController {
  private loadData: () => Promise<AppData>;
  private saveData: (data: AppData) => Promise<void>;
  private client: KongjingSync<AppData>;
  private session: InviteSession | JoinSession | undefined;
  private notices: RemovedNotices;
  private groupDevices?: number;
  private pendingReady?: () => void;
  private attempt = 0;
  status: SyncStatus = initialStatus();
  pair: PairState = { view: "intro" };
  constructor(
    load: () => Promise<AppData>,
    save: (data: AppData) => Promise<void>,
    private publish: (status: SyncStatus, pair: PairState) => void,
    relay = relayDefault,
    localStorage: StorageAdapter = storage,
  ) {
    this.notices = new RemovedNotices(localStorage);
    this.loadData = load;
    this.saveData = async (data) => {
      await withAppDataLock(async () => save(merge(await load(), data)));
      this.client.notifyLocalChange();
    };
    const options = {
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      relayUrl: relay,
      secrets: new IndexedDBSecretStore(),
      withLocalLock: withAppDataLock,
      loadLocal: async () => {
        const data = await load();
        if (!STORE) {
          return snapshotForSharing(data);
        }
        return data;
      },
      saveMerged: async (data: AppData) => {
        // The protocol holds the app lock across load, merge and raw save.
        await save(STORE ? data : normalizeSnapshot(data));
        if (!STORE) {
          void continuityHost().reconcileImage();
        }
      },
      merge: STORE ? merge : mergeSnapshots,
      powWorkerUrl: ANDROID
        ? new URL("pow.worker.js", document.baseURI).href
        : typeof chrome !== "undefined" && chrome.runtime?.id
          ? chrome.runtime.getURL("pow.worker.js")
          : undefined,
      host: ANDROID ? ("android" as const) : ("desktop" as const),
    };
    this.client = createEngine(options);
    this.client.on("status", (s) => {
      const previousPhase = this.status.joinPhase;
      this.status = s;
      if (s.joinPhase) {
        this.pair = {
          view: s.joinPhase === "failed" ? "join-failed" : "completing",
        };
        this.pendingReady?.();
      } else if (previousPhase && s.paired) {
        this.pair = { view: "success" };
        void this.notices.clear().then(() => this.emit());
      }
      if (s.paired) {
        this.groupDevices = s.devices.length;
      }
      this.emit();
    });
    this.client.on("removed", () => {
      this.status = this.client.status();
      void this.notices
        .record(Date.now(), this.groupDevices)
        .then(() => this.emit());
    });
  }
  private emit() {
    this.status = { ...this.status, removedNotice: this.notices.notice };
    {
      const p = (this.client as ManagedClient).preferences();
      this.status = {
        ...this.status,
        backend: p.backend,
        directOnly: p.directOnly,
        turnUrl: p.turnUrl,
        turnUser: p.turnUser,
        hasTurnCredential: !!p.turnCredential,
      };
    }
    this.publish(this.status, this.pair);
  }
  async init() {
    await this.notices.load();
    if (!STORE) {
      const service = await attachContinuity(
        this
          .client as unknown as import("../continuity/types").ContinuityClient,
        this.loadData,
        this.saveData,
      );
      if (!ANDROID && typeof chrome !== "undefined" && chrome.permissions) {
        await installDesktopContinuity(service);
        service.subscribe((state) => {
          void chrome.runtime
            .sendMessage({ type: "kj:continuity-state", state })
            .catch(() => {});
        });
      }
    }
    // Restored welcome credentials can retry for two minutes. Let pages and
    // the offscreen RPC host show/cancel/retry that state without blocking on init.
    const pending = new Promise<void>((resolve) => {
      this.pendingReady = resolve;
    });
    const initialized = this.client.init().catch((error: unknown) => {
      if (this.status.joinPhase === "failed") return;
      throw error;
    });
    await Promise.race([initialized, pending]);
    this.pendingReady = undefined;
    this.status = this.client.status();
    this.emit();
  }
  async command(action: string, args: Record<string, string> = {}) {
    try {
      if (action === "dismiss-removed-notice") {
        await this.notices.clear();
        this.emit();
        return;
      }
      if (action === "claim-removed-toast") {
        return { noticeToast: await this.notices.claimToast(Number(args.at)) };
      }
      if (action === "status") {
        this.emit();
        return;
      }
      if (action === "foreground") {
        (this.client as ManagedClient).setForeground(args.visible === "true");
        return;
      }
      if ((action === "configure" || action === "relay")) {
        await (this.client as ManagedClient).configure(
          action === "relay"
            ? { url: args.url }
            : {
                ...(args.url !== undefined ? { url: args.url } : {}),
                ...(args.backend === "edge" || args.backend === "cloudflare" ? { backend: args.backend } : {}),
                ...(args.directOnly !== undefined
                  ? { directOnly: args.directOnly === "true" }
                  : {}),
                ...(args.turnUrl !== undefined
                  ? { turnUrl: args.turnUrl }
                  : {}),
                ...(args.turnUser !== undefined
                  ? { turnUser: args.turnUser }
                  : {}),
                ...(args.turnCredential !== undefined
                  ? { turnCredential: args.turnCredential }
                  : {}),
              },
        );
        this.status = this.client.status();
        if (this.pair.view === "failure") this.pair = { view: "intro" };
        this.emit();
        return;
      }
      if (action === "detach" && this.status.joinPhase) return;
      if (action === "cancel" || action === "detach") {
        const session = this.session;
        this.session = undefined;
        this.attempt++;
        session?.cancel();
        if (this.status.joinPhase) {
          await this.client.leave();
          this.status = this.client.status();
        }
        this.pair = args.reason
          ? { view: "failure", error: args.reason }
          : { view: "intro" };
        this.emit();
        return;
      }
      if (action === "intro" || action === "join-view") {
        if (this.status.joinPhase) {
          this.emit();
          return;
        }
        this.pair = { view: action === "intro" ? "intro" : "join" };
        this.emit();
        return;
      }
      if (action === "retry-join") {
        const attempt = ++this.attempt;
        this.pair = { view: "completing" };
        this.emit();
        const session = this.session as JoinSession | undefined;
        try {
          await (session?.retry
            ? session.retry()
            : (this.client as ManagedClient).retryJoin());
        } catch (error) {
          if (attempt === this.attempt) this.failure(error);
          return;
        }
        if (attempt !== this.attempt) return;
        await this.notices.clear();
        this.status = this.client.status();
        this.pair = { view: "success" };
        this.emit();
        return;
      }
      if (action === "confirm") {
        this.pair = { ...this.pair, waiting: true };
        this.emit();
        await this.session?.confirm();
        return;
      }
      if (action === "create" || action === "invite" || action === "join") {
        this.session?.cancel();
        this.session = undefined;
        this.pair = { view: "preparing" };
        this.emit();
        if (action === "create") {
          await this.client.createGroup(
            args.name || deviceLabel(),
            deviceLabel(),
          );
          await this.notices.clear();
        }
        if (action === "join") {
          const session = await this.client.join(
            args.code,
            args.name || deviceLabel(),
            deviceLabel(),
          );
          this.session = session;
          void session.sas
            .then((peer) => {
              if (this.session !== session) return;
              this.pair = {
                view: "sas",
                sas: peer.sas,
                peerName: peer.inviterName,
              };
              this.emit();
            })
            .catch((e) => {
              if (this.session === session) this.failure(e);
            });
          void session.done
            .then(() => this.success(session))
            .catch((e) => {
              if (this.session === session) this.failure(e);
            });
        } else {
          const session = await this.client.invite();
          this.session = session;
          this.pair = {
            view: "invite",
            code: session.code,
            expiresAt: session.expiresAt,
          };
          this.emit();
          session.onPeer((peer) => {
            if (this.session !== session) return;
            this.pair = { view: "sas", sas: peer.sas, peerName: peer.name };
            this.emit();
          });
          void session.done
            .then(() => this.success(session))
            .catch((e) => {
              if (this.session === session) this.failure(e);
            });
        }
        return;
      }
      if (action === "sync") await this.client.syncNow();
      if (action === "rename") await this.client.renameSelf(args.name);
      if (action === "remove") await this.client.removeDevice(args.id);
      if (action === "leave") await this.client.leave();
      if (action === "relay") await this.client.setRelayUrl(args.url);
      this.status = this.client.status();
      this.emit();
    } catch (e) {
      this.failure(e);
    }
  }
  private async success(session: InviteSession | JoinSession) {
    if (this.session !== session) return;
    await this.notices.clear();
    if (this.session !== session) return;
    this.pair = { view: "success" };
    this.status = this.client.status();
    this.emit();
  }
  private failure(e: unknown) {
    if (this.status.joinPhase) {
      this.pair = {
        view: this.status.joinPhase === "failed" ? "join-failed" : "completing",
      };
      this.emit();
      return;
    }
    this.pair = {
      view: "failure",
      retryAfter:
        typeof e === "object" && e && "retryAfter" in e
          ? Number(e.retryAfter)
          : undefined,
      error:
        typeof e === "object" && e && "code" in e ? String(e.code) : "NETWORK",
    };
    this.emit();
  }
  async notify() {
    this.client.notifyLocalChange();
  }
}
