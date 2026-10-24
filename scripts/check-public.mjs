import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export class PublicValidationError extends Error {}

// Optional for general public-tree checks; mandatory for exports from a private tree.
export function validatePrivateOrigins(value, { required = false } = {}) {
  const invalid = category => { throw new PublicValidationError(`KONGJING_PRIVATE_ORIGINS: ${category}`); };
  if (value === undefined) {
    if (required) invalid('explicit complete origin list required');
    return [];
  }
  const entries = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(entries) || !entries.length) invalid('empty or invalid origin list');
  const origins = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) invalid('empty origin entry');
    const origin = entry;
    // Check the original suffix before URL parsing can erase dot segments.
    if (!/^https?:\/\/[^/\\\s?#]+\/?$/i.test(origin) || /[\s\u0000-\u0020\u007f\\%?#@]/.test(origin)) invalid('invalid origin URL');
    let url;
    try { url = new URL(origin); } catch { invalid('invalid origin URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hostname.endsWith('.') ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid('invalid origin URL');
    origins.push(origin.replace(/\/$/, ''), url.origin);
  }
  return [...new Set(origins)];
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Match final bytes including regex/JS/JSON escaping (also nested escaping).
function valuePattern(value) {
  const source = [...value].map(char => {
    const literal = escapeRegex(char), hex = char.charCodeAt(0).toString(16);
    const encoded = `\\\\+(?:u${hex.padStart(4, '0')}|x${hex.padStart(2, '0')})`;
    const plain = '.:/-'.includes(char) ? `\\\\*${literal}` : literal;
    return `(?:${plain}|${encoded})`;
  }).join('');
  return new RegExp(source, 'gi');
}

export function privateMatchers(origins) {
  return [
    ...origins.map(value => ({ category: 'private origin', pattern: valuePattern(value) })),
    ...[...new Set(origins.map(value => new URL(value).hostname))].map(value => ({ category: 'private hostname', pattern: valuePattern(value) }))
  ];
}

export function sanitizePrivateText(text, origins) {
  for (const { category, pattern } of privateMatchers(origins)) {
    text = text.replace(pattern, match => {
      const dot = match.match(/\\+(?:\.|u002e|x2e)/i)?.[0] || '.';
      const host = ['sync', 'example', 'com'].join(dot);
      if (category === 'private hostname') return host;
      const slash = match.match(/\\+(?:\/|u002f|x2f)/i)?.[0] || '/';
      const colon = match.match(/\\+(?::|u003a|x3a)/i)?.[0] || ':';
      return 'https' + colon + slash + slash + host;
    });
  }
  return text;
}

export const MAX_ESCAPE_DEPTH = 16;
const credentialPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|cfat_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/g;

// Inspection only: do not rewrite program text whose layered interpretation is ambiguous.
// Every intermediate view is checked. Exhausting the bound is a rejection, never success.
function decodedViews(text) {
  const views = [text];
  function step(value) {
    let invalid = false;
    const next = value.replace(/\\+(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([\\./:\-]))/gi, (_, point, unicode, hex, punctuation) => {
      if (punctuation) return punctuation;
      const code = Number.parseInt(point ?? unicode ?? hex, 16);
      if (code > 0x10ffff) { invalid = true; return ''; }
      return String.fromCodePoint(code);
    });
    return { next, invalid };
  }
  for (let depth = 0; depth < MAX_ESCAPE_DEPTH; depth++) {
    const { next, invalid } = step(text);
    if (invalid) return { views, category: 'invalid character escape' };
    if (next === text) return { views };
    views.push(next);
    text = next;
  }
  const { next, invalid } = step(text);
  return { views, category: invalid ? 'invalid character escape' : next !== text ? 'escape normalization depth limit' : undefined };
}

export async function checkPublic(directory, {
  privateOrigins = process.env.KONGJING_PRIVATE_ORIGINS, secretValues = [], requirePrivateOrigins = false
} = {}) {
  const origins = validatePrivateOrigins(privateOrigins, { required: requirePrivateOrigins });
  const matchers = [
    ...privateMatchers(origins),
    { category: 'credential pattern', pattern: credentialPattern },
    ...secretValues.filter(value => typeof value === 'string' && value.length).map(value => ({ category: 'private credential', pattern: new RegExp(escapeRegex(value), 'g') }))
  ], root = resolve(directory), issues = [];
  function inspect(text) {
    const { views, category } = decodedViews(text), found = [];
    if (category) found.push({ line: 1, category });
    for (const view of views) {
      for (const { category, pattern } of matchers) {
        pattern.lastIndex = 0;
        for (const match of view.matchAll(pattern)) found.push({ line: view.slice(0, match.index).split('\n').length, category });
      }
    }
    return found;
  }
  const safePath = name => {
    // Encoded values and pattern-only credentials must also be hidden from diagnostics.
    return inspect(name).length ? '[private path]' : name;
  };
  const issue = (name, line, category) => issues.push(`${safePath(name)}:${line}: ${category}`);
  async function scan(path) {
    for (const entry of await readdir(path,{withFileTypes:true})) {
      if (!requirePrivateOrigins && ['.git','node_modules','.wrangler','.edgeone'].includes(entry.name)) continue;
      const file = join(path,entry.name), name = relative(root,file);
      const nameIssues = inspect(name);
      for (const { category } of nameIssues) issue(name, 1, category);
      if (nameIssues.length) continue;
      if (/^(?:\.secrets|keys|env\.txt|local\.properties|keystore\.properties|DEVICE\.lock|test-state)$/.test(entry.name) || /\.(?:pem|jks|keystore|p12|pfx|apk|crx)$/.test(entry.name) || /^\.env(?:\.|$)/.test(entry.name) && !entry.name.endsWith('.example')) issue(name, 1, 'private path');
      if (entry.isSymbolicLink()) { issue(name, 1, 'symbolic link'); continue; }
      if (entry.isDirectory()) { await scan(file); continue; }
      const bytes = await readFile(file);
      // Latin-1 preserves every byte; UTF-16 views catch non-UTF-8/binary remnants.
      const swapped = Buffer.from(bytes.subarray(0, bytes.length - bytes.length % 2));
      swapped.swap16();
      const views = [bytes.toString('latin1'), bytes.toString('utf8'), bytes.toString('utf16le'), swapped.toString('utf16le')];
      for (const text of views) {
        for (const { line, category } of inspect(text)) issue(name, line, category);
      }
    }
  }
  await scan(root);
  if (issues.length) throw new PublicValidationError('Public content validation failed:\n'+[...new Set(issues)].join('\n'));
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), requirePrivateOrigins = args.includes('--require-private-origins');
    await checkPublic(args.find(arg => !arg.startsWith('--')) || '.', { requirePrivateOrigins });
    console.log('Public source scan passed');
  } catch (error) {
    console.error(error instanceof PublicValidationError ? error.message : 'Public source scan failed: filesystem error');
    process.exitCode = 1;
  }
}
