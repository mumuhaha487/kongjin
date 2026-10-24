import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Compile the source in memory so these regressions never rely on generated assets.
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../../src/network.ts', import.meta.url))], bundle: true, format: 'iife', globalName: 'NetworkRuntime', target: 'chrome91', write: false });
let browser, server, base;
before(async () => {
  server = createServer((req, res) => res.end('<!doctype html><title>Network</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

async function harness() {
  const context = await browser.newContext();
  const page = await context.newPage(); await page.goto(base);
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.evaluate(() => {
    globalThis.calls = [];
    globalThis.nativeResponse = (url, extra = {}) => ({ status: 200, headers: {}, bodyBase64: btoa('native'), url, ...extra });
    globalThis.runtime = { config: { type: 'page', hosts: ['https://permitted.test/*'] }, async call(api, args) { calls.push({ api, args }); return nativeResponse(args[0]); } };
    NetworkRuntime.installNetwork(runtime);
  });
  return { context, page };
}

test('fetch preserves Request credentials, init overrides, origin and redirect modes', async () => {
  const { context, page } = await harness();
  try {
    const result = await page.evaluate(async () => {
      await fetch('https://permitted.test/default');
      await fetch(new Request('https://permitted.test/omit', { credentials: 'omit', redirect: 'error' }));
      await fetch(new Request('https://permitted.test/include', { credentials: 'omit' }), { credentials: 'include', redirect: 'manual' });
      return calls.map(({ api, args }) => ({ api, credentials: args[1].credentials, origin: args[1].initiatorOrigin, redirect: args[1].redirect }));
    });
    assert.deepEqual(result, [
      { api: 'network.fetch', credentials: 'same-origin', origin: base, redirect: 'follow' },
      { api: 'network.fetch', credentials: 'omit', origin: base, redirect: 'error' },
      { api: 'network.fetch', credentials: 'include', origin: base, redirect: 'manual' }
    ]);
  } finally { await context.close(); }
});

test('XHR sends same-origin by default and include only with withCredentials', async () => {
  const { context, page } = await harness();
  try {
    const credentials = await page.evaluate(async () => {
      for (const withCredentials of [false, true]) await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhr.open('GET', 'https://permitted.test/xhr');
        xhr.withCredentials = withCredentials; xhr.onload = resolve; xhr.onerror = reject; xhr.send();
      });
      return calls.map(call => call.args[1].credentials);
    });
    assert.deepEqual(credentials, ['same-origin', 'include']);
  } finally { await context.close(); }
});

test('fetch rejects an in-flight abort without waiting for native transport', async () => {
  const { context, page } = await harness();
  try {
    const result = await page.evaluate(async () => {
      let finish;
      runtime.call = (api, args) => { calls.push({ api, args }); return new Promise(resolve => { finish = () => resolve(nativeResponse(args[0])); }); };
      const controller = new AbortController();
      const pending = fetch('https://permitted.test/slow', { signal: controller.signal }).then(() => 'resolved', error => error.name);
      await Promise.resolve(); controller.abort();
      const outcome = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still pending'), 100))]);
      finish(); return outcome;
    });
    assert.equal(result, 'AbortError');
    assert.equal(await page.evaluate(async () => {
      const before = calls.length, controller = new AbortController(); controller.abort();
      try { await fetch('https://permitted.test/pre-aborted', { signal: controller.signal }); } catch (error) { return [error.name, calls.length === before]; }
    }).then(value => JSON.stringify(value)), JSON.stringify(['AbortError', true]));
  } finally { await context.close(); }
});

test('fetch reports followed redirects and keeps manual redirect responses opaque', async () => {
  const { context, page } = await harness();
  try {
    const result = await page.evaluate(async () => {
      runtime.call = async (api, [url, options]) => options.redirect === 'manual'
        ? nativeResponse(url, { status: 0, headers: {}, bodyBase64: '' })
        : nativeResponse('https://permitted.test/final', { redirected: true });
      const followed = await fetch('https://permitted.test/redirect');
      const manual = await fetch('https://permitted.test/redirect', { redirect: 'manual' });
      return { followed: [followed.url, followed.redirected], manual: [manual.status, manual.type, manual.url, await manual.text(), [...manual.headers]] };
    });
    assert.deepEqual(result, { followed: ['https://permitted.test/final', true], manual: [0, 'opaqueredirect', 'https://permitted.test/redirect', '', []] });
  } finally { await context.close(); }
});

test('XHR timeout completes at DONE and a later abort does not emit duplicate events', async () => {
  const { context, page } = await harness();
  try {
    const result = await page.evaluate(async () => {
      runtime.call = () => new Promise(() => {});
      const xhr = new XMLHttpRequest(), events = [];
      xhr.open('GET', 'https://permitted.test/timeout'); xhr.timeout = 20;
      for (const type of ['abort', 'timeout', 'error', 'load', 'loadend']) xhr.addEventListener(type, () => events.push([type, xhr.readyState, xhr.status]));
      await new Promise(resolve => { xhr.onloadend = resolve; xhr.send(); });
      xhr.abort(); await new Promise(resolve => setTimeout(resolve, 30));
      return { events, readyState: xhr.readyState };
    });
    assert.deepEqual(result, { events: [['timeout', 4, 0], ['loadend', 4, 0]], readyState: 0 });
  } finally { await context.close(); }
});

test('reopening an XHR ignores the previous native completion', async () => {
  const { context, page } = await harness();
  try {
    const result = await page.evaluate(async () => {
      const finishes = [];
      runtime.call = (api, [url]) => new Promise(resolve => finishes.push(() => resolve(nativeResponse(url, { bodyBase64: btoa(url.endsWith('/first') ? 'first' : 'second') }))));
      const xhr = new XMLHttpRequest(), loaded = [];
      xhr.onload = () => loaded.push(xhr.responseText);
      xhr.open('GET', 'https://permitted.test/first'); xhr.send(); await Promise.resolve();
      xhr.open('GET', 'https://permitted.test/second'); xhr.send(); await Promise.resolve();
      finishes[1](); await new Promise(resolve => setTimeout(resolve, 10));
      finishes[0](); await new Promise(resolve => setTimeout(resolve, 10));
      xhr.abort(); return { loaded, responseText: xhr.responseText, state: xhr.readyState };
    });
    assert.deepEqual(result, { loaded: ['second'], responseText: '', state: 0 });
  } finally { await context.close(); }
});

test('ungranted URLs and content scripts retain browser transport', async () => {
  const { context, page } = await harness();
  try {
    assert.equal(await page.evaluate(async () => { await fetch('/fallback'); return calls.length; }), 0);
    assert.equal(await page.evaluate(() => {
      const scope = { fetch() {}, XMLHttpRequest: class {} }, before = scope.fetch;
      NetworkRuntime.installNetwork({ config: { type: 'content' } }, scope);
      return scope.fetch === before;
    }), true);
  } finally { await context.close(); }
});
