import type { StorageAdapter } from "../../lib/storage";

export interface RemovedNotice {
  at: number;
  groupDevices?: number;
}

// Local-only metadata: never add this to AppData or the encrypted snapshot.
// One controller owns the queue (the background worker on desktop), so two
// home tabs cannot both claim a toast or race acknowledgement with persistence.
export class RemovedNotices {
  notice?: RemovedNotice;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private storage: StorageAdapter) {}
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }
  load() {
    return this.serial(async () => {
      this.notice = await this.storage.get<RemovedNotice>("removedNotice");
    });
  }
  record(at: number, groupDevices?: number) {
    return this.serial(async () => {
      this.notice = { at, ...(groupDevices ? { groupDevices } : {}) };
      await this.storage.set("removedNotice", this.notice);
    });
  }
  clear() {
    return this.serial(async () => {
      await this.storage.remove("removedNotice");
      this.notice = undefined;
    });
  }
  claimToast(at: number) {
    return this.serial(async () => {
      if (!this.notice || this.notice.at !== at) return;
      if ((await this.storage.get<number>("removedNoticeToast")) === at) return;
      await this.storage.set("removedNoticeToast", at);
      return this.notice;
    });
  }
}
