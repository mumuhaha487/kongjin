import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkPublic(directory, { privateOrigins = (process.env.KONGJING_PRIVATE_ORIGINS || '').split(',').filter(Boolean), secretValues = [] } = {}) {
  const root = resolve(directory), issues = [];
  async function scan(path) {
    for (const entry of await readdir(path,{withFileTypes:true})) {
      if (['.git','node_modules','.wrangler','.edgeone'].includes(entry.name)) continue;
      const file = join(path,entry.name), name = relative(root,file);
      if (/^(?:\.secrets|keys|env\.txt|local\.properties|keystore\.properties|DEVICE\.lock)$/.test(entry.name) || /\.(?:pem|jks|keystore|p12|pfx|apk|crx)$/.test(entry.name) || /^\.env(?:\.|$)/.test(entry.name) && !entry.name.endsWith('.example')) issues.push(name+': private path');
      if (entry.isSymbolicLink()) { issues.push(name+': symbolic link'); continue; }
      if (entry.isDirectory()) { if (!['node_modules','.wrangler','.edgeone'].includes(entry.name)) await scan(file); continue; }
      const bytes = await readFile(file), text = bytes.toString('utf8');
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|cfat_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/.test(text)) issues.push(name+': credential pattern');
      for (const value of [...secretValues,...privateOrigins,...privateOrigins.map(v=>new URL(v).hostname)])
        if (value.length >= 8 && bytes.includes(Buffer.from(value))) issues.push(name+': private value');
    }
  }
  await scan(root);
  if (issues.length) throw Error('Public content validation failed:\n'+[...new Set(issues)].join('\n'));
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkPublic(process.argv[2] || '.'); console.log('Public source scan passed');
}
