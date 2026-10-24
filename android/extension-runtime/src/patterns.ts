export function glob(pattern: string, value: string): boolean {
  return new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(value);
}
export function matches(pattern: string, url: string, originOnly = false): boolean {
  try {
    const u = new URL(url);
    if (pattern === '<all_urls>') return ['http:', 'https:', 'ftp:'].includes(u.protocol);
    const p = /^(\*|https?|ftp|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!p) return false;
    const [, scheme, host, path] = p;
    return (u.protocol === scheme + ':' || scheme === '*' && ['http:', 'https:'].includes(u.protocol)) &&
      (host === '*' || host === u.hostname || host.startsWith('*.') && (u.hostname === host.slice(2) || u.hostname.endsWith('.' + host.slice(2)))) &&
      (originOnly || glob(path, u.pathname + u.search));
  } catch { return false; }
}
export function allowedPage(url: string): boolean {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && u.hostname !== 'appassets.androidplatform.net' && !u.hostname.endsWith('.ext.kongjing.invalid') && u.hostname !== 'chromewebstore.google.com' && !(u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')); } catch { return false; }
}
export function contentMatches(script: any, url: string, top: boolean, fallback?: string): boolean {
  if (!top && !script.all_frames) return false;
  let effective = url;
  if (script.match_origin_as_fallback && /^(about|data|blob|filesystem):/.test(url)) effective = fallback || '';
  else if (script.match_about_blank && /^about:(blank|srcdoc)/.test(url)) effective = fallback || '';
  if (!allowedPage(effective)) return false;
  return (script.matches || []).some((p: string) => matches(p, effective)) &&
    !(script.exclude_matches || []).some((p: string) => matches(p, effective)) &&
    (!(script.include_globs || []).length || script.include_globs.some((p: string) => glob(p, effective))) &&
    !(script.exclude_globs || []).some((p: string) => glob(p, effective));
}
