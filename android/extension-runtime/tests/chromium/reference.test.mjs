import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { TestBridge, init, ID } from '../bridge.mjs';

test('reference Chromium extension agrees on storage, callback lastError and async sendResponse', async () => {
  const root = resolve('test-results/reference-extension'); await mkdir(root, { recursive: true });
  await writeFile(root + '/manifest.json', JSON.stringify({ manifest_version: 3, name: 'Kongjing API oracle', version: '1.0', permissions: ['storage', 'tabs', 'scripting'], background: { service_worker: 'worker.js' } }));
  await writeFile(root + '/worker.js', `chrome.runtime.onMessage.addListener((m,s,r)=>{if(m.async){setTimeout(()=>r({echo:m.value}),5);return true;}});`);
  await writeFile(root + '/page.html', '<!doctype html><title>API oracle</title>');
  const native = await chromium.launchPersistentContext('', { channel: 'msedge', headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  try {
    const worker = native.serviceWorkers()[0] || await native.waitForEvent('serviceworker');
    const nativeId = new URL(worker.url()).hostname;
    const page = await native.newPage(); await page.goto(`chrome-extension://${nativeId}/page.html`);
    const scenario = async () => {
      const c = globalThis.__runtime?.chrome || chrome;
      const events = []; c.storage.onChanged.addListener((change, area) => events.push({ change, area }));
      await c.storage.local.clear(); events.length = 0;
      const setResult = await c.storage.local.set({ x: 7 });
      const defaults = await c.storage.local.get({ x: 1, missing: 9 });
      const callback = await new Promise(resolve => c.storage.local.get('x', resolve));
      const response = await c.runtime.sendMessage({ async: true, value: 42 });
      await c.storage.local.remove('x');
      await new Promise(r => setTimeout(r, 20));
      return { undefinedResult: setResult === undefined, defaults, callback, response, events, noLastError: c.runtime.lastError === undefined };
    };
    const expected = await page.evaluate(scenario);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();await context.route('https://example.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture</title>'})); const bridge = new TestBridge(); await bridge.attach(context); await init(context, { id: ID, type: 'page', manifest: {} });
      const fake = await context.newPage(); await fake.goto('https://example.com');
      const bg = await context.newPage(); await bg.goto('https://example.com'); await bg.evaluate(() => __runtime.chrome.runtime.onMessage.addListener((m, s, r) => { setTimeout(() => r({ echo: m.value }), 5); return true; }));
      assert.deepEqual(await fake.evaluate(scenario), expected);
      await writeFile('test-results/chromium-reference.json', JSON.stringify({ version: browser.version(), nativeExtensionId: nativeId, result: expected, matched: true }, null, 2));
    } finally { await browser.close(); }
  } finally { await native.close(); }
});
