import { readFile } from 'node:fs/promises';
export const bundle = await readFile(new URL('../../app/src/main/assets/ext-runtime/runtime.js', import.meta.url), 'utf8');
export const ID = 'abcdefghijklmnopabcdefghijklmnop';

/** Desktop transport mirror. Production persistence/identity/DNR are tested independently on JVM. */
export class TestBridge {
  endpoints = new Map(); messages = new Map(); ports = new Map(); stores = new Map(); counter = 0; tabs = [{ id: 1, url: 'https://example.test/', active: true, status: 'complete', title: 'Example', windowId: 1 }];
  async attach(context) {
    await context.exposeBinding('__nativeTest', async ({ frame }, raw) => {
      const m = JSON.parse(raw); const endpoint = this.endpoints.get(m.documentId);
      const reply = async (value, error) => this.send(frame, { kind: 'reply', id: m.id, result: value ?? null, undefined: value === undefined, error });
      if (m.kind === 'hello') { for (const [key, e] of this.endpoints) if(e.frame===frame)this.endpoints.delete(key); this.endpoints.set(m.documentId, { frame, config: m.testConfig, key: m.documentId }); return this.send(frame, { kind: 'hello', endpoint: m.documentId }); }
      if (m.kind === 'response') {
        const pending = this.messages.get(m.id); if (!pending) return;
        if (m.handled) { this.messages.delete(m.id); return this.send(pending.frame, { kind: 'reply', id: pending.call, result: m.value, undefined: !('value' in m), error: m.error }); }
        if (--pending.waiting === 0) { this.messages.delete(m.id); return this.send(pending.frame, { kind: 'reply', id: pending.call, undefined: true }); }
        return;
      }
      if (m.kind === 'port') {
        if (m.op === 'connect') {
          const targets = [...this.endpoints.values()].filter(e => e.key !== endpoint.key && e.config.id === endpoint.config.id && e.config.type !== 'content');
          if (!targets.length) return this.send(frame, { kind: 'port', id: m.id, op: 'disconnect', error: 'Could not establish connection. Receiving end does not exist.' });
          this.ports.set(m.id, { source: endpoint, targets });
          return Promise.all(targets.map(e => this.send(e.frame, { kind: 'port', id: m.id, op: 'connect', name: m.args[0]?.name || '', sender: { id: endpoint.config.id } })));
        }
        const p = this.ports.get(m.id); if (!p) return;
        const targets = endpoint.key === p.source.key ? p.targets : [p.source];
        if (m.op === 'disconnect') this.ports.delete(m.id);
        return Promise.all(targets.map(e => this.send(e.frame, m)));
      }
      if (m.kind !== 'call') return;
      if (m.api === 'runtime.sendMessage') {
        const receivers = [...this.endpoints.values()].filter(e => e.key !== endpoint.key && e.config.id === endpoint.config.id && e.config.type !== 'content');
        if (!receivers.length) return reply(undefined, 'Could not establish connection. Receiving end does not exist.');
        const id = String(++this.counter); this.messages.set(id, { frame, call: m.id, waiting: receivers.length });
        return Promise.all(receivers.map(e => this.send(e.frame, { kind: 'message', id, message: m.args[0], sender: { id: endpoint.config.id, frameId: 0, url: frame.url() } })));
      }
      try {
        if (m.api.startsWith('storage.')) {
          const [, area, method] = m.api.split('.'); const key = endpoint.config.id + ':' + area;
          const data = this.stores.get(key) || {}; const keys = m.args[0];
          if (method === 'get') return reply(keys == null ? data : Object.fromEntries((typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)).filter(k => k in data || typeof keys === 'object' && !Array.isArray(keys)).map(k => [k, k in data ? data[k] : keys[k]])));
          if (method === 'getBytesInUse') return reply(Buffer.byteLength(JSON.stringify(data)));
          const before = structuredClone(data);
          if (method === 'set') Object.assign(data, keys);
          if (method === 'clear') Object.keys(data).forEach(k => delete data[k]);
          if (method === 'remove') (Array.isArray(keys) ? keys : [keys]).forEach(k => delete data[k]);
          this.stores.set(key, data);
          const changes = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(data)])].filter(k => JSON.stringify(before[k]) !== JSON.stringify(data[k])).map(k => [k, { ...(k in before ? { oldValue: before[k] } : {}), ...(k in data ? { newValue: data[k] } : {}) }]));
          if (Object.keys(changes).length) await this.event(endpoint.config.id, 'storage.onChanged', [changes, area]);
          return reply();
        }
        if (m.api === 'tabs.query') return reply(this.tabs.filter(t => m.args[0]?.active == null || t.active === m.args[0].active));
        if (m.api === 'tabs.create') {
          const tab = { id: this.tabs.length + 1, windowId: 1, active: true, status: 'loading', ...m.args[0] }; this.tabs.push(tab);
          await this.event(endpoint.config.id, 'tabs.onCreated', [tab]);
          await this.event(endpoint.config.id, 'tabs.onActivated', [{ tabId: tab.id, windowId: 1 }]);
          await this.event(endpoint.config.id, 'tabs.onUpdated', [tab.id, { status: 'complete' }, { ...tab, status: 'complete' }]);
          return reply(tab);
        }
        if (m.api === 'scripting.executeScript') {
          const d = m.args[0]; let result;
          if (d.func) result = await frame.evaluate(({ fn, args }) => (0, eval)('(' + fn + ')')(...args), { fn: d.func, args: d.args || [] });
          else result = await frame.evaluate('42');
          return reply([{ frameId: 0, result }]);
        }
        if (m.api === 'network.fetch') return reply({ status: 200, headers: { 'content-type': 'text/plain' }, bodyBase64: Buffer.from('native response').toString('base64'), url: m.args[0] });
        if (m.api === 'runtime.getPlatformInfo') return reply({ os: 'android', arch: 'arm', nacl_arch: 'arm' });
        if (m.api === 'i18n.getAcceptLanguages') return reply(['zh-CN', 'zh', 'en']);
        throw new Error('空境尚不支持 ' + m.api);
      } catch (e) { return reply(undefined, e.message); }
    });
  }
  send(frame, m) { return frame.evaluate(m => globalThis.__runtime.receive({ v: 1, ...m }), m).catch(e => { if (!/closed|destroyed|navigation/i.test(e.message)) throw e; }); }
  event(id, name, args) { return Promise.all([...this.endpoints.values()].filter(e => e.config.id === id).map(e => this.send(e.frame, { kind: 'event', api: name, args }))); }
}
export async function init(context, config) {
  await context.addInitScript({ content: `(function(){${bundle};const config=${JSON.stringify(config)};const transport={postMessage(raw){const m=JSON.parse(raw);m.testConfig=config;window.__nativeTest(JSON.stringify(m))}};globalThis.__runtime=KJRuntime.createRuntime(config,transport);globalThis.KJRuntime=KJRuntime;})();` });
}
