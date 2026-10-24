import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDownloads, sha256, apkMetadata, zipEntry } from '../relay/scripts/publish-downloads.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const apkPath = resolve(root,'release/android/kongjing-browser-1.4.1.apk');
const zipPath = resolve(root,'release/store/kongjing-2.1.0-store.zip');
const apk = await readFile(apkPath), zip = await readFile(zipPath);
const manifest = JSON.parse(zipEntry(zip,'manifest.json'));
if (apkMetadata(apk).version !== '1.4.1' || manifest.version !== '2.1.0' || manifest.key || manifest.content_scripts) throw Error('Unexpected release metadata');
for (const module of ['relay','edge']) await prepareDownloads({apkPath,zipPath,publicDir:resolve(root,module,'public')});
for (const [path,bytes] of [[apkPath,apk],[zipPath,zip]]) await writeFile(path+'.sha256',`${sha256(bytes)}  ${path.split(/[\\/]/).pop()}\n`);
await mkdir(resolve(root,'release/store'),{recursive:true});
await copyFile(resolve(root,'docs/STORE.md'),resolve(root,'release/store/STORE.md'));
await writeFile(resolve(root,'release/SHA256SUMS'),`${sha256(zip)}  kongjing-2.1.0-store.zip\n${sha256(apk)}  kongjing-browser-1.4.1.apk\n`);
for (const module of ['relay','edge']) await writeFile(resolve(root,module,'public/download/index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>空境下载</title><a href="/download/extension">Chrome Web Store 上传包 2.1.0</a> · <a href="/download/android">Android 1.4.1</a> · <a href="/">官网与部署</a></html>');
console.log('Current store ZIP and Android APK published with byte-derived metadata and SHA-256.');
