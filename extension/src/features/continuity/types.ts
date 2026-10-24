import type { Device, SyncStatus } from "../pairing/types";
export interface ContinuityOptions {
  profile: boolean;
  background: boolean;
  history: boolean;
  tabs: boolean;
  search: boolean;
  incoming: boolean;
  resume: boolean;
  retentionDays: 30 | 90;
  excluded: string[];
}
export const continuityDefaults: ContinuityOptions = {
  profile: true,
  background: true,
  history: false,
  tabs: false,
  search: false,
  incoming: true,
  resume: true,
  retentionDays: 30,
  excluded: [],
};
export interface RawVisit {
  u: string;
  ti: string;
  at: number;
}
export interface Visit extends RawVisit {
  id: string;
  dev: string;
  text: string;
  terms: string[];
}
export interface JournalRecord {
  id: string;
  seq: number;
  t: string;
  dev: string;
  at: number;
  [key: string]: unknown;
}
export interface TabItem {
  u: string;
  ti: string;
  active: boolean;
}
export interface Slot {
  dev: string;
  at: number;
  payload: {
    dev?: string;
    at?: number;
    windows: { focused: boolean; tabs: TabItem[] }[];
    last?: RawVisit;
  };
}
export interface Incoming {
  id: string;
  from: string;
  at: number;
  k: string;
  u?: string;
  ti?: string;
  tx?: string;
  read?: boolean;
}
export interface DeleteRule {
  id: string;
  dev: string;
  at: number;
  ids?: string[];
  range?: { from: number; to: number };
  scope: "self" | "all";
}
export interface HistoryQuery {
  query?: string;
  dev?: string;
  before?: [number, string];
  limit?: number;
  others?: boolean;
}
export interface HistoryPage {
  items: Visit[];
  next?: [number, string];
}
export interface ContinuityState {
  options: ContinuityOptions;
  slots: Slot[];
  inbox: Incoming[];
  status: SyncStatus;
  available: boolean;
  historyGap: boolean;
  localUrls?: string[];
  error?: string;
}
export interface ContinuityClient {
  status(): SyncStatus;
  on(event: "status", cb: (s: SyncStatus) => void): () => void;
  journalAppend(t: string, payload: object): string;
  syncNow?(): Promise<void>;
  onJournal(
    cb: (
      records: JournalRecord[],
      info: { replay: boolean },
    ) => void | Promise<void>,
  ): () => void;
  journalCursor(): number;
  putSlot(payload: object): Promise<void>;
  getSlots(): Promise<Slot[]>;
  onSlots(cb: (slots: Slot[]) => void): () => void;
  deleteSlot(): Promise<void>;
  putBlob(
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ blobId: string; size: number }>;
  getBlob(blobId: string): Promise<Uint8Array>;
  deleteBlob(blobId: string): Promise<void>;
  sendTo(
    id: string,
    item: { k: "url" | "text"; u?: string; ti?: string; tx?: string },
  ): string;
  onIncoming(cb: (item: Incoming) => void): () => void;
  ack(id: string): void;
}
export const otherDevices = (s: SyncStatus): Device[] =>
  s.devices.filter((d) => !d.self);
