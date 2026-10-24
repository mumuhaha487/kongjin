import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { exportPublicSource } from '../scripts/public-source.mjs';
import { checkPublic, sanitizePrivateText, validatePrivateOrigins, MAX_ESCAPE_DEPTH } from '../scripts/check-public.mjs';

const origin = 'https://relay-private.example:8443', host = 'relay-private.example';
const variants = [origin, host, origin.toUpperCase(), String.raw`https:\/\/relay-private.example:8443`,
  String.raw`relay-private\.example`, String.raw`relay-private\\.example`, String.raw`relay-private\\\\.example`,
  String.raw`relay-private\u002eexample`, String.raw`relay-private\\u002eexample`, String.raw`relay-private\x2eexample`,
  [...host].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')];

async function fixture(t) {
  const parent = process.env.KONGJING_EXPORT_TEST_DIRECTORY || tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'public-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = async (name, value) => { const path = join(root, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value); };
  await file('package.json', '{"type":"module"}\n');
  return { root, file, target: join(root, 'new-parent/snapshot') };
}

test('CLI rejects a missing list before creating target or parents', async t => {
  const { root, target } = await fixture(t), env = { ...process.env };
  delete env.KONGJING_PRIVATE_ORIGINS;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/public-source.mjs', import.meta.url)), target], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit complete origin list required/);
  assert.deepEqual(await readdir(root), ['package.json']);
});

test('invalid lists fail without copying or creating directories, and never echo input', async t => {
  const { root, target } = await fixture(t);
  const invalid = ['', '  ', ',', origin + ',', ',' + origin, origin + ',  ,' + origin,
    'not-a-url', 'ftp://relay-private.example', 'https://user:password@relay-private.example', 'https://@relay-private.example',
    origin + '/path', origin + '?token=hidden', origin + '#hidden', 'https:\\relay-private.example',
    'https://relay-private.example.', 'https://relay-private%2eexample', [], [origin, ''], null, [42]];
  assert.throws(() => validatePrivateOrigins(undefined, { required: true }), /required/);
  for (const value of invalid) {
    await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins: value }), error => {
      assert.match(error.message, /KONGJING_PRIVATE_ORIGINS:/);
      assert.ok(!error.message.includes(host) && !error.message.includes('password'));
      return true;
    });
    assert.deepEqual(await readdir(root), ['package.json']);
  }
});

test('export sanitizes raw, case, slash, regex, nested and character-escaped private forms', async t => {
  const { root, file, target } = await fixture(t);
  await file('extension/scripts/fixture.mjs', variants.join('\n') + '\nhttps://public.example/v1\n');
  await file('android/test-state/private-evidence.txt', 'must stay outside export');
  const result = await exportPublicSource(target, { sourceRoot: root, privateOrigins: [origin] });
  assert.equal(result.files, 2);
  const output = await readFile(join(target, 'extension/scripts/fixture.mjs'), 'utf8');
  assert.ok(!/relay-private/i.test(output));
  assert.ok(output.includes('https://public.example/v1'));
  assert.ok(output.includes(String.raw`sync\\.example\\.com`));
  await assert.rejects(readFile(join(target, 'android/test-state/private-evidence.txt')), { code: 'ENOENT' });
  assert.equal(await checkPublic(target, { privateOrigins: [origin], requirePrivateOrigins: true }), true);
});

test('final scanner rejects each residual form with path/line/category only', async t => {
  const { root, file } = await fixture(t);
  for (const value of variants) {
    await file('payload.bin', 'public line\n' + value);
    await assert.rejects(checkPublic(root, { privateOrigins: [origin] }), error => {
      assert.match(error.message, /payload\.bin:2: private (origin|hostname)/);
      assert.ok(!/relay-private/i.test(error.message));
      return true;
    });
  }
  const utf16 = Buffer.from(host, 'utf16le');
  for (const bytes of [utf16, Buffer.from(utf16).swap16()]) {
    await file('payload.bin', bytes);
    await assert.rejects(checkPublic(root, { privateOrigins: [origin] }), /private hostname/);
  }
});

