import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './prepare-edgeone.mjs';

export function runWrangler(args, { cwd = root, env = process.env, input } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(cwd, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd, env, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult() : reject(new Error(`Wrangler command failed (exit ${code}).`)));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

export async function deployCloudflare({ root: projectRoot = root, env = process.env, run = runWrangler, fetch: request = globalThis.fetch, generateSecret = () => randomBytes(32).toString('base64url') } = {}) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.');
  const configFile = resolve(projectRoot, 'wrangler.jsonc');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}`;
  async function api(path, { method = 'GET', body, allowMissing = false } = {}) {
    const response = await request(base + path, { method, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (allowMissing && response.status === 404) return null;
    const result = await response.json();
    if (!response.ok || result.success === false) throw new Error(`Cloudflare API request failed (${response.status}). Check token permissions and account access.`);
    return result.result;
  }
  for (const bucket of config.r2_buckets ?? []) {
    if (await api(`/r2/buckets/${encodeURIComponent(bucket.bucket_name)}`, { allowMissing: true }) === null) await api('/r2/buckets', { method: 'POST', body: { name: bucket.bucket_name } });
  }
  await run(['deploy', '--config', configFile, '--keep-vars'], { cwd: projectRoot, env: { ...env, WRANGLER_SEND_METRICS: 'false' } });
  const secrets = await api(`/workers/scripts/${encodeURIComponent(config.name)}/secrets`);
  if (!Array.isArray(secrets)) throw new Error('Cloudflare returned an invalid secret list.');
  const existing = new Set(secrets.map(secret => secret.name));
  for (const name of ['POW_SECRET', 'IP_HASH_SALT']) if (!existing.has(name)) {
    const value = env[name] || generateSecret();
    if (typeof value !== 'string' || value.length < 32 || /[\r\n]/.test(value)) throw new Error(`${name} must contain at least 32 characters without newlines.`);
    await run(['secret', 'put', name, '--config', configFile], { cwd: projectRoot, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, input: value + '\n' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployCloudflare().then(() => console.log('Cloudflare deployment finished; existing runtime secrets were retained.')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
