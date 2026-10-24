import { readdir, readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPublic } from './check-public.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(process.argv[2] || resolve(root, '.codex-work/public-source'));
if (destination === root || relative(root, destination).startsWith('..')) throw Error('Snapshot must be a separate directory inside this workspace');
const roots = ['extension/tests', 'extension/src', 'extension/public', 'extension/scripts', 'shared/protocol/src', 'shared/protocol/test',
  'relay/src', 'relay/local', 'relay/test', 'relay/public', 'edge/lib', 'edge/cloud-functions', 'edge/local', 'edge/test', 'edge/public',
  'android/app/src', 'android/extension-runtime/src', 'android/extension-runtime/tests', 'android/extension-runtime/scripts', 'android/gradle',
  'cloud-functions', '.github/workflows', 'scripts', 'tests', 'docs/brand'];
const configs = ['README.md','LICENSE','SECURITY.md','.gitignore','package.json','package-lock.json','wrangler.jsonc','edgeone.json','.dev.vars.example',
  'docs/DEPLOYMENT.md','docs/STORE.md','docs/RELEASE.md','shared/protocol/READY.md',
  'android/gradlew','android/gradlew.bat','android/build.gradle.kts','android/settings.gradle.kts','android/gradle.properties','android/app/build.gradle.kts','android/app/proguard-rules.pro',
  'android/scripts/Use-Toolchain.ps1','android/scripts/Build-Release.ps1','android/scripts/Package-Release.ps1',
  'relay/scripts/publish-downloads.mjs'];
for (const module of ['extension','shared/protocol','relay','edge','android/extension-runtime']) {
  for (const entry of await readdir(resolve(root,module), {withFileTypes:true}))
    if (entry.isFile() && /^(?:package(?:-lock)?\.json|tsconfig.*\.json|eslint.*|vite.*\.ts|.*\.html)$/.test(entry.name)) configs.push(module+'/'+entry.name);
}
const privateOrigins = (process.env.KONGJING_PRIVATE_ORIGINS || '').split(',').filter(Boolean);
function sanitize(text) {
  text = text.replaceAll(root, '');
  for (const origin of privateOrigins) {
    const host = new URL(origin).hostname;
    text = text.replaceAll(origin, 'https://sync.example.com').replaceAll(host.replaceAll('.', '\\.'), 'sync\\.example\\.com').replaceAll(host, 'sync.example.com');
  }
  return text;
}
const skipped = /(?:^|\/)(?:node_modules|test-results|artifacts|build|\.git)(?:\/|$)|\.(?:log|apk|aab|crx|zip|map|tsbuildinfo|pem|jks)$/i;
let count = 0;
async function copy(name) {
  if (name.startsWith('docs/brand/') && name !== 'docs/brand/kongjing-logo.svg' && name !== 'docs/brand/kongjing-logo-small.svg') return;
  if (name.startsWith('android/extension-runtime/fixtures/') || /extension\/tests\/\.[^/]+/.test(name) || name.startsWith('android/app/src/main/assets/home/') || name === 'android/app/src/main/assets/home' || skipped.test(name) || /(?:\/|^)(?:store-build-graph|webview87-build-graph|pack-store-result)\.json$/.test(name)) return;
  const path = resolve(root,name), stat = await lstat(path).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!stat) return;
  if (stat.isSymbolicLink()) throw Error('Snapshot input contains symbolic link: '+name);
  if (stat.isDirectory()) { for (const child of await readdir(path)) await copy(name+'/'+child); return; }
  if (name.startsWith('extension/tests/') && !/\.(?:test\.ts|test\.tsx|mjs)$/.test(name) && !name.startsWith('extension/tests/fixtures/')) return;
  const out = resolve(destination,name); await mkdir(dirname(out),{recursive:true});
  const bytes = await readFile(path);
  const textFile = /\.(?:ts|tsx|js|mjs|cjs|json|jsonc|md|html|css|svg|xml|txt|kts|properties|toml|ps1|yml|yaml)$/.test(name) || /(?:LICENSE|SECURITY|gitignore|gradlew|_redirects|_headers)$/.test(name);
  let output = textFile ? sanitize(bytes.toString('utf8')) : bytes;
  if (name.endsWith('/public/_redirects')) output = '/privacy /privacy.html 200\n/download/android https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing-browser-1.4.1.apk 302\n/download/extension https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing-2.1.0-store.zip 302\n';
  if (/^(?:relay|edge)\/public\/download\/latest\.json$/.test(name)) output = String(output).replaceAll(/https:\/\/[^"\s]+\/download\/(kongjing[^"\s]+)/g,'https://github.com/mumuhaha487/kongjin/releases/latest/download/$1');
  if (name === 'relay/package.json' || name === 'edge/package.json') {
    const pkg = JSON.parse(String(output));
    pkg.scripts = name.startsWith('relay') ? {test:'vitest run',local:'node local/server.mjs',deploy:'node ../scripts/deploy-cloudflare.mjs'} : {test:'node --test test/*.test.mjs',build:'node ../scripts/prepare-edgeone.mjs',deploy:'node ../scripts/deploy-edgeone.mjs'};
    output=JSON.stringify(pkg,null,2)+'\n';
  }
  await writeFile(out,output); count++;
}
await mkdir(destination,{recursive:true});
for (const name of [...roots,...configs]) await copy(name);
await checkPublic(destination,{privateOrigins});
console.log(`Public snapshot checked: ${count} source/config files in ${destination}`);
