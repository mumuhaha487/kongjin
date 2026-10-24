import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const relay = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://kongjing.inc.re';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Read metadata from the supplied release archives, never from a newer source checkout.
export function zipEntry(zip, name) {
  let end = zip.length - 22;
  const floor = Math.max(0, zip.length - 65557);
  while (end >= floor && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < floor) throw new Error('Invalid ZIP directory');
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const length = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    if (zip.subarray(at + 46, at + 46 + length).toString('utf8') === name) {
      const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), plainSize = zip.readUInt32LE(at + 24), offset = zip.readUInt32LE(at + 42);
      if ((zip.readUInt16LE(at + 8) & 1) || plainSize > 1048576) throw new Error('Unsupported metadata entry');
      if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid ZIP local entry');
      const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
      const data = zip.subarray(start, start + size);
      const plain = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: 1048576 }) : undefined;
      if (!plain || plain.length !== plainSize) throw new Error('Invalid compressed metadata');
      return plain;
    }
    at += 46 + length + extra + comment;
  }
  throw new Error('Missing archive entry: ' + name);
}

export function apkMetadata(apk) {
  const xml = zipEntry(apk, 'AndroidManifest.xml');
  if (xml.readUInt16LE(0) !== 3) throw new Error('Expected Android binary manifest');
  let strings = [], manifest, sdk;
  for (let at = xml.readUInt16LE(2); at < xml.length;) {
    const type = xml.readUInt16LE(at), header = xml.readUInt16LE(at + 2), size = xml.readUInt32LE(at + 4);
    if (size < header || size < 8 || at + size > xml.length) throw new Error('Invalid Android manifest chunk');
    if (type === 1) {
      const count = xml.readUInt32LE(at + 8), utf8 = (xml.readUInt32LE(at + 16) & 256) !== 0, base = at + xml.readUInt32LE(at + 20);
      strings = Array.from({ length: count }, (_, i) => {
        let p = base + xml.readUInt32LE(at + header + i * 4);
        const len8 = () => { const n = xml[p++]; return n & 128 ? ((n & 127) << 8) | xml[p++] : n; };
        const len16 = () => { const n = xml.readUInt16LE(p); p += 2; if (!(n & 32768)) return n; const next = xml.readUInt16LE(p); p += 2; return (n & 32767) * 65536 + next; };
        if (utf8) { len8(); const n = len8(); return xml.subarray(p, p + n).toString('utf8'); }
        const n = len16(); return xml.subarray(p, p + n * 2).toString('utf16le');
      });
    } else if (type === 0x0102) {
      const tag = strings[xml.readUInt32LE(at + 20)], attributes = {};
      const start = at + 16 + xml.readUInt16LE(at + 24), stride = xml.readUInt16LE(at + 26), count = xml.readUInt16LE(at + 28);
      if (stride < 20 || start + stride * count > at + size) throw new Error('Invalid manifest attributes');
      for (let i = 0; i < count; i++) {
        const p = start + i * stride, name = strings[xml.readUInt32LE(p + 4)], raw = xml.readUInt32LE(p + 8), value = xml.readUInt32LE(p + 16);
        attributes[name] = raw !== 0xffffffff ? strings[raw] : xml[p + 15] === 3 ? strings[value] : value;
      }
      if (tag === 'manifest') manifest = attributes;
      if (tag === 'uses-sdk') sdk = attributes;
    }
    at += size;
  }
  if (manifest?.package !== 're.inc.kongjing.browser' || Number(sdk?.minSdkVersion) !== 26)
    throw new Error('Expected Kongjing APK for Android 8.0 (minSdk 26)');
  const versionCode = Number(manifest.versionCode), version = manifest.versionName;
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) throw new Error('Invalid APK versionCode');
  return { version, versionCode, minAndroid: '8.0' };
}

