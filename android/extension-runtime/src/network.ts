import { matches } from './patterns';

export function installNetwork(runtime: any, scope: any = globalThis): void {
  if (runtime.config.type === 'content') return;
  const originalFetch = scope.fetch.bind(scope), OriginalXHR = scope.XMLHttpRequest;
  const permitted = (url: string) => !new URL(url).hostname.endsWith('.ext.kongjing.invalid') && (runtime.config.hosts || []).some((p: string) => matches(p, url, true));
  const encode = (bytes: Uint8Array) => { let out = ''; for (let i = 0; i < bytes.length; i += 16384) out += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(out); };
  scope.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (!permitted(request.url)) return originalFetch(input, init);
    const abortReason = () => request.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (request.signal.aborted) throw abortReason();
    return new Promise<Response>((resolve, reject) => {
      const cleanup = () => request.signal.removeEventListener('abort', onAbort);
      const onAbort = () => { cleanup(); reject(abortReason()); };
      request.signal.addEventListener('abort', onAbort, { once: true });
      // The bridge cannot cancel native I/O yet, but callers must observe abort immediately.
      (async () => {
        const bytes = request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());
        if (request.signal.aborted) throw abortReason();
        const result = await runtime.call('network.fetch', [request.url, {
          method: request.method, headers: Object.fromEntries(request.headers.entries()), bodyBase64: bytes ? encode(bytes) : undefined,
          credentials: request.credentials, initiatorOrigin: scope.location.origin, redirect: request.redirect
        }]);
        if (request.signal.aborted) throw abortReason();
        if (result.status === 0 && request.redirect === 'manual') {
          const response = Response.error();
          Object.defineProperties(response, { type: { value: 'opaqueredirect' }, url: { value: result.url } });
          return response;
        }
        const body = Uint8Array.from(atob(result.bodyBase64), c => c.charCodeAt(0));
        const response = new Response([101, 204, 205, 304].includes(result.status) ? null : body, { status: result.status, headers: result.headers });
        Object.defineProperties(response, { url: { value: result.url }, redirected: { value: !!result.redirected } });
        return response;
      })().then(response => { cleanup(); resolve(response); }, error => { cleanup(); reject(error); });
    });
  };
  scope.XMLHttpRequest = class extends EventTarget {
    static UNSENT = 0; static OPENED = 1; static HEADERS_RECEIVED = 2; static LOADING = 3; static DONE = 4;
    UNSENT = 0; OPENED = 1; HEADERS_RECEIVED = 2; LOADING = 3; DONE = 4;
    private inner: XMLHttpRequest | null = null; private headers: Record<string, string> = {}; private method = ''; private url = ''; private async = true; private sending = false; private controller = new AbortController(); private responseHeaders = new Headers(); private timer: ReturnType<typeof setTimeout> | null = null;
    readyState = 0; status = 0; statusText = ''; response: any = null; responseText = ''; responseURL = ''; responseType: XMLHttpRequestResponseType = ''; timeout = 0; withCredentials = false; upload = new EventTarget();
    onreadystatechange: any; onload: any; onerror: any; onabort: any; onloadend: any; onloadstart: any; onprogress: any; ontimeout: any;
    private emit(name: string) { const e = new ProgressEvent(name); this.dispatchEvent(e); (this as any)['on' + name]?.call(this, e); }
    private clearTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
    private resetResponse() { this.status = 0; this.statusText = ''; this.response = null; this.responseText = ''; this.responseURL = ''; this.responseHeaders = new Headers(); }
    open(method: string, url: string, async = true) {
      const previous = this.inner; this.inner = null; previous?.abort(); this.controller.abort(); this.clearTimer(); this.sending = false;
      this.url = new URL(url, scope.location.href).href; this.method = method.toUpperCase(); this.async = async; this.headers = {}; this.controller = new AbortController(); this.resetResponse();
      if (!permitted(this.url) || !async) {
        const inner = this.inner = new OriginalXHR(); inner.open(method, url, async);
        for (const name of ['readystatechange', 'load', 'error', 'abort', 'loadend', 'loadstart', 'progress', 'timeout']) inner.addEventListener(name, () => {
          if (this.inner !== inner) return;
          for (const key of ['readyState', 'status', 'statusText', 'response', 'responseURL']) try { (this as any)[key] = (inner as any)[key]; } catch { /* responseType guards */ }
          try { this.responseText = inner.responseText; } catch { }
          this.emit(name);
        });
      }
      this.readyState = 1; this.emit('readystatechange');
    }
    setRequestHeader(k: string, v: string) { if (this.inner) this.inner.setRequestHeader(k, v); else this.headers[k] = v; }
    getResponseHeader(k: string) { return this.inner ? this.inner.getResponseHeader(k) : this.responseHeaders.get(k); }
    getAllResponseHeaders() { return this.inner ? this.inner.getAllResponseHeaders() : Array.from(this.responseHeaders.entries()).map(([k, v]) => k + ': ' + v + '\r\n').join(''); }
    overrideMimeType(mime: string) { this.inner?.overrideMimeType(mime); }
    abort() {
      if (this.inner) { this.inner.abort(); this.readyState = this.inner.readyState; this.resetResponse(); return; }
      const active = this.sending; this.sending = false; this.clearTimer(); this.controller.abort(); this.resetResponse();
      if (active) { this.readyState = 4; this.emit('readystatechange'); this.emit('abort'); this.emit('loadend'); }
      this.readyState = 0;
    }
    send(body?: XMLHttpRequestBodyInit | null) {
      if (this.inner) { if (this.async) { this.inner.responseType = this.responseType; this.inner.timeout = this.timeout; } this.inner.withCredentials = this.withCredentials; this.inner.send(body); return; }
      if (this.readyState !== 1 || this.sending) throw new DOMException('XHR is not open or is already sending', 'InvalidStateError');
      const controller = this.controller, active = () => this.controller === controller && this.sending;
      this.sending = true; this.emit('loadstart');
      if (!active()) return;
      const fail = (event: string) => {
        if (!active()) return;
        this.sending = false; this.clearTimer(); controller.abort(); this.resetResponse(); this.readyState = 4;
        this.emit('readystatechange'); this.emit(event); this.emit('loadend');
      };
      this.timer = this.timeout ? setTimeout(() => fail('timeout'), this.timeout) : null;
      scope.fetch(this.url, { method: this.method, headers: this.headers, body: ['GET', 'HEAD'].includes(this.method) ? null : body, signal: controller.signal, credentials: this.withCredentials ? 'include' : 'same-origin' }).then(async (r: Response) => {
        if (!active()) return;
        this.status = r.status; this.responseURL = r.url; this.responseHeaders = r.headers; this.readyState = 2; this.emit('readystatechange');
        if (!active()) return;
        this.readyState = 3; this.emit('readystatechange');
        if (!active()) return;
        const response = this.responseType === 'arraybuffer' ? await r.arrayBuffer() : this.responseType === 'blob' ? await r.blob() : this.responseType === 'json' ? await r.json() : await r.text();
        if (!active()) return;
        this.response = response;
        if (!this.responseType || this.responseType === 'text') this.responseText = this.response;
        this.sending = false; this.clearTimer();
        this.readyState = 4; this.emit('readystatechange'); this.emit('load'); this.emit('loadend');
      }).catch(() => fail('error'));
    }
  };
}
