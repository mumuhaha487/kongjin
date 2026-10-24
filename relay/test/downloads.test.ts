import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { prepareDownloads, apkMetadata, zipEntry, sha256 } from '../scripts/publish-downloads.mjs';

const relay = fileURLToPath(new URL('../', import.meta.url));
const begin = '<!-- BEGIN KONGJING DOWNLOADS -->', end = '<!-- END KONGJING DOWNLOADS -->';
const manifest = { manifest_version: 3, name: 'Fixture store package', version: '4.5.6', background: { service_worker: 'background.js', type: 'module' }, permissions: ['storage'] };

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Complete ZIP records, including CRC, central directory and EOCD. No release
 * archives, zip executables, Android SDK or third-party fixture libraries. */
function archive(entries: Record<string, Buffer | string>, compressed = false) {
  const locals: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const [path, content] of Object.entries(entries)) {
    const name = Buffer.from(path), plain = Buffer.from(content), data = compressed ? deflateRawSync(plain) : plain, crc = crc32(plain), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(compressed ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(plain.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

type AndroidOptions = { version?: string; versionCode?: number; minSdk?: number; packageName?: string; utf8?: boolean };
/** Minimal Android AXML: string pool, resource IDs, namespace and balanced
 * manifest/uses-sdk elements, with typed integer and string attributes. */
function androidManifest({ version = '7.8.9', versionCode = 789, minSdk = 26, packageName = 're.inc.kongjing.browser', utf8 = true }: AndroidOptions = {}) {
  const strings = ['manifest', 'package', packageName, 'versionCode', 'versionName', version, 'uses-sdk', 'minSdkVersion', 'android', 'http://schemas.android.com/apk/res/android'];
  const chunks: Buffer[] = [], offsets: number[] = [], encoded: Buffer[] = []; let stringBytes = 0;
  for (const text of strings) {
    const data = Buffer.from(text, utf8 ? 'utf8' : 'utf16le'), length = Buffer.alloc(2);
    if (utf8) { length[0] = text.length; length[1] = data.length; } else length.writeUInt16LE(text.length);
    const entry = Buffer.concat([length, data, Buffer.alloc(utf8 ? 1 : 2)]); offsets.push(stringBytes); encoded.push(entry); stringBytes += entry.length;
  }
  const pool = Buffer.alloc(28 + strings.length * 4 + ((stringBytes + 3) & ~3)); pool.writeUInt16LE(1); pool.writeUInt16LE(28, 2); pool.writeUInt32LE(pool.length, 4); pool.writeUInt32LE(strings.length, 8); pool.writeUInt32LE(utf8 ? 256 : 0, 16); pool.writeUInt32LE(28 + strings.length * 4, 20);
  offsets.forEach((offset, index) => pool.writeUInt32LE(offset, 28 + index * 4)); Buffer.concat(encoded).copy(pool, 28 + strings.length * 4); chunks.push(pool);
  const resources = Buffer.alloc(8 + strings.length * 4); resources.writeUInt16LE(0x0180); resources.writeUInt16LE(8, 2); resources.writeUInt32LE(resources.length, 4); resources.writeUInt32LE(0x0101021b, 8 + 3 * 4); resources.writeUInt32LE(0x0101021c, 8 + 4 * 4); resources.writeUInt32LE(0x0101020c, 8 + 7 * 4); chunks.push(resources);
  const node = (type: number, size: number) => { const data = Buffer.alloc(size); data.writeUInt16LE(type); data.writeUInt16LE(16, 2); data.writeUInt32LE(size, 4); data.writeUInt32LE(1, 8); data.writeUInt32LE(0xffffffff, 12); return data; };
  const namespace = (type: number) => { const data = node(type, 24); data.writeUInt32LE(8, 16); data.writeUInt32LE(9, 20); return data; };
  type Attribute = [name: number, value: number, string: boolean, android: boolean];
  const start = (name: number, attrs: Attribute[]) => {
    const data = node(0x0102, 36 + attrs.length * 20); data.writeUInt32LE(0xffffffff, 16); data.writeUInt32LE(name, 20); data.writeUInt16LE(20, 24); data.writeUInt16LE(20, 26); data.writeUInt16LE(attrs.length, 28);
    attrs.forEach(([name, value, string, android], index) => { const at = 36 + index * 20; data.writeUInt32LE(android ? 9 : 0xffffffff, at); data.writeUInt32LE(name, at + 4); data.writeUInt32LE(string ? value : 0xffffffff, at + 8); data.writeUInt16LE(8, at + 12); data[at + 15] = string ? 3 : 0x10; data.writeUInt32LE(value, at + 16); }); return data;
  };
  const close = (name: number) => { const data = node(0x0103, 24); data.writeUInt32LE(0xffffffff, 16); data.writeUInt32LE(name, 20); return data; };
  chunks.push(namespace(0x0100), start(0, [[1, 2, true, false], [3, versionCode, false, true], [4, 5, true, true]]), start(6, [[7, minSdk, false, true]]), close(6), close(0), namespace(0x0101));
  const header = Buffer.alloc(8); header.writeUInt16LE(3); header.writeUInt16LE(8, 2); header.writeUInt32LE(8 + chunks.reduce((n, c) => n + c.length, 0), 4); return Buffer.concat([header, ...chunks]);
}

function apk(options: AndroidOptions = {}) { return archive({ 'AndroidManifest.xml': androidManifest(options) }, true); }
function extension(overrides: Record<string, unknown> = {}) { return archive({ 'manifest.json': JSON.stringify({ ...manifest, ...overrides }), 'background.js': 'export {};\n' }, true); }
async function snapshot(directory: string, prefix = ''): Promise<Array<{ name: string; bytes: string }>> {
  const result: Array<{ name: string; bytes: string }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await snapshot(path, name + '/')); else result.push({ name, bytes: (await readFile(path)).toString('base64') });
  }
  return result;
}
async function fixture() {
  const dataRoot = resolve(relay, '.data'); await mkdir(dataRoot, { recursive: true });
  const root = await mkdtemp(join(dataRoot, 'download-publish-')), publicDir = join(root, 'public'), apkPath = join(root, 'input.apk'), zipPath = join(root, 'input.zip'), apkBytes = apk(), zipBytes = extension();
  const html = `<!doctype html><html><head><title>Retained title</title></head><body><main>Retained introduction</main>\n${begin}\nreplace this old block\n${end}\n<footer>Retained footer</footer></body></html>\n`;
  await mkdir(join(publicDir, 'download'), { recursive: true });
  await Promise.all([writeFile(apkPath, apkBytes), writeFile(zipPath, zipBytes), writeFile(join(publicDir, 'index.html'), html), writeFile(join(publicDir, 'download/kongjing-0.0.1-store.zip'), 'retained-old-release'), writeFile(join(publicDir, '_headers'), '/custom\n  X-Test: retained\n'), writeFile(join(publicDir, '_redirects'), '/old /custom 302\n')]);
  return { publicDir, apkPath, zipPath, apkBytes, zipBytes, html, options: { apkPath, zipPath, publicDir, expectedApkSha256: sha256(apkBytes), expectedZipSha256: sha256(zipBytes) }, async dispose() { if (!resolve(root).startsWith(dataRoot + sep)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); } };
}

it.each([true, false])('reads Android binary string pools and typed metadata from generated APK bytes (UTF-8=%s)', utf8 => {
  expect(apkMetadata(apk({ utf8 }))).toEqual({ version: '7.8.9', versionCode: 789, minAndroid: '8.0' });
  expect(apkMetadata(apk({ utf8, version: '9.10.11', versionCode: 91011 }))).toEqual({ version: '9.10.11', versionCode: 91011, minAndroid: '8.0' });
});

it('reads stored and deflated ZIP entries and rejects missing/corrupt metadata', () => {
  for (const compressed of [false, true]) expect(JSON.parse(zipEntry(archive({ 'manifest.json': JSON.stringify(manifest) }, compressed), 'manifest.json').toString())).toEqual(manifest);
  expect(() => zipEntry(archive({ 'other.txt': 'missing' }), 'manifest.json')).toThrow('Missing archive entry');
  expect(() => apkMetadata(archive({ 'AndroidManifest.xml': '<manifest />' }))).toThrow('Expected Android binary manifest');
  expect(() => apkMetadata(apk({ packageName: 'com.example.other' }))).toThrow('Expected Kongjing APK');
  expect(() => apkMetadata(apk({ minSdk: 25 }))).toThrow('minSdk 26');
  expect(() => apkMetadata(apk({ versionCode: 0 }))).toThrow('Invalid APK versionCode');
  const corrupt = androidManifest(); corrupt.writeUInt32LE(corrupt.length + 1, 12); expect(() => apkMetadata(archive({ 'AndroidManifest.xml': corrupt }))).toThrow('Invalid Android manifest chunk');
});

it.each(['APK', 'ZIP'])('refuses a mismatched %s hash before changing any published bytes', async kind => {
  const f = await fixture(); try {
    const before = await snapshot(f.publicDir);
    await expect(prepareDownloads({ ...f.options, [kind === 'APK' ? 'expectedApkSha256' : 'expectedZipSha256']: '0'.repeat(64) })).rejects.toThrow(kind + ' SHA-256 mismatch');
    expect(await snapshot(f.publicDir)).toEqual(before);
  } finally { await f.dispose(); }
});

it.each([{ key: 'development-public-key' }, { content_scripts: [{ matches: ['https://example.com/*'], js: ['injected.js'] }] }, { permissions: ['storage', 'scripting'] }])('rejects a non-store extension profile before publishing (%j)', async forbidden => {
  const f = await fixture(); try { await writeFile(f.zipPath, extension(forbidden)); const before = await snapshot(f.publicDir); await expect(prepareDownloads({ apkPath: f.apkPath, zipPath: f.zipPath, publicDir: f.publicDir })).rejects.toThrow('Only store extension packages'); expect(await snapshot(f.publicDir)).toEqual(before); } finally { await f.dispose(); }
});

it('refuses invalid release metadata or missing website markers before mutation', async () => {
  const f = await fixture(); try {
    for (const invalid of [{ manifest_version: 2 }, { version: 'development' }]) { await writeFile(f.zipPath, extension(invalid)); const before = await snapshot(f.publicDir); await expect(prepareDownloads({ apkPath: f.apkPath, zipPath: f.zipPath, publicDir: f.publicDir })).rejects.toThrow('Invalid release version'); expect(await snapshot(f.publicDir)).toEqual(before); }
    await writeFile(f.zipPath, f.zipBytes); await writeFile(join(f.publicDir, 'index.html'), '<html>No download markers</html>'); const before = await snapshot(f.publicDir); await expect(prepareDownloads({ apkPath: f.apkPath, zipPath: f.zipPath, publicDir: f.publicDir })).rejects.toThrow('download markers missing'); expect(await snapshot(f.publicDir)).toEqual(before);
  } finally { await f.dispose(); }
});

it('publishes byte-exact store packages with derived metadata, stable aliases and headers, retaining website content and previous downloads', async () => {
  const f = await fixture(); try {
    const latest = await prepareDownloads({ ...f.options, expectedApkSha256: f.options.expectedApkSha256.toUpperCase(), expectedZipSha256: f.options.expectedZipSha256.toUpperCase() });
    expect(latest.android).toMatchObject({ version: '7.8.9', versionCode: 789, minAndroid: '8.0', size: f.apkBytes.length, sha256: sha256(f.apkBytes) });
    expect(latest.extension).toMatchObject({ version: manifest.version, size: f.zipBytes.length, sha256: sha256(f.zipBytes) });
    const apkName = `kongjing-browser-${latest.android.version}.apk`, zipName = `kongjing-${latest.extension.version}-store.zip`;
    expect(new URL(latest.android.url).pathname).toBe('/download/' + apkName); expect(new URL(latest.extension.url).pathname).toBe('/download/' + zipName);
    expect(await readFile(join(f.publicDir, 'download', apkName))).toEqual(f.apkBytes); expect(await readFile(join(f.publicDir, 'download', zipName))).toEqual(f.zipBytes);
    expect(JSON.parse(await readFile(join(f.publicDir, 'download/latest.json'), 'utf8'))).toEqual(latest);
    expect(await readFile(join(f.publicDir, 'download/kongjing-0.0.1-store.zip'), 'utf8')).toBe('retained-old-release');
    const html = await readFile(join(f.publicDir, 'index.html'), 'utf8'), headers = await readFile(join(f.publicDir, '_headers'), 'utf8'), redirects = await readFile(join(f.publicDir, '_redirects'), 'utf8');
    expect(html.split(begin)[0]).toBe(f.html.split(begin)[0]); expect(html.split(end)[1]).toBe(f.html.split(end)[1]); expect(html.split(begin)).toHaveLength(2); expect(html.split(end)).toHaveLength(2);
    expect(html).toContain('Chrome Web Store 上传包'); expect(html).toContain('下载安卓版'); expect(html).toContain('<details class="installation">'); expect(html).toContain('默认使用 Cloudflare'); expect(html).toContain('EO'); expect(html).toContain(latest.android.sha256); expect(html).toContain(latest.extension.sha256); expect(html).not.toMatch(/selfuse|自用|加载已解压|解压缩扩展|开发者模式|load unpacked/i);
    expect(headers).toContain('/custom\n  X-Test: retained'); expect(headers).toContain(`/download/${apkName}\n  Content-Type: application/vnd.android.package-archive\n  Content-Disposition: attachment; filename="${apkName}"\n  Cache-Control: public, max-age=3600`); expect(headers).toContain(`/download/${zipName}\n  Content-Type: application/zip\n  Content-Disposition: attachment; filename="${zipName}"`); expect(headers).toContain('/download/latest.json\n  Content-Type: application/json; charset=utf-8\n  Cache-Control: no-cache');
    expect(redirects).toContain('/old /custom 302'); expect(redirects).toContain(`/download/android /download/${apkName} 302`); expect(redirects).toContain(`/download/extension /download/${zipName} 302`); expect(redirects).not.toContain('-selfuse');
    const before = await snapshot(f.publicDir); expect(await prepareDownloads(f.options)).toEqual(latest); expect(await snapshot(f.publicDir)).toEqual(before);
  } finally { await f.dispose(); }
});