const versionPattern = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
export const fileSize = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB';
export function renderDownloads(latest) {
  return `<div class="actions download-options">
    <div class="download-card"><a class="button" href="/download/extension">Chrome Web Store 上传包</a><p class="download-meta">${latest.extension.version} · ${fileSize(latest.extension.size)}</p></div>
    <div class="download-card"><a class="button primary" href="/download/android">下载安卓版</a><p class="download-meta">${latest.android.version} · ${fileSize(latest.android.size)} · Android 8.0 及以上</p></div>
  </div><details class="installation"><summary>安装与版本说明</summary><div class="install-copy">
    <p>电脑 ZIP 供开发者在 Chrome Web Store 更新现有扩展，沿用原商店项目。最终上架以谷歌审核结果为准。</p>
    <p>安卓 APK 可覆盖安装同签名旧版，保留本机数据；请勿先卸载或清除数据。</p>
    <p>两端均支持 Cloudflare 与 EO。默认使用 Cloudflare；在备案域名下自建 EO 可改善国内连接体验。所有配对设备需选择相同平台和地址。</p>
    <p>网络中断不影响本机书签，恢复后会重试。安卓扩展注入需要 WebView 支持安全文档起始脚本。</p>
    <p>APK SHA-256<code class="file-hash">${latest.android.sha256}</code></p>
    <p>商店 ZIP SHA-256<code class="file-hash">${latest.extension.sha256}</code></p>
  </div></details>`;
}

function managed(text, begin, end, body) {
  const a = text.indexOf(begin), b = text.indexOf(end);
  if (a < 0 && b < 0) return text.trimEnd() + (text.trim() ? '\n\n' : '') + begin + '\n' + body + '\n' + end + '\n';
  if (a < 0 || b < a) throw new Error('Invalid generated download block');
  return text.slice(0, a) + begin + '\n' + body + '\n' + end + text.slice(b + end.length);
}
async function optional(path) { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return ''; } }
async function atomic(path, data) { const temp = path + '.' + randomBytes(6).toString('hex') + '.tmp'; await writeFile(temp, data); await rename(temp, path); }

