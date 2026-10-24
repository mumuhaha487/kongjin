export function installCompatibility(g: any = globalThis): void {
  const define = (o: any, name: string, value: any) => { if (!o[name]) Object.defineProperty(o, name, { configurable: true, writable: true, value }); };
  const at = function(this: any, index: number) { const i = Math.trunc(Number(index)) || 0; return this[i < 0 ? this.length + i : i]; };
  define(Array.prototype, 'at', at); define(String.prototype, 'at', at);
  for (const type of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) define(type.prototype, 'at', at);
  define(Object, 'hasOwn', (o: any, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k));
  define(Array.prototype, 'findLast', function(this: any[], fn: any, arg: any) { for (let i = this.length - 1; i >= 0; i--) if (fn.call(arg, this[i], i, this)) return this[i]; });
  define(Array.prototype, 'findLastIndex', function(this: any[], fn: any, arg: any) { for (let i = this.length - 1; i >= 0; i--) if (fn.call(arg, this[i], i, this)) return i; return -1; });
  define(g, 'structuredClone', (value: any) => {
    const seen = new Map();
    const copy = (v: any): any => {
      if (typeof v === 'function' || typeof v === 'symbol' || (typeof Node !== 'undefined' && v instanceof Node)) throw new DOMException('Value could not be cloned', 'DataCloneError');
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return seen.get(v);
      if (v instanceof Date) return new Date(v);
      if (v instanceof RegExp) return new RegExp(v.source, v.flags);
      if (v instanceof ArrayBuffer) return v.slice(0);
      if (ArrayBuffer.isView(v)) return new (v.constructor as any)(copy(v.buffer), v.byteOffset, (v as any).length);
      const out: any = v instanceof Map ? new Map() : v instanceof Set ? new Set() : Array.isArray(v) ? [] : {};
      seen.set(v, out);
      if (v instanceof Map) v.forEach((x, k) => out.set(copy(k), copy(x)));
      else if (v instanceof Set) v.forEach(x => out.add(copy(x)));
      else Object.keys(v).forEach(k => { Object.defineProperty(out, k, { enumerable: true, configurable: true, writable: true, value: copy(v[k]) }); });
      return out;
    };
    return copy(value);
  });
}
