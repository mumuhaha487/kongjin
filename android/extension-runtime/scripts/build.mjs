import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const target = new URL('../../app/src/main/assets/ext-runtime/', import.meta.url);
await mkdir(target, { recursive: true });
await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'iife', globalName: 'KJRuntime', target: 'chrome91', outfile: new URL('runtime.js', target).pathname.replace(/^\/([A-Za-z]:)/, '$1'), legalComments: 'none' });
await writeFile(new URL('version.json', target), JSON.stringify({ version: 1, target: 'chrome91', protocol: 1 }) + '\n');
