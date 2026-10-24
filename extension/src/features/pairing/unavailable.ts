// Production adapter until the separately owned protocol library publishes READY.md.
// Never simulate successful pairing or persist fake group credentials.
import { initialStatus, type SyncOptions, type SyncStatus } from "./types";
export class KongjingSync<D> {
  private state = initialStatus();
  constructor(options: SyncOptions<D>) {
    this.state.relayUrl = options.relayUrl;
  }
  async init() {}
  status() {
    return this.state;
  }
  on(_event: string, _cb: (s: SyncStatus) => void) {
    return () => {};
  }
  private fail(): never {
    throw Object.assign(Error("NETWORK"), { code: "NETWORK" });
  }
  async createGroup(_name: string, _platform: string) {
    this.fail();
  }
  async invite(): Promise<import("./types").InviteSession> {
    return this.fail();
  }
  async join(
    _code: string,
    _name: string,
    _platform: string,
  ): Promise<import("./types").JoinSession> {
    return this.fail();
  }
  notifyLocalChange() {}
  async syncNow() {
    this.fail();
  }
  async renameSelf(_name: string) {
    this.fail();
  }
  async removeDevice(_id: string) {
    this.fail();
  }
  async leave() {}
  async setRelayUrl(url: string) {
    this.state.relayUrl = url;
  }
  dispose() {}
}
