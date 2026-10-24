import type { RemovedNotice } from "./removed-notice";
export interface Device {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeenAt?: number;
  self: boolean;
  transport?: "direct" | "relay" | "offline";
  joining?: boolean;
}
export interface SyncStatus {
  paired: boolean;
  connection: "offline" | "connecting" | "online";
  syncing: boolean;
  devices: Device[];
  lastSyncAt?: number;
  epoch?: number;
  relayUrl: string;
  backend?: "cloudflare" | "edge";
  error?: string;
  removedNotice?: RemovedNotice;
  transport?: "direct" | "relay" | "offline";
  directOnly?: boolean;
  turnUrl?: string;
  turnUser?: string;
  hasTurnCredential?: boolean;
  joinPhase?: "completing" | "failed";
}
export interface SecretStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface SyncOptions<D> {
  relayUrl: string;
  secrets: SecretStore;
  loadLocal: () => Promise<D>;
  saveMerged: (data: D) => Promise<void>;
  merge: (a: D, b: D) => D;
  withLocalLock?: <T>(task: () => Promise<T>) => Promise<T>;
  powWorkerUrl?: string;
  fetch?: typeof fetch;
  host?: "android" | "desktop";
}
export interface InviteSession {
  code: string;
  expiresAt: number;
  onPeer(
    cb: (peer: { name: string; platform: string; sas: string }) => void,
  ): void;
  confirm(): Promise<void>;
  cancel(): void;
  done: Promise<Device>;
}
export interface JoinSession {
  sas: Promise<{ sas: string; inviterName: string }>;
  confirm(): Promise<void>;
  cancel(): void;
  retry?(): Promise<void>;
  done: Promise<void>;
}
export type PairView =
  | "intro"
  | "preparing"
  | "completing"
  | "join-failed"
  | "invite"
  | "join"
  | "sas"
  | "success"
  | "failure";
export interface PairState {
  view: PairView;
  code?: string;
  expiresAt?: number;
  sas?: string;
  peerName?: string;
  error?: string;
  waiting?: boolean;
  retryAfter?: number;
}
export const relayDefault = "https://kongjing.inc.re";
export const initialStatus = (): SyncStatus => ({
  paired: false,
  connection: "offline",
  syncing: false,
  devices: [],
  relayUrl: relayDefault,
});
export function normalizePairCode(input: string) {
  const s = input
    .toUpperCase()
    .replace(/^\s*KJ[-\s]*/, "")
    .replace(/[-\s]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(s) ? s : null;
}
export function formatPairCode(input: string) {
  const s = normalizePairCode(input);
  return s ? `KJ-${s.slice(0, 5)}-${s.slice(5)}` : "";
}
export const displayPairInput = (input: string) => {
  const raw = input
    .toUpperCase()
    .replace(/^KJ[-\s]*/, "")
    .replace(/[^0-9A-Z]/g, "")
    .slice(0, 10);
  return raw
    ? `KJ-${raw.slice(0, 5)}${raw.length > 5 ? `-${raw.slice(5)}` : ""}`
    : "";
};
export const formatSas = (sas: string) =>
  sas
    .replace(/\D/g, "")
    .padStart(6, "0")
    .slice(-6)
    .replace(/(.{3})(.{3})/, "$1 $2");
export const pairingError = (code: string, retryAfter = 60) =>
  code === "RATE_LIMITED"
    ? `操作太频繁，请 ${Math.max(1, Math.ceil(retryAfter / 60))} 分钟后再试`
    : {
        BAD_CODE: "配对码不正确或已过期",
        EXPIRED: "配对码不正确或已过期",
        NETWORK: "无法连接中转服务器",
        SAS_MISMATCH: "安全码未确认，已取消",
        CANCELLED: "安全码未确认，已取消",
        GROUP_FULL: "配对组已满（最多 10 台设备）",
        SNAPSHOT_TOO_LARGE: "同步数据超过 1 MB，请减少自定义图标或背景",
        RELAY_CHANGE_REQUIRES_REPAIR: "更换中转服务器需要重新配对",
      }[code] || "无法连接中转服务器";