export async function prepareDownloads({ apkPath, zipPath, expectedApkSha256 = undefined, expectedZipSha256 = undefined, publicDir = resolve(relay, 'public') }) {
  const [apk, zip, html] = await Promise.all([readFile(apkPath), readFile(zipPath), readFile(resolve(publicDir, 'index.html'), 'utf8')]);
  for (const [name, bytes, expected] of [['APK', apk, expectedApkSha256], ['ZIP', zip, expectedZipSha256]]) {
    if (expected && sha256(bytes) !== expected.toLowerCase()) throw new Error(name + ' SHA-256 mismatch; nothing published');
    if (bytes.length > 25 * 1024 * 1024) throw new Error(name + ' exceeds Workers Static Assets 25 MiB limit');
  }
  const android = apkMetadata(apk), extension = JSON.parse(zipEntry(zip, 'manifest.json').toString('utf8'));
  if (extension.key || extension.content_scripts || extension.permissions?.includes('scripting')) throw new Error('Only store extension packages may be published');
  if (!versionPattern.test(android.version) || !versionPattern.test(extension.version) || extension.manifest_version !== 3) throw new Error('Invalid release version or extension manifest');
  const apkName = `kongjing-browser-${android.version}.apk`, zipName = `kongjing-${extension.version}-store.zip`;
  const latest = {
    android: { ...android, url: origin + '/download/' + apkName, size: apk.length, sha256: sha256(apk) },
    extension: { version: extension.version, url: origin + '/download/' + zipName, size: zip.length, sha256: sha256(zip) },
  };
  const begin = '<!-- BEGIN KONGJING DOWNLOADS -->', end = '<!-- END KONGJING DOWNLOADS -->';
  if (!html.includes(begin) || !html.includes(end)) throw new Error('Landing page download markers missing');
  const landing = managed(html, begin, end, '        ' + renderDownloads(latest));
  const directory = resolve(publicDir, 'download');
  const existing = await readdir(directory).catch(e => { if (e.code !== 'ENOENT') throw e; return []; });
  const files = [...new Set([...existing.filter(n => /\.(?:zip|apk)$/.test(n)), apkName, zipName])].sort();
  for (const name of files) if (!/^[\w.-]+\.(?:apk|zip)$/.test(name)) throw new Error('Unsafe download filename');
  const headers = files.map(name => `/download/${name}\n  Content-Type: ${name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/zip'}\n  Content-Disposition: attachment; filename="${name}"\n  Cache-Control: public, max-age=3600`).join('\n\n') + '\n\n/download/latest.json\n  Content-Type: application/json; charset=utf-8\n  Cache-Control: no-cache';
  const redirects = `/download/android /download/${apkName} 302\n/download/extension /download/${zipName} 302`;
  const [oldHeaders, oldRedirects] = await Promise.all([optional(resolve(publicDir, '_headers')), optional(resolve(publicDir, '_redirects'))]);
  const headerFile = managed(oldHeaders, '# BEGIN KONGJING DOWNLOADS', '# END KONGJING DOWNLOADS', headers);
  const redirectFile = managed(oldRedirects, '# BEGIN KONGJING DOWNLOADS', '# END KONGJING DOWNLOADS', redirects);
  // Validation is complete before any published file changes. Older packages remain untouched.
  await mkdir(directory, { recursive: true });
  await atomic(resolve(directory, apkName), apk);
  await atomic(resolve(directory, zipName), zip);
  await atomic(resolve(directory, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  await atomic(resolve(publicDir, '_headers'), headerFile);
  await atomic(resolve(publicDir, '_redirects'), redirectFile);
  await atomic(resolve(publicDir, 'index.html'), landing);
  return latest;
}

async function main() {
  const args = process.argv.slice(2), paths = [], flags = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prepare-only') flags.set(args[i], true);
    else if (['--expected-apk-sha256', '--expected-zip-sha256'].includes(args[i])) {
      const flag = args[i], value = args[++i];
      if (!/^[a-fA-F0-9]{64}$/.test(value ?? '')) throw new Error('Expected a SHA-256 value after ' + flag);
      flags.set(flag, value);
    }
    else if (args[i].startsWith('--')) throw new Error('Unknown option: ' + args[i]);
    else paths.push(args[i]);
  }
  if (paths.length !== 2) throw new Error('Usage: node scripts/publish-downloads.mjs <APK path> <ZIP path> [--prepare-only] [--expected-apk-sha256 HASH] [--expected-zip-sha256 HASH]');
  const latest = await prepareDownloads({ apkPath: resolve(paths[0]), zipPath: resolve(paths[1]), expectedApkSha256: flags.get('--expected-apk-sha256'), expectedZipSha256: flags.get('--expected-zip-sha256') });
  console.log(JSON.stringify(latest, null, 2));
  if (flags.has('--prepare-only')) return;
  const { cli } = await import('./cloud.mjs');
  const who = await cli(['whoami']);
  if (who.code !== 0 || !who.accountMatches) throw new Error('Predeployment whoami account mismatch or failure');
  console.log('whoami account matches credential: true');
  await import('./check-secrets.mjs');
  const deployed = await cli(['deploy']);
  await writeFile(resolve(relay, 'artifacts/publish-downloads-deploy.log'), deployed.output);
  console.log(deployed.output);
  if (deployed.code !== 0) throw new Error('Worker deploy failed');
  await writeFile(resolve(relay, 'DEPLOYED.txt'), origin + '\n');
  const versionId = /Current Version ID:\s*([\w-]+)/.exec(deployed.output)?.[1];
  const versions = await cli(['deployments', 'list', '--json']);
  if (versions.code !== 0) throw new Error('Deployed, but could not read kongjing-relay deployment ID');
  const plain = versions.output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const jsonStart = plain.search(/^\s*\[/m);
  if (jsonStart < 0) throw new Error('Deployed, but deployment history response is invalid');
  const history = JSON.parse(plain.slice(jsonStart));
  const deployment = history.find(d => d.versions?.some(v => v.version_id === versionId));
  if (!deployment) throw new Error('Deployed version missing from deployment history');
  const evidence = { timestamp: new Date().toISOString(), worker: 'kongjing-relay', origin, versionId, deploymentId: deployment.id, latest };
  await writeFile(resolve(relay, 'artifacts/publish-downloads-deployment.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('Deployment ID: ' + deployment.id);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
