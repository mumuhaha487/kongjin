import {KongjingSync as CloudflareSync} from './sync.ts';
import {EdgeKongjingSync,type EdgeSyncOptions} from './sync-edge.ts';
export {CloudflareSync};
/** v3 default is EdgeOne; v2 is an explicit legacy choice. */
export function createSync<D>(options:EdgeSyncOptions<D>&{transport?:'edge'}):EdgeKongjingSync<D>;
export function createSync<D>(options:EdgeSyncOptions<D>&{transport:'cloudflare'}):CloudflareSync<D>;
export function createSync<D>(options:EdgeSyncOptions<D>&{transport?:'edge'|'cloudflare'}):EdgeKongjingSync<D>|CloudflareSync<D>;
export function createSync<D>(options:EdgeSyncOptions<D>&{transport?:'edge'|'cloudflare'}) {
  return options.transport==='cloudflare'?new CloudflareSync({...options,relayUrl:options.relayUrl??'https://kongjing.inc.re'}):new EdgeKongjingSync(options);
}
