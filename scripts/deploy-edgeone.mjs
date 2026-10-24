import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvironment, inspectDeploymentTree, prepareEdgeOne, root, runNpm } from './prepare-edgeone.mjs';

export async function deployEdgeOne({ root: projectRoot = root, env = process.env, run = runNpm, prepare = prepareEdgeOne } = {}) {
  const token = env.EDGEONE_PAGES_API_TOKEN || env.EDGEONE_API_TOKEN;
  const name = env.EDGEONE_PROJECT_NAME;
  if (!token || !name) throw new Error('Set EDGEONE_PAGES_API_TOKEN and EDGEONE_PROJECT_NAME in the environment.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(name)) throw new Error('EDGEONE_PROJECT_NAME must contain letters, numbers and hyphens.');
  const clean = buildEnvironment(env);
  await prepare({ root: projectRoot, env: clean, run });
  const cli = ['exec', '--yes', '--package=edgeone@1.6.46', '--', 'edgeone', 'makers'];
  await run([...cli, 'build', '--ENV_STR', '{}'], { cwd: projectRoot, env: clean, capture: true });
  await run([...cli, 'generate-routes'], { cwd: projectRoot, env: clean, capture: true });
  await inspectDeploymentTree(resolve(projectRoot, '.edgeone'), { root: projectRoot, secrets: [token, env.CLOUDFLARE_API_TOKEN, env.KONGJING_POW_SECRET, env.POW_SECRET, env.IP_HASH_SALT].filter(Boolean) });
  const output = await run([...cli, 'deploy', './.edgeone', '--name', name, '--area', 'overseas', '--skip-ai-gateway-sync', '--json'], { cwd: projectRoot, env: { ...clean, EDGEONE_PAGES_API_TOKEN: token }, capture: true });
  const result = output.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).findLast(value => value?.status === 'success' && value.url);
  if (!result || !/^https:\/\//.test(result.url)) throw new Error('EdgeOne did not return a successful deployment URL.');
  return { url: result.url };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployEdgeOne().then(result => console.log(`EdgeOne deployment finished: ${result.url}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
