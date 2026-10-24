import { readdir, readFile, mkdir, writeFile, lstat, rm } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPublic, validatePrivateOrigins, sanitizePrivateText, PublicValidationError } from './check-public.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
export async function exportPublicSource(target, { sourceRoot = defaultRoot, privateOrigins = process.env.KONGJING_PRIVATE_ORIGINS, secretValues = [] } = {}) {
  // Fail before discovery, directory creation or copying. Never infer an empty private list.
  const origins = validatePrivateOrigins(privateOrigins, { required: true });
  const root = resolve(sourceRoot), destination = resolve(target || resolve(root, '.codex-work/public-source'));
  const within = relative(root, destination);
  if (!within || within === '..' || within.startsWith('..\\') || within.startsWith('../') || isAbsolute(within)) throw new PublicValidationError('Snapshot must be a separate directory inside this workspace');
  for (let path = destination; ; path = dirname(path)) {
    const stat = await lstat(path).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (stat?.isSymbolicLink()) throw new PublicValidationError('Snapshot target: symbolic link');
    if (path === destination && stat) throw new PublicValidationError('Snapshot target: must not already exist');
    if (path === root) break;
  }
  const roots = ['extension/tests', 'extension/src', 'extension/public', 'extension/scripts', 'shared/protocol/src', 'shared/protocol/test',
    'relay/src', 'relay/local', 'relay/test', 'relay/public', 'edge/lib', 'edge/cloud-functions', 'edge/local', 'edge/test', 'edge/public',
    'android/app/src', 'android/extension-runtime/src', 'android/extension-runtime/tests', 'android/extension-runtime/scripts', 'android/gradle',
    'cloud-functions', '.github/workflows', 'scripts', 'tests', 'docs/brand'];
  const configs = ['README.md','LICENSE','SECURITY.md','.gitignore','package.json','package-lock.json','wrangler.jsonc','edgeone.json','.dev.vars.example',
    'docs/DEPLOYMENT.md','docs/STORE.md','docs/RELEASE.md','shared/protocol/READY.md',
    'android/gradlew','android/gradlew.bat','android/build.gradle.kts','android/settings.gradle.kts','android/gradle.properties','android/app/build.gradle.kts','android/app/proguard-rules.pro',
    'android/scripts/Use-Toolchain.ps1','android/scripts/Build-Release.ps1','android/scripts/Package-Release.ps1',
    'relay/scripts/publish-downloads.mjs','relay/wrangler.example.toml'];
  for (const module of ['extension','shared/protocol','relay','edge','android/extension-runtime']) {
    for (const entry of await readdir(resolve(root,module), {withFileTypes:true}).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e)))
      if (entry.isFile() && /^(?:package(?:-lock)?\.json|tsconfig.*\.json|eslint.*|vite.*\.ts|.*\.html)$/.test(entry.name)) configs.push(module+'/'+entry.name);
  }
  function sanitize(text) {
    return sanitizePrivateText(text.replaceAll(root, ''), origins);
  }
  const skipped = /(?:^|\/)(?:node_modules|test-results|artifacts|build|\.git)(?:\/|$)|\.(?:log|apk|aab|crx|zip|map|tsbuildinfo|pem|jks)$/i;
  let count = 0;
  async function copy(name) {
    if (name.startsWith('docs/brand/') && name !== 'docs/brand/kongjing-logo.svg' && name !== 'docs/brand/kongjing-logo-small.svg') return;
    if (name.startsWith('android/extension-runtime/fixtures/') || /extension\/tests\/\.[^/]+/.test(name) || name.startsWith('android/app/src/main/assets/home/') || name === 'android/app/src/main/assets/home' || skipped.test(name) || /(?:\/|^)(?:store-build-graph|webview87-build-graph|pack-store-result)\.json$/.test(name)) return;
    const path = resolve(root,name), stat = await lstat(path).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new PublicValidationError('Snapshot input:1: symbolic link');
    if (stat.isDirectory()) { for (const child of await readdir(path)) await copy(name+'/'+child); return; }
    if (name.startsWith('extension/tests/') && !/\.(?:test\.ts|test\.tsx|mjs)$/.test(name) && !name.startsWith('extension/tests/fixtures/')) return;
    const out = resolve(destination,name); await mkdir(dirname(out),{recursive:true});
    const bytes = await readFile(path);
    const textFile = /\.(?:ts|tsx|js|mjs|cjs|json|jsonc|md|html|css|svg|xml|txt|kts|properties|toml|ps1|yml|yaml)$/.test(name) || /(?:LICENSE|SECURITY|gitignore|gradlew|_redirects|_headers)$/.test(name);
    let output = textFile ? sanitize(bytes.toString('utf8')) : bytes;
    if (name.endsWith('/public/_redirects')) output = '/privacy /privacy.html 200\n/download/android https://kongjing.inc.re/download/kongjing-browser-1.4.2.apk 302\n/download/extension https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing.zip 302\n';
    if (/^(?:relay|edge)\/public\/download\/latest\.json$/.test(name)) {
      const latest = JSON.parse(String(output));
      latest.android.url = 'https://kongjing.inc.re/download/kongjing-browser-1.4.2.apk';
      latest.extension.url = 'https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing.zip';
      output = JSON.stringify(latest, null, 2) + '\n';
    }
    if (name === 'relay/package.json' || name === 'edge/package.json') {
      const pkg = JSON.parse(String(output));
      pkg.scripts = name.startsWith('relay') ? {test:'vitest run',local:'node local/server.mjs',deploy:'node ../scripts/deploy-cloudflare.mjs'} : {test:'node --test test/*.test.mjs',build:'node ../scripts/prepare-edgeone.mjs',deploy:'node ../scripts/deploy-edgeone.mjs'};
      output=JSON.stringify(pkg,null,2)+'\n';
    }
    await writeFile(out,output); count++;
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  try {
    for (const name of [...roots,...configs]) await copy(name);
    await checkPublic(destination, { privateOrigins: origins, secretValues, requirePrivateOrigins: true });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return { directory: destination, files: count };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await exportPublicSource(process.argv[2]);
    console.log(`Public snapshot checked: ${result.files} source/config files`);
  } catch (error) {
    console.error(error instanceof PublicValidationError ? error.message : 'Snapshot export failed: filesystem or content error');
    process.exitCode = 1;
  }
}
