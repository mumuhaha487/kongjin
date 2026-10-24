import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../extension/package.json', import.meta.url));
const { unzipSync } = require('fflate');
const products = ['android.url', 'kongjing.crx', 'kongjing.zip', 'source.zip'];
function fields(bytes) {
  const result = new Map();
  let offset = 0;
  function varint() {
    let value = 0, shift = 0, byte;
    do {
      assert.ok(offset < bytes.length && shift <= 49, 'Invalid protobuf integer');
      byte = bytes[offset++]; value += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    return value;
  }
  while (offset < bytes.length) {
    const tag = varint(); assert.equal(tag & 7, 2, 'Unexpected protobuf wire type');
    const length = varint(); assert.ok(offset + length <= bytes.length, 'Truncated protobuf field');
    result.set(Math.floor(tag / 8), bytes.subarray(offset, offset + length)); offset += length;
  }
  return result;
}
function scanArchive(bytes, privateValues) {
  const entries = unzipSync(bytes);
  for (const [name, content] of Object.entries(entries)) {
    assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'), 'Unsafe archive path');
    assert.doesNotMatch(name, /(?:^|\/)(?:\.git|\.secrets|keys|node_modules|env\.txt|local\.properties|keystore\.properties|DEVICE\.lock)(?:\/|$)|\.(?:pem|jks|keystore|p12|pfx|apk|crx)$/i, 'Private or generated archive path: ' + name);
    const text = Buffer.from(content).toString('utf8');
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|cfat_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/, 'Credential in ' + name);
    for (const value of privateValues) assert.ok(!Buffer.from(content).includes(Buffer.from(value)), 'Private value in ' + name);
  }
  return entries;
}
export async function checkRelease(root, { allowExtra = false } = {}) {
  const output = resolve(root, 'release');
  if (!allowExtra) assert.deepEqual((await readdir(output)).sort(), products, 'Release must contain exactly four products');
  for (const name of products) assert.ok((await lstat(resolve(output, name))).isFile(), 'Product must be a regular file: ' + name);
  const origins = (process.env.KONGJING_PRIVATE_ORIGINS || '').split(',').filter(Boolean);
  const privateValues = [...origins, ...origins.map(value => new URL(value).hostname)];
  const zip = await readFile(resolve(output, 'kongjing.zip'));
  const entries = scanArchive(zip, privateValues);
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString());
  assert.equal(manifest.manifest_version, 3); assert.equal(manifest.key, undefined); assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.optional_permissions, ['scripting']);
  assert.ok(!manifest.permissions.some(permission => ['history', 'tabs', 'offscreen', 'scripting'].includes(permission)));
  const crx = await readFile(resolve(output, 'kongjing.crx'));
  assert.equal(crx.subarray(0, 4).toString(), 'Cr24'); assert.equal(crx.readUInt32LE(4), 3);
  const headerLength = crx.readUInt32LE(8); assert.ok(headerLength + 12 < crx.length);
  const header = fields(crx.subarray(12, 12 + headerLength)), signed = header.get(10000), proof = fields(header.get(2));
  const key = proof.get(1), signature = proof.get(2), id = createHash('sha256').update(key).digest().subarray(0, 16);
  assert.deepEqual(fields(signed).get(1), id);
  const payload = crx.subarray(12 + headerLength); assert.deepEqual(payload, zip, 'CRX must contain the exact store ZIP');
  const length = Buffer.alloc(4); length.writeUInt32LE(signed.length);
  assert.ok(verify('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signed, payload]), createPublicKey({ key, format: 'der', type: 'spki' }), signature), 'CRX signature is invalid');
  const extensionId = [...id.toString('hex')].map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join('');
  if (process.env.KONGJING_EXPECTED_EXTENSION_ID) assert.equal(extensionId, process.env.KONGJING_EXPECTED_EXTENSION_ID);
  assert.equal(await readFile(resolve(output, 'android.url'), 'ascii'), '[InternetShortcut]\r\nURL=https://kongjing.inc.re/download/android\r\n');
  const source = scanArchive(await readFile(resolve(output, 'source.zip')), privateValues);
  for (const name of ['README.md', 'LICENSE', 'extension/src/background/index.ts', 'android/app/build.gradle.kts', 'scripts/release.mjs']) assert.ok(source[name], 'Missing source: ' + name);
  console.log(JSON.stringify({ products, extensionVersion: manifest.version, crxExtensionId: extensionId, sourceFiles: Object.keys(source).length }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkRelease(fileURLToPath(new URL('../', import.meta.url)), { allowExtra: process.argv.includes('--allow-extra') });
