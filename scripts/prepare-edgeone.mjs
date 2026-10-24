import { spawn } from 'node:child_process';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

export function buildEnvironment(source = process.env) {
  const env = { ...source, CI: 'true', NPM_CONFIG_LOGS_MAX: '0' };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key)) delete env[key];
  return env;
}

export async function runNpm(args, { cwd = root, env = process.env, capture = false } = {}) {
  const candidates = [process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  let entry;
  for (const candidate of candidates) try { await access(candidate); entry = candidate; break; } catch { }
  if (!entry) throw new Error('Run this command through npm run so the npm CLI is available.');
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let output = '';
    if (capture) { child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; }); }
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(output) : reject(new Error(`npm command failed (exit ${code}).`)));
  });
}

export async function inspectDeploymentTree(directory, { root: projectRoot = root, secrets = [] } = {}) {
  const project = resolve(projectRoot), target = resolve(directory);
  const within = relative(project, target);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Deployment input must stay inside the project.');
  const physical = relative(await realpath(project), await realpath(target));
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) throw new Error('Deployment input resolves outside the project.');
  async function inspect(path) {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error('Deployment input must not contain symbolic links.');
    if (entry.isDirectory()) {
      for (const name of await readdir(path)) {
        if (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.secrets|env\.txt|credentials(?:\..*)?)$/i.test(name)) throw new Error('Private configuration found in deployment input.');
        await inspect(join(path, name));
      }
    } else if (secrets.length) {
      const contents = await readFile(path);
      if (secrets.some(secret => typeof secret === 'string' && secret.length >= 8 && contents.includes(Buffer.from(secret)))) throw new Error('A deployment credential was embedded in build output.');
    }
  }
  await inspect(target);
}

export async function prepareEdgeOne({ root: projectRoot = root, env = process.env, run = runNpm } = {}) {
  const required = ['edge/package.json', 'edge/package-lock.json', 'edge/public/index.html', 'edge/lib/router.mjs', 'edge/cloud-functions/v2/[[default]].js', 'cloud-functions/v2/[[default]].js'];
  for (const name of required) await access(resolve(projectRoot, name));
  for (const directory of ['edge/public', 'edge/lib', 'edge/cloud-functions', 'cloud-functions']) await inspectDeploymentTree(resolve(projectRoot, directory), { root: projectRoot });
  await run(['ci', '--prefix', 'edge', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: projectRoot, env: buildEnvironment(env) });
  return resolve(projectRoot, 'edge/public');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareEdgeOne().then(() => console.log('EdgeOne source and production dependencies are ready.')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
