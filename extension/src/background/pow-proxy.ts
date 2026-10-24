// MV3 service workers cannot spawn dedicated Workers. The initiating extension
// page hosts the library Worker; the service worker still owns every connection.
let actor: string | undefined;
export function setPowActor(documentId?: string) {
  actor = documentId;
}
class PageWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private id = crypto.randomUUID();
  private stopped = false;
  constructor(private url: string) {}
  postMessage(challenge: unknown) {
    void chrome.runtime
      .sendMessage({
        type: "kj:pow",
        target: actor,
        id: this.id,
        url: this.url,
        challenge,
      })
      .then((result) => {
        if (this.stopped) return;
        if (result?.error) throw Error(result.error);
        this.onmessage?.({ data: result } as MessageEvent);
      })
      .catch((error) =>
        this.onerror?.({ message: String(error) } as ErrorEvent),
      );
  }
  terminate() {
    this.stopped = true;
    void chrome.runtime
      .sendMessage({ type: "kj:pow-cancel", id: this.id, target: actor })
      .catch(() => {});
  }
}
if (typeof Worker === "undefined")
  (globalThis as unknown as { Worker: typeof Worker }).Worker =
    PageWorker as unknown as typeof Worker;