test('sanitizing escaped origins preserves executable regex and JSON behavior', () => {
  const source = String.raw`const url = "https://relay-private.example:8443";
    const pattern = /https:\/\/relay-private\.example:8443/;
    const encoded = /https\u003a\u002f\u002frelay-private\u002eexample\u003a8443/;
    pattern.test(url) && encoded.test(url);`;
  assert.equal(runInNewContext(source), true);
  assert.equal(runInNewContext(sanitizePrivateText(source, [origin])), true);
  const json = JSON.stringify({ url: origin, nested: String.raw`relay-private\\.example` });
  const sanitized = JSON.parse(sanitizePrivateText(json, [origin]));
  assert.equal(sanitized.url, 'https://sync.example.com');
  assert.equal(sanitized.nested, String.raw`sync\\.example\\.com`);
});

test('final scan is wired into export and removes failed binary/credential outputs', async t => {
  const { root, file, target } = await fixture(t);
  await file('extension/public/image.bin', Buffer.from(host));
  await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins: [origin] }), /private hostname/);
  assert.deepEqual(await readdir(join(root, 'new-parent')), []);
  await file('extension/public/image.bin', 'safe binary');
  const secret = 'fictional-credential-for-regression';
  await file('extension/public/config.txt', secret);
  await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins: [origin], secretValues: [secret] }), /private credential/);
  assert.deepEqual(await readdir(join(root, 'new-parent')), []);
  await file('extension/public/config.txt', 'ghp_' + '0'.repeat(24));
  await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins: [origin] }), /credential pattern/);
  assert.deepEqual(await readdir(join(root, 'new-parent')), []);
});

test('existing snapshot is never overwritten', async t => {
  const { root, file, target } = await fixture(t);
  await file('new-parent/snapshot/existing.txt', 'preserve');
  await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins: [origin] }), /must not already exist/);
  assert.equal(await readFile(join(target, 'existing.txt'), 'utf8'), 'preserve');
});

test('private host in a filename is rejected without disclosing it', async t => {
  const { root, file, target } = await fixture(t);
  await file('extension/public/' + host + '.txt', 'safe contents');
  await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins: [origin] }), error => {
    assert.match(error.message, /private hostname/);
    assert.ok(!error.message.includes(host));
    return true;
  });
  assert.deepEqual(await readdir(join(root, 'new-parent')), []);
});

test('strict final scan does not skip hidden build-state directories', async t => {
  const { root, file } = await fixture(t);
  await file('scripts/.wrangler/payload.bin', host);
  await assert.rejects(checkPublic(root, { privateOrigins: [origin], requirePrivateOrigins: true }), /private hostname/);
});

test('generic public check needs no private configuration; strict check requires it', async t => {
  const { root } = await fixture(t), env = { ...process.env };
  delete env.KONGJING_PRIVATE_ORIGINS;
  const script = fileURLToPath(new URL('../scripts/check-public.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [script, root], { env }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, root, '--require-private-origins'], { env }).status, 1);
  assert.equal(sanitizePrivateText('https://public.example', [origin]), 'https://public.example');
});

test('reviewer executable nested Unicode probe is rejected and its export is removed', async t => {
  const { root, file, target } = await fixture(t);
  const privateOrigins = ['https://review-private.example:8443'];
  // Exact fictional payload from the independent review's escape-reproduction.mjs.
  const source = String.raw`const endpointMatcher = new RegExp("review-private\u005cu002eexample");
endpointMatcher.test("review-private"+String.fromCharCode(46)+"example");`;
  assert.equal(runInNewContext(source), true);
  assert.equal(sanitizePrivateText(source, privateOrigins), source);
  await file('scripts/probe.mjs', source);
  await assert.rejects(checkPublic(root, { privateOrigins, requirePrivateOrigins: true }), /probe\.mjs:1: private hostname/);
  await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins }), /private hostname/);
  await assert.rejects(readFile(join(target, 'scripts/probe.mjs')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(root, 'new-parent')), []);
  assert.equal(await readFile(join(root, 'scripts/probe.mjs'), 'utf8'), source);
});

function layeredDot(depth) {
  let encoded = String.raw`\u002e`;
  for (let i = 1; i < depth; i++) encoded = encoded.replaceAll('\\', String.raw`\u005c`);
  return encoded;
}

