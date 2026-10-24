import { installCompatibility } from './compat';
import { matches } from './patterns';

export interface RuntimeConfig { id: string; type: 'background' | 'page' | 'content'; manifest: any; messages?: any; hosts?: string[]; documentId?: string; }
export interface Transport { postMessage(message: string): void; listen?: (listener: (event: any) => void) => void; }

export class ExtensionEvent {
  private listeners = new Set<(...args: any[]) => any>();
  addListener = (fn: (...args: any[]) => any) => { if (typeof fn !== 'function') throw new TypeError('listener must be a function'); this.listeners.add(fn); };
  removeListener = (fn: (...args: any[]) => any) => { this.listeners.delete(fn); };
  hasListener = (fn: (...args: any[]) => any) => this.listeners.has(fn);
  hasListeners = () => this.listeners.size > 0;
  snapshot = () => Array.from(this.listeners);
  emit = (...args: any[]) => { for (const fn of this.snapshot()) { try { fn(...args); } catch (e) { console.error(e); } } };
}

/** The factory is enclosed in the document-start wrapper. Content scripts receive only its chrome value. */
export function createRuntime(config: RuntimeConfig, transport: Transport) {
  installCompatibility();
  // Capture before page code can replace builtins or bridge methods.
  const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON), send = transport.postMessage.bind(transport);
  const promise = Promise, map = Map, microtask = queueMicrotask.bind(globalThis), clone = globalThis.structuredClone.bind(globalThis);
  const pending = new map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const events = new map<string, ExtensionEvent>();
  const ports = new map<string, any>();
  const doc = config.documentId || Math.random().toString(36).slice(2) + Date.now().toString(36);
  let serial = 0, endpoint = '', closed = false;
  const outbound: any[] = [];
  const event = (name: string) => { let e = events.get(name); if (!e) { e = new ExtensionEvent(); events.set(name, e); } return e; };
  const post = (m: any) => { if (closed) return; const msg = { v: 1, documentId: doc, ...m }; if (!endpoint && m.kind !== 'hello') outbound.push(msg); else send(stringify(msg)); };
  const call = (api: string, args: any[]) => new promise<any>((resolve, reject) => {
    if (closed) { reject(new Error('Extension context invalidated.')); return; }
    const id = String(++serial); pending.set(id, { resolve, reject });
    try { post({ kind: 'call', id, api, args }); } catch (e) { pending.delete(id); reject(e as Error); }
  });
  const chrome: any = {};
  const invoke = (api: string, raw: any[]) => {
    const args = [...raw]; const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    const result = call(api, args);
    if (!callback) return result;
    result.then(value => { try { callback(value); } catch (e) { microtask(() => { throw e; }); } }, error => {
      chrome.runtime.lastError = { message: error.message };
      try { callback(); } finally { delete chrome.runtime.lastError; }
    });
    return undefined;
  };
  const messageArgs = (args: any[]) => {
    const values = [...args]; const cb = typeof values[values.length - 1] === 'function' ? values.pop() : undefined;
    let extensionId: string | undefined, message: any, options: any;
    if (values.length >= 3 || values.length >= 2 && typeof values[0] === 'string' && (typeof values[1] !== 'object' || values[1] === null || !Object.keys(values[1]).every(k => ['includeTlsChannelId'].includes(k)))) [extensionId, message, options] = values;
    else [message, options] = values;
    if (extensionId && extensionId !== config.id) return invoke('runtime.sendMessageExternal', [extensionId, message, options, ...(cb ? [cb] : [])]);
    return invoke('runtime.sendMessage', [message, options || {}, ...(cb ? [cb] : [])]);
  };
  const port = (id: string, name: string, sender?: any) => {
    let disconnected = false;
    const p: any = { name, sender, onMessage: new ExtensionEvent(), onDisconnect: new ExtensionEvent(),
      postMessage(message: any) { if (disconnected) throw new Error('Attempting to use a disconnected port object'); post({ kind: 'port', id, op: 'message', message }); },
      disconnect() { if (disconnected) return; disconnected = true; ports.delete(id); post({ kind: 'port', id, op: 'disconnect' }); },
      _close(error?: string) { if (disconnected) return; disconnected = true; ports.delete(id); if (error) chrome.runtime.lastError = { message: error }; try { p.onDisconnect.emit(p); } finally { delete chrome.runtime.lastError; } }
    };
    ports.set(id, p); return p;
  };
  const connect = (api: string, args: any[]) => {
    const id = doc + ':' + ++serial; const info = args[args.length - 1] || {};
    const p = port(id, typeof info === 'object' ? info.name || '' : '');
    post({ kind: 'port', id, op: 'connect', api, args }); return p;
  };
  chrome.runtime = { id: config.id, getURL: (path = '') => `https://${config.id}.ext.kongjing.invalid/${String(path).replace(/^\/+/, '')}`,
    getManifest: () => clone(config.manifest), sendMessage: (...args: any[]) => messageArgs(args), connect: (...args: any[]) => connect('runtime.connect', args) };
  for (const name of ['onMessage', 'onConnect', 'onInstalled', 'onStartup', 'onUpdateAvailable']) chrome.runtime[name] = event('runtime.' + name);
  for (const name of ['getPlatformInfo', 'openOptionsPage', 'reload', 'setUninstallURL']) chrome.runtime[name] = (...args: any[]) => invoke('runtime.' + name, args);
  const translate = (key: string, substitutions: string | string[] = []) => {
    if (key === '@@extension_id') return config.id;
    if (key === '@@ui_locale') return 'zh_CN';
    const entry = (config.messages || {})[key.toLowerCase()]; if (!entry) return '';
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    const placeholders = entry.placeholders || {};
    return entry.message.replace(/\$([\w]+)\$/g, (_: string, p: string) => placeholders[Object.keys(placeholders).find(k => k.toLowerCase() === p.toLowerCase()) || '']?.content || '')
      .replace(/\$\$|\$(\d+)/g, (m: string, n: string) => m === '$$' ? '$' : values[+n - 1] || '');
  };
  chrome.i18n = { getMessage: translate, getUILanguage: () => 'zh-CN', getAcceptLanguages: (...args: any[]) => invoke('i18n.getAcceptLanguages', args) };
  chrome.storage = { onChanged: event('storage.onChanged') };
  for (const area of ['local', 'sync', 'session', 'managed']) {
    const obj: any = { onChanged: event(`storage.${area}.onChanged`), QUOTA_BYTES: area === 'sync' ? 102400 : 10485760 };
    if (area === 'sync') Object.assign(obj, { QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512, MAX_WRITE_OPERATIONS_PER_HOUR: 1800, MAX_WRITE_OPERATIONS_PER_MINUTE: 120 });
    for (const method of ['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel']) obj[method] = (...args: any[]) => invoke(`storage.${area}.${method}`, args);
    chrome.storage[area] = obj;
  }
  if (config.type !== 'content') {
    const methods: Record<string, string> = {
      tabs: 'query get getCurrent create update remove reload sendMessage executeScript insertCSS', windows: 'getCurrent getLastFocused getAll create',
      scripting: 'executeScript insertCSS removeCSS registerContentScripts getRegisteredContentScripts unregisterContentScripts updateContentScripts',
      action: 'setBadgeText setBadgeBackgroundColor setBadgeTextColor getBadgeText setIcon setTitle setPopup getPopup enable disable openPopup',
      alarms: 'create get getAll clear clearAll', contextMenus: 'update remove removeAll', permissions: 'contains getAll request remove',
      declarativeNetRequest: 'updateEnabledRulesets getEnabledRulesets updateDynamicRules updateSessionRules getDynamicRules getSessionRules isRegexSupported getAvailableStaticRuleCount',
      notifications: 'create update clear getAll', offscreen: 'createDocument closeDocument hasDocument', management: 'getSelf',
      webNavigation: 'getFrame getAllFrames', userScripts: 'register unregister getScripts update configureWorld getWorldConfigurations resetWorldConfiguration',
      cookies: 'get getAll set remove', downloads: 'download search', sidePanel: 'open setOptions getOptions'
    };
    for (const [ns, names] of Object.entries(methods)) {
      chrome[ns] = {};
      for (const method of names.split(' ')) chrome[ns][method] = (...args: any[]) => invoke(ns + '.' + method, args);
    }
    const eventNames: Record<string, string> = {
      tabs: 'onCreated onUpdated onActivated onRemoved', action: 'onClicked', alarms: 'onAlarm', contextMenus: 'onClicked', permissions: 'onAdded onRemoved',
      notifications: 'onClicked onClosed', webNavigation: 'onBeforeNavigate onCommitted onDOMContentLoaded onCompleted onHistoryStateUpdated',
      webRequest: 'onBeforeRequest onCompleted onErrorOccurred', cookies: 'onChanged'
    };
    for (const [ns, names] of Object.entries(eventNames)) { chrome[ns] ||= {}; for (const name of names.split(' ')) chrome[ns][name] = event(ns + '.' + name); }
    chrome.tabs.TAB_ID_NONE = -1; chrome.windows.WINDOW_ID_CURRENT = -2; chrome.windows.WINDOW_ID_NONE = -1;
    chrome.tabs.connect = (tabId: number, info: any = {}) => connect('tabs.connect', [tabId, info]);
    const functionSource = Function.prototype.toString.call.bind(Function.prototype.toString);
    chrome.scripting.executeScript = (details: any, callback?: (...args: any[]) => void) => {
      const wire = { ...details };
      if (typeof wire.func === 'function') wire.func = functionSource(wire.func);
      return invoke('scripting.executeScript', [wire, ...(callback ? [callback] : [])]);
    };
    chrome.action.setIcon = (details: any, callback?: (...args: any[]) => void) => {
      const wire = { ...details };
      if (wire.imageData) {
        const image = wire.imageData instanceof ImageData ? wire.imageData : wire.imageData[Object.keys(wire.imageData).sort((a, b) => +b - +a)[0]];
        if (!image || image.width > 1024 || image.height > 1024) throw new Error('Invalid icon imageData');
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.putImageData(image, 0, 0);
        delete wire.imageData; wire.path = canvas.toDataURL('image/png');
      }
      return invoke('action.setIcon', [wire, ...(callback ? [callback] : [])]);
    };
    chrome.contextMenus.create = (properties: any, callback?: (...args: any[]) => void) => {
      const id = properties.id ?? String(++serial); invoke('contextMenus.create', [{ ...properties, id }, ...(callback ? [callback] : [() => {}])]); return id;
    };
    chrome.browserAction = chrome.pageAction = chrome.action; chrome.menus = chrome.contextMenus;
    // Feature probes in common extensions expect these objects even on platforms without keys/fonts.
    // No shortcut or desktop font functionality is advertised; compatibility marks both unavailable.
    const localResult = (value: any, cb?: (...args: any[]) => void) => cb ? (microtask(() => cb(value)), undefined) : promise.resolve(value);
    chrome.commands = { getAll: (cb?: (...args: any[]) => void) => localResult([], cb), onCommand: new ExtensionEvent() };
    chrome.fontSettings = { getFontList: (cb?: (...args: any[]) => void) => localResult([], cb) };
    chrome.dom = { openOrClosedShadowRoot: (element: Element) => element.shadowRoot };
    chrome.extension = { getURL: chrome.runtime.getURL, inIncognitoContext: false, getBackgroundPage: () => undefined, isAllowedFileSchemeAccess: (...args: any[]) => invoke('extension.isAllowedFileSchemeAccess', args) };
  }
  const receive = (raw: any) => {
    const m = typeof raw === 'string' ? parse(raw) : raw;
    if (m.v !== 1) return;
    if (m.kind === 'hello') { endpoint = m.endpoint; for (const queued of outbound.splice(0)) send(stringify(queued)); return; }
    if (m.kind === 'reply') { const p = pending.get(String(m.id)); if (!p) return; pending.delete(String(m.id)); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.undefined ? undefined : m.result); return; }
    if (m.kind === 'inject') {
      const run = async () => {
        if (m.op === 'insertCSS') { const style = document.createElement('style'); style.dataset.kjExt = config.id; style.dataset.kjCss = m.cssKey || ''; style.textContent = m.code; (document.head || document.documentElement).appendChild(style); return null; }
        if (m.op === 'removeCSS') { document.querySelectorAll('style[data-kj-ext]').forEach(s => { if ((s as HTMLElement).dataset.kjExt === config.id && (!m.cssKey || (s as HTMLElement).dataset.kjCss === m.cssKey)) s.remove(); }); return null; }
        const result = m.world === 'MAIN'
          ? await (0, eval)(m.functionBody ? `(async function(){${m.code}\n})()` : m.code)
          : await new (Object.getPrototypeOf(async function() {}).constructor)('chrome', 'browser', '__source', m.functionBody ? m.code : 'return eval(__source);')(chrome, chrome, m.code);
        return clone(result);
      };
      run().then(value => post({ kind: 'injectionResult', id: m.id, value: value === undefined ? null : value }), e => post({ kind: 'injectionResult', id: m.id, error: String(e?.message || e) }));
      return;
    }
    if (m.kind === 'event') { if(m.api==='_host.visibility')runtime.setVisible?.(!!m.args[0]);event(m.api).emit(...(m.args || [])); if (m.api === 'storage.onChanged') event('storage.' + m.args[1] + '.onChanged').emit(m.args[0]); return; }
    if (m.kind === 'message') {
      let answered = false, asynchronous = false;
      const respond = (value?: any, error?: string) => { if (answered) return false; answered = true; post({ kind: 'response', id: m.id, handled: true, value, error }); return true; };
      for (const listener of event('runtime.onMessage').snapshot()) {
        try {
          const returned = listener(m.message, m.sender, respond);
          if (returned === true) asynchronous = true;
          else if (returned && typeof returned.then === 'function') { asynchronous = true; promise.resolve(returned).then(v => respond(v), e => respond(null, String(e?.message || e))); }
        } catch (e) { console.error(e); }
      }
      if (!answered && !asynchronous) post({ kind: 'response', id: m.id, handled: false });
      return;
    }
    if (m.kind === 'port') {
      if (m.op === 'connect') { const p = port(m.id, m.name || '', m.sender); event('runtime.onConnect').emit(p); }
      else if (m.op === 'message') ports.get(m.id)?.onMessage.emit(m.message, ports.get(m.id));
      else if (m.op === 'disconnect') ports.get(m.id)?._close(m.error);
    }
  };
  post({ kind: 'hello', id: 'hello' });
  const runtime: any = { chrome, browser: chrome, receive, call, config, event, destroy() { closed = true; pending.forEach(p => p.reject(new Error('Extension context invalidated.'))); pending.clear(); ports.forEach(p => p._close()); } };
  return runtime;
}

export function captureBridge(name: string): Transport {
  const remove = Reflect.deleteProperty.bind(Reflect), bridge = (globalThis as any)[name];
  if (!bridge || typeof bridge.postMessage !== 'function') throw new Error('Missing native extension channel');
  const post = bridge.postMessage.bind(bridge);
  remove(globalThis, name);
  return { postMessage: post, listen(listener) { bridge.onmessage = listener; } };
}
