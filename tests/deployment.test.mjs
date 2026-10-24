import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deployCloudflare } from '../scripts/deploy-cloudflare.mjs';
import { deployEdgeOne } from '../scripts/deploy-edgeone.mjs';
import { inspectDeploymentTree, prepareEdgeOne, root } from '../scripts/prepare-edgeone.mjs';

async function fixture(t) {
  const parent = resolve(root, 'node_modules/.deployment-tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function file(name, content = '') { const target = join(directory, name); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content); }
  await file('wrangler.jsonc', await readFile(new URL('../wrangler.jsonc', import.meta.url)));
  await file('package.json', '{"type":"module"}');
  await file('edge/package.json', '{"type":"module"}'); await file('edge/package-lock.json', '{}');
  await file('edge/public/index.html', '<!doctype html><title>Fixture</title>');
  await file('edge/lib/router.mjs', 'export const fixture = true;');
  await file('edge/cloud-functions/v2/[[default]].js', 'export function onRequest(){return new Response("routed")}');
  await file('cloud-functions/v2/[[default]].js', await readFile(new URL('../cloud-functions/v2/[[default]].js', import.meta.url)));
  return { directory, file };
}
const cloudEnv = { CLOUDFLARE_API_TOKEN: 'test-cloudflare-token', CLOUDFLARE_ACCOUNT_ID: 'test-account' };
const result = (value, status = 200) => new Response(JSON.stringify({ success: status < 400, result: value }), { status });

test('root configuration routes the current assets and functions without account or project identifiers', async () => {
  const cloud = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(cloud.main, 'relay/src/worker.mjs'); assert.equal(cloud.assets.directory, 'relay/public'); assert.equal(cloud.assets.binding, 'ASSETS'); assert.equal(cloud.assets.run_worker_first, true);
  assert.equal(cloud.workers_dev, true); assert.equal(cloud.account_id, undefined); assert.equal(cloud.routes, undefined);
  assert.deepEqual(cloud.durable_objects.bindings, [{ name: 'GROUPS', class_name: 'GroupRoom' }, { name: 'PAIRS', class_name: 'PairRoom' }, { name: 'GUARDS', class_name: 'Guard' }]);
  assert.deepEqual(cloud.migrations, [{ tag: 'v1', new_sqlite_classes: ['GroupRoom', 'PairRoom', 'Guard'] }]);
  assert.deepEqual(cloud.r2_buckets, [{ binding: 'BUCKET', bucket_name: 'kongjing-sync' }]);
  const edge = JSON.parse(await readFile(new URL('../edgeone.json', import.meta.url), 'utf8'));
  assert.equal(edge.outputDirectory, 'edge/public'); assert.equal(edge.name, undefined); assert.equal(edge.projectId, undefined);
  assert.deepEqual(edge.rewrites, [{ source: '/privacy', destination: '/privacy.html' }]);
  for (const [path, destination] of [['/download/android', 'https://kongjing.inc.re/download/kongjing-browser-1.4.1.apk'], ['/download/extension', 'https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing.zip']]) {
    const redirect = edge.redirects.find(rule => rule.source === path);
    assert.equal(redirect.statusCode, 302); assert.equal(redirect.destination, destination);
  }
});

test('root EdgeOne function wrapper executes the backend handler', async t => {
  const { directory } = await fixture(t);
  const { onRequest } = await import(pathToFileURL(join(directory, 'cloud-functions/v2/[[default]].js')).href);
  assert.equal(await onRequest().text(), 'routed');
});

test('Cloudflare redeployment preserves existing secrets and an existing R2 bucket', async t => {
  const { directory } = await fixture(t), commands = [], requests = [];
  await deployCloudflare({ root: directory, env: { ...cloudEnv, POW_SECRET: 'must-not-replace-existing' }, generateSecret() { throw new Error('Must not rotate existing secrets'); },
    async fetch(url, options) {
      requests.push([url, options]);
      return result(url.endsWith('/secrets') ? [{ name: 'POW_SECRET' }, { name: 'IP_HASH_SALT' }, { name: 'ANOTHER_SECRET' }] : { name: 'kongjing-sync' });
    }, async run(args, options) { commands.push([args, options]); }
  });
  assert.equal(commands.length, 1); assert.deepEqual(commands[0][0], ['deploy', '--config', join(directory, 'wrangler.jsonc'), '--keep-vars']);
  assert.equal(commands[0][1].env.CLOUDFLARE_API_TOKEN, cloudEnv.CLOUDFLARE_API_TOKEN);
  assert.equal(requests.length, 2); assert.ok(requests.every(([, options]) => options.method === 'GET'));
});

test('first Cloudflare deployment provisions storage and sends new secrets only on stdin', async t => {
  const { directory } = await fixture(t), commands = [], requests = [];
  let generated = 0;
  await deployCloudflare({ root: directory, env: cloudEnv, generateSecret: () => `${++generated}`.repeat(43),
    async fetch(url, options) {
      requests.push([url, options]);
      if (url.endsWith('/r2/buckets/kongjing-sync')) return result(null, 404);
      return result(url.endsWith('/secrets') ? [] : { name: 'kongjing-sync' });
    }, async run(args, options) { commands.push([args, options]); }
  });
  assert.equal(generated, 2); assert.equal(commands.length, 3);
  assert.equal(requests[1][1].method, 'POST'); assert.deepEqual(JSON.parse(requests[1][1].body), { name: 'kongjing-sync' });
  assert.deepEqual(commands.slice(1).map(([args]) => args.slice(0, 3)), [['secret', 'put', 'POW_SECRET'], ['secret', 'put', 'IP_HASH_SALT']]);
  for (const [args, options] of commands.slice(1)) { assert.equal(options.input.length, 44); assert.ok(options.input.endsWith('\n')); assert.ok(!args.some(arg => arg.includes(options.input.trim()))); }
});

test('Cloudflare changes only a missing secret and stops before deploying on API errors', async t => {
  const { directory } = await fixture(t), commands = [];
  await deployCloudflare({ root: directory, env: { ...cloudEnv, IP_HASH_SALT: 'provided-runtime-secret-with-32-characters' },
    async fetch(url) { return result(url.endsWith('/secrets') ? [{ name: 'POW_SECRET' }] : {}); },
    async run(args, options) { commands.push([args, options]); }
  });
  assert.equal(commands.length, 2); assert.equal(commands[1][0][2], 'IP_HASH_SALT'); assert.equal(commands[1][1].input, 'provided-runtime-secret-with-32-characters\n');
  await assert.rejects(deployCloudflare({ root: directory, env: cloudEnv, fetch: async () => result(null, 403), run() { assert.fail('Must stop before deployment'); } }), /403/);
  await assert.rejects(deployCloudflare({ root: directory, env: {}, run() { assert.fail('No credentials'); } }), /CLOUDFLARE_API_TOKEN/);
});

test('EdgeOne preparation installs only backend production dependencies without credentials', async t => {
  const { directory, file } = await fixture(t), commands = [];
  await file('.secrets/production.env', 'outside-deployment-tree');
  const output = await prepareEdgeOne({ root: directory, env: { PATH: 'keep', EDGEONE_PAGES_API_TOKEN: 'hidden', KONGJING_POW_SECRET: 'hidden', CLOUDFLARE_API_TOKEN: 'hidden' },
    async run(args, options) { commands.push([args, options]); }
  });
  assert.equal(output, join(directory, 'edge/public')); assert.equal(commands.length, 1);
  assert.deepEqual(commands[0][0], ['ci', '--prefix', 'edge', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(commands[0][1].cwd, directory); assert.equal(commands[0][1].env.PATH, 'keep'); assert.equal(commands[0][1].env.CI, 'true');
  assert.ok(!Object.keys(commands[0][1].env).some(name => /TOKEN|SECRET/.test(name)));
  assert.equal(await readFile(join(directory, 'edge/public/index.html'), 'utf8'), '<!doctype html><title>Fixture</title>');
});

test('private files inside deployment inputs stop EdgeOne preparation before installing or deploying', async t => {
  const { directory, file } = await fixture(t);
  await file('edge/public/.env.production', 'fake-private-value');
  await assert.rejects(prepareEdgeOne({ root: directory, run() { assert.fail('Unsafe input must stop before install'); } }), /Private configuration/);
  await assert.rejects(inspectDeploymentTree(resolve(directory, '..'), { root: directory }), /inside the project/);
});

test('EdgeOne builds without secrets and uploads only generated output with token in environment', async t => {
  const { directory, file } = await fixture(t), commands = [], prepared = [];
  await file('.edgeone/server.js', 'export const ready = true;');
  const token = 'test-edgeone-deployment-token';
  const deployed = await deployEdgeOne({ root: directory, env: { EDGEONE_PAGES_API_TOKEN: token, EDGEONE_PROJECT_NAME: 'my-kongjing', KONGJING_POW_SECRET: 'production-secret-value', CLOUDFLARE_API_TOKEN: 'unrelated-token' },
    async prepare(options) { prepared.push(options); },
    async run(args, options) { commands.push([args, options]); return args.includes('deploy') ? '{"status":"success","url":"https://fixture.edgeone.app"}' : ''; }
  });
  assert.deepEqual(deployed, { url: 'https://fixture.edgeone.app' }); assert.equal(prepared.length, 1); assert.equal(commands.length, 3);
  assert.ok(commands.slice(0, 2).every(([, options]) => !Object.keys(options.env).some(name => /TOKEN|SECRET/.test(name))));
  const [args, options] = commands[2]; assert.equal(args[args.indexOf('deploy') + 1], './.edgeone'); assert.equal(args[args.indexOf('--name') + 1], 'my-kongjing');
  assert.equal(options.env.EDGEONE_PAGES_API_TOKEN, token); assert.equal(options.env.KONGJING_POW_SECRET, undefined); assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.ok(commands.every(([args]) => args.every(arg => !arg.includes(token))));
});

test('EdgeOne rejects a credential embedded in generated output and requires successful deploy evidence', async t => {
  const { directory, file } = await fixture(t), token = 'test-edgeone-deployment-token', commands = [];
  await file('.edgeone/server.js', `export const leaked = '${token}';`);
  const options = { root: directory, env: { EDGEONE_PAGES_API_TOKEN: token, EDGEONE_PROJECT_NAME: 'test-kongjing' }, async prepare() {}, async run(args) { commands.push(args); return ''; } };
  await assert.rejects(deployEdgeOne(options), /embedded/); assert.equal(commands.length, 2);
  await file('.edgeone/server.js', 'export const ready = true;');
  await assert.rejects(deployEdgeOne(options), /successful deployment URL/);
});
