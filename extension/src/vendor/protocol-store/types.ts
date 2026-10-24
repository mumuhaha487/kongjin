export type Platform = string;
export interface SecretStore {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  delete(k: string): Promise<void>;
}
export interface SyncOptions<D> {
  relayUrl: string;
  secrets: SecretStore;
  loadLocal: () => Promise<D>;
  saveMerged: (data: D) => Promise<void>;
  merge: (local: D, remote: D) => D;
  powWorkerUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Separate IndexedDB/data store; never use the SecretStore instance here. */
  queueStore?: QueueStore;
}
export interface QueueStore {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  delete(k: string): Promise<void>;
}
export interface JournalRecord {
  id: string;
  seq: number;
  t: string;
  dev: string;
  at: number;
  [k: string]: unknown;
}
export type Slot = { dev: string; at: number; payload: any };
export type Incoming = { id: string; from: string; at: number; k: string; u?: string; ti?: string; tx?: string };
export type Member = {
  deviceId: string;
  pub: string;
  name: string;
  platform: string;
  joinedAt: number;
  addedBy: string;
};
export type Device = {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeenAt?: number;
  self: boolean;
};
export type SyncStatus = {
  paired: boolean;
  connection: "offline" | "connecting" | "online";
  syncing: boolean;
  devices: Device[];
  lastSyncAt?: number;
  epoch?: number;
  relayUrl: string;
  error?: string;
  historyGap?: boolean;
};
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
  sas: Promise<{ sas: string; inviterName: string; platform: string }>;
  confirm(): Promise<void>;
  cancel(): void;
  done: Promise<void>;
}
export type SnapshotPlain<D> = {
  v: 1;
  writer: string;
  at: number;
  group: { epoch: number; members: Member[] };
  data: D;
};
export type Envelope = { v: 1; iv: string; ct: string };
export type EnvelopePlain = {
  t: string;
  from: string;
  at: number;
  [key: string]: unknown;
};
export type PowChallenge = {
  challenge: string;
  difficulty: number;
  expiresAt: number;
  purpose: "group" | "pair";
  sig: string;
};
export type PowProof = PowChallenge & { nonce: string };
export const ERROR_CODES = [
  "BAD_REQUEST",
  "POW_REQUIRED",
  "POW_INVALID",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "GONE",
  "PRECONDITION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "ROOM_FULL",
  "SERVER_ERROR",
  "BAD_CODE",
  "SAS_MISMATCH",
  "EXPIRED",
  "GROUP_FULL",
  "NETWORK",
  "CANCELLED",
  "SNAPSHOT_TOO_LARGE",
  "RELAY_CHANGE_REQUIRES_REPAIR",
] as const;
export class ProtocolError extends Error {
  constructor(
    public code: string,
    message = code,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