test('nested hex and braced Unicode host forms fail final scanning and cleanup', async t => {
  const { root, file, target } = await fixture(t);
  for (const encoded of [String.raw`\x5cu002e`, String.raw`\u{5c}u{2e}`, layeredDot(MAX_ESCAPE_DEPTH)]) {
    await file('scripts/probe.mjs', 'review-private' + encoded + 'example');
    await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins: ['https://review-private.example'] }), /private hostname/);
    assert.deepEqual(await readdir(join(root, 'new-parent')), []);
  }
});

test('normalization reaches its bound explicitly and rejects unresolved deeper escapes', async t => {
  const { root, file, target } = await fixture(t);
  const options = { privateOrigins: [origin], requirePrivateOrigins: true };
  await file('scripts/probe.mjs', 'public' + layeredDot(MAX_ESCAPE_DEPTH) + 'example');
  assert.equal(await checkPublic(root, options), true);
  for (const depth of [MAX_ESCAPE_DEPTH + 1, MAX_ESCAPE_DEPTH + 8]) {
    await file('scripts/probe.mjs', 'public' + layeredDot(depth) + 'example');
    await assert.rejects(checkPublic(root, options), /escape normalization depth limit/);
    await assert.rejects(exportPublicSource(target, { ...options, sourceRoot: root }), /escape normalization depth limit/);
    assert.deepEqual(await readdir(join(root, 'new-parent')), []);
  }
  await file('scripts/probe.mjs', 'safe contents');
  await file('extension/public/public' + layeredDot(MAX_ESCAPE_DEPTH + 1) + 'example.txt', 'safe contents');
  await assert.rejects(exportPublicSource(target, { ...options, sourceRoot: root }), /\[private path\]:1: escape normalization depth limit/);
  assert.deepEqual(await readdir(join(root, 'new-parent')), []);
});

test('reviewer credential filename plus directory, pattern and encoded names reject without disclosure', async t => {
  // Exact fictional secret from credential-filename-probe.mjs; no real credentials.
  const secret = 'fictional-review-credential-123456789';
  const pattern = 'ghp_' + 'Q'.repeat(24);
  const names = [secret, String.raw`\u0066ictional-review-credential-123456789`,
    String.raw`\u005cu0066ictional-review-credential-123456789`, pattern, String.raw`\u0067hp_` + 'Q'.repeat(24)];
  for (const directory of [false, true]) {
    for (const name of names) {
      const { root, file, target } = await fixture(t);
      const filename = 'extension/public/' + name + (directory ? '/payload.txt' : '.txt');
      await file(filename, 'public contents');
      const options = { privateOrigins: ['https://review-private.example'], secretValues: [secret], requirePrivateOrigins: true };
      const rejectsPrivately = error => {
        assert.match(error.message, /\[private(?: path)?\]:1: (?:private credential|credential pattern)/);
        assert.ok(!error.message.includes(secret) && !error.message.includes(pattern) && !error.message.includes(name));
        return true;
      };
      await assert.rejects(checkPublic(root, options), rejectsPrivately);
      await assert.rejects(exportPublicSource(target, { ...options, sourceRoot: root }), rejectsPrivately);
      assert.deepEqual(await readdir(join(root, 'new-parent')), []);
    }
  }
});

test('raw dot-segment, encoded and whitespace origin variants fail before all output creation', async t => {
  const { root, target } = await fixture(t);
  const invalid = ['/a/..', '/.', '/a/../', '/%2e', '/%2e%2e', '/a/%2E%2E', '/%2f', '//',
    '/a/.. ', '/.\t', '/a/..\n', '/\r.', '/\t.', '/a/..\u0000'].map(suffix => origin + suffix);
  invalid.push(' ' + origin, origin + ' ', '\t' + origin, origin + '\n', origin + '/\t', origin.replace('https:', 'https:\n'));
  for (const value of invalid) {
    await assert.rejects(exportPublicSource(target, { sourceRoot: root, privateOrigins: [value] }), /invalid origin URL/);
    assert.deepEqual(await readdir(root), ['package.json']);
  }
  assert.deepEqual(validatePrivateOrigins([origin, origin + '/']), [origin]);
});
