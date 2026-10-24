import { contentMatches, matches } from './patterns';

/** One lexical scope across all files and run_at stages for this extension/document. */
export async function runContent(runtime: any, scripts: any[], scope: any = globalThis, executor?: (...args: any[]) => Promise<void>): Promise<void> {
  const doc: Document = scope.document;
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const evaluate = eval, makeStyle = doc.createElement.bind(doc), now = Date.now.bind(Date);
  const nativeSheets = Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets')?.get;
  const nativeAdopted = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets')?.get;
  // A local facade keeps polyfills using globalThis.chrome working without altering window.chrome.
  // Capture the stylesheet collections before MAIN scripts hide their own generated sheets.
  let facade: any;
  const unwrap = (value: any) => value === documentFacade ? doc : value === facade ? scope : value;
  const documentFacade: Document = new Proxy(doc, { get(target, key) {
    if (key === 'styleSheets' && nativeSheets) return nativeSheets.call(target);
    if (key === 'adoptedStyleSheets' && nativeAdopted) return nativeAdopted.call(target);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? (...args: any[]) => Reflect.apply(value, target, args.map(unwrap)) : value;
  }, set(target, key, value) {
    return Reflect.set(target, key, unwrap(value), target);
  } });
  const Observer = new Proxy(scope.MutationObserver, { construct(target, args) {
    const observer: MutationObserver = Reflect.construct(target, args);
    const observe = observer.observe.bind(observer);
    observer.observe = (node: Node, options?: MutationObserverInit) => observe(unwrap(node), options);
    return observer;
  } });
  facade = new Proxy(scope, { get(target, key) {
    if (key === 'chrome' || key === 'browser') return runtime.chrome;
    if (key === 'document') return documentFacade;
    if (key === 'MutationObserver') return Observer;
    if (key === 'window' || key === 'self' || key === 'globalThis' || key === 'top' && scope === scope.top) return facade;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' && !value.prototype ? value.bind(target) : value;
  } });
  const listen = doc.addEventListener.bind(doc), windowListen = scope.addEventListener.bind(scope);
  let fallback = '';
  try { fallback = scope.parent.location.href; } catch { fallback = doc.referrer; }
  const selected = scripts.map(normalizeContentScript).filter(s => contentMatches(s, scope.location.href, scope === scope.top, fallback));
  if (runtime.config.contentHosts && !runtime.config.contentHosts.some((p: string) => matches(p, scope.location.href, true))) return;
  if (!selected.length) return;
  // Chrome document_start runs after the root element exists. addInitScript may precede it.
  if (!doc.documentElement) await new Promise<void>(resolve => { const observer = new MutationObserver(() => { if (doc.documentElement) { observer.disconnect(); resolve(); } }); observer.observe(doc, { childList: true }); });
  let domAt = doc.readyState === 'loading' ? 0 : now();
  const end = doc.readyState !== 'loading' ? Promise.resolve() : new Promise<void>(resolve => listen('DOMContentLoaded', () => { domAt = now(); resolve(); }, { once: true }));
  const load = doc.readyState === 'complete' ? Promise.resolve() : new Promise<void>(resolve => windowListen('load', () => resolve(), { once: true }));
  const idle = end.then(() => Promise.race([load, new Promise<void>(resolve => setTimeout(resolve, Math.max(0, 200 - (now() - domAt))))]));
  for (const script of selected) if (script.cssText) {
    const style = makeStyle('style'); style.dataset.kjExt = runtime.config.id; style.textContent = script.cssText;
    if (doc.head || doc.documentElement) (doc.head || doc.documentElement).appendChild(style);
    else { const observer = new MutationObserver(() => { if (doc.documentElement) { doc.documentElement.appendChild(style); observer.disconnect(); } }); observer.observe(doc, { childList: true }); }
  }
  const phase = (runAt: string) => selected.filter(s => (s.run_at || 'document_idle') === runAt).map(s => s.world === 'MAIN' ? `__main(${JSON.stringify(s.jsText || '')});` : s.jsText || '').join('\n;\n');
  const body = phase('document_start') + '\n;await __end;\n' + phase('document_end') + '\n;await __idle;\n' + phase('document_idle');
  const run = executor || new AsyncFunction('chrome', 'browser', 'window', 'self', 'globalThis', 'document', 'MutationObserver', '__end', '__idle', '__main', body);
  const main = !!executor && selected.every(s => s.world === 'MAIN');
  await run(main ? undefined : runtime.chrome, main ? undefined : runtime.browser, main ? scope : facade, main ? scope : facade, main ? scope : facade, main ? doc : documentFacade, main ? scope.MutationObserver : Observer, end, idle, (code: string) => evaluate(code));
}

/** scripting.RegisteredContentScript uses camelCase; manifests use snake_case. */
export function normalizeContentScript(script: any): any {
  const result = { ...script };
  for (const [api, manifest] of Object.entries({ runAt: 'run_at', allFrames: 'all_frames', excludeMatches: 'exclude_matches', includeGlobs: 'include_globs', excludeGlobs: 'exclude_globs', matchAboutBlank: 'match_about_blank', matchOriginAsFallback: 'match_origin_as_fallback' })) {
    if (api in script) result[manifest] = script[api];
  }
  return result;
}
