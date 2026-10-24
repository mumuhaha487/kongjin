import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDownloads, sha256, apkMetadata, zipEntry } from '../relay/scripts/publish-downloads.mjs';
import { checkRelease } from './check-release.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const args = process.argv.slice(2);
let downloadsOnly = false, source;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--downloads-only') downloadsOnly = true;
  else if (args[i] === '--source-directory' && args[i + 1]) source = resolve(args[++i]);
  else throw Error('Unknown or incomplete release option: ' + args[i]);
}
source ||= existsSync(resolve(root, '.codex-work/public-source/.git')) ? resolve(root, '.codex-work/public-source') : root;
const output = resolve(root, 'release');
const apkPath = resolve(root, 'android/app/build/outputs/apk/release/app-release.apk');
const zipPath = resolve(output, 'kongjing.zip');
const apk = await readFile(apkPath), zip = await readFile(zipPath);
const manifest = JSON.parse(zipEntry(zip,'manifest.json'));
if (apkMetadata(apk).version !== '1.4.1' || manifest.version !== '2.1.0' || manifest.key || manifest.content_scripts) throw Error('Unexpected release metadata');
for (const module of ['relay','edge']) await prepareDownloads({apkPath,zipPath,publicDir:resolve(root,module,'public')});
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'android.url'), '[InternetShortcut]\r\nURL=https://kongjing.inc.re/download/android\r\n', 'ascii');
for (const module of ['relay', 'edge']) await writeFile(resolve(root, module, 'public/download/index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>空境下载</title><a href="https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing.crx">插件 CRX</a> · <a href="/download/extension">商店上传 ZIP 2.1.0</a> · <a href="/download/android">Android APK 1.4.1</a> · <a href="https://github.com/mumuhaha487/kongjin/releases/latest/download/source.zip">源代码</a> · <a href="/">官网与部署</a></html>\n');
console.log(JSON.stringify({ android: { version: '1.4.1', sha256: sha256(apk), url: 'https://kongjing.inc.re/download/android' }, extension: { version: manifest.version, sha256: sha256(zip) } }, null, 2));
if (!downloadsOnly) {
  const git = (...parameters) => execFileSync('git', ['-C', source, ...parameters], { maxBuffer: 64 * 1024 * 1024 });
  if (git('status', '--porcelain', '--untracked-files=normal').toString().trim()) throw Error('Commit the reviewed public source before creating source.zip');
  const commit = git('rev-parse', 'HEAD').toString().trim();
  await writeFile(resolve(output, 'source.zip'), git('archive', '--format=zip', 'HEAD'));
  console.log('Source commit: ' + commit);
  await checkRelease(root, { allowExtra: true });
  console.log('Four release products verified. Run scripts/clean-releases.ps1 -Apply to remove obsolete output.');
}
