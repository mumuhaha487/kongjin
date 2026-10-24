import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { bundle } from './bridge.mjs';
const scope = vm.createContext({ console, URL, setTimeout, clearTimeout, queueMicrotask, structuredClone, DOMException, globalThis: undefined });
vm.runInContext('globalThis=this;' + bundle, scope);
const api = scope.KJRuntime;
test('patterns reject sibling domains, restricted schemes and Chrome store', () => {
  assert.equal(api.matches('https://*.example.com/path*', 'https://sub.example.com/path?q=1'), true);
  assert.equal(api.matches('https://*.example.com/*', 'https://example.com.evil/'), false);
  for (const url of ['file:///x', 'https://appassets.androidplatform.net/home/', 'https://chromewebstore.google.com/detail/a', 'https://chrome.google.com/webstore/detail/a']) assert.equal(api.allowedPage(url), false);
});
test('content all_frames, exclusions, about:blank and origin fallback', () => {
  const s = { matches: ['https://example.test/*'], exclude_matches: ['*://*/private*'] };
  assert.equal(api.contentMatches(s, 'https://example.test/a', false), false);
  assert.equal(api.contentMatches({ ...s, all_frames: true }, 'https://example.test/a', false), true);
  assert.equal(api.contentMatches(s, 'https://example.test/private', true), false);
  assert.equal(api.contentMatches({ ...s, match_about_blank: true, all_frames: true }, 'about:blank', false, 'https://example.test/x'), true);
  assert.equal(api.contentMatches({ ...s, match_origin_as_fallback: true, all_frames: true }, 'blob:https://example.test/id', false, 'https://example.test/'), true);
});
test('legacy parser rejects class static blocks for WebView91 without executing source', () => {
  assert.ok(api.syntaxCheck('class X { static { throw 1 } }', false, 91));
  assert.equal(api.syntaxCheck('throw new Error("must not run")', false, 150), null);
  assert.equal(api.syntaxCheck('export const answer = 42;', true, 150), null);
});
test('extension event snapshots listeners during dispatch', () => {
  const event = new api.ExtensionEvent(); const log = [];
  const b = () => log.push('b'); event.addListener(() => { log.push('a'); event.removeListener(b); }); event.addListener(b); event.emit(); event.emit();
  assert.deepEqual(log, ['a', 'b', 'a']);
});
