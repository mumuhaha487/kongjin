import {
  ProtocolError,
  type Envelope,
  type EnvelopePlain,
  type SnapshotPlain,
} from "./types.ts";
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const text = (b: BufferSource | Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(
    b instanceof Uint8Array ? buf(b) : b,
  );
export function b64url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64(s: string): Uint8Array {
  if (!/^[\w-]*$/.test(s) || s.length % 4 === 1)
    throw new Error("Invalid base64url");
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
export function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    b.set(p, i);
    i += p.length;
  }
  return b;
}
// Copy to ArrayBuffer so these helpers also typecheck with modern generic Uint8Array types.
export const buf = (b: Uint8Array): ArrayBuffer =>
  b.slice().buffer as ArrayBuffer;
export const sha256 = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", buf(b)));
export const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string | Uint8Array,
  n = 32,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: buf(salt),
        info: buf(typeof info === "string" ? utf8(info) : info),
      },
      key,
      n * 8,
    ),
  );
}
export const aesKey = (b: Uint8Array) =>
  crypto.subtle.importKey("raw", buf(b), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
export async function encrypt(
  key: CryptoKey,
  plain: Uint8Array,
  aad?: Uint8Array,
  iv = random(12),
) {
  return {
    iv,
    ct: new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: buf(iv),
          ...(aad ? { additionalData: buf(aad) } : {}),
        },
        key,
        buf(plain),
      ),
    ),
  };
}
export async function decrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ct: Uint8Array,
  aad?: Uint8Array,
) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: buf(iv),
        ...(aad ? { additionalData: buf(aad) } : {}),
      },
      key,
      buf(ct),
    ),
  );
}
export async function hmac(key: Uint8Array, message: string) {
  const k = await crypto.subtle.importKey(
    "raw",
    buf(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(utf8(message)))),
  );
}
export async function verifyMac(key: Uint8Array, message: string, mac: string) {
  try {
    const k = await crypto.subtle.importKey(
      "raw",
      buf(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("HMAC", k, buf(unb64(mac)), buf(utf8(message)));
  } catch {
    return false;
  }
}
export async function identity() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const pub = b64url(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  return {
    privateKey: pair.privateKey,
    pub,
    deviceId: b64url(await sha256(unb64(pub))).slice(0, 16),
  };
}
export async function ecdh(privateKey: CryptoKey, pub: string) {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    buf(unb64(pub)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      privateKey,
      256,
    ),
  );
}
export async function deriveGroup(gk: Uint8Array, epoch: number) {
  return {
    roomId: b64url(await hkdf(gk, utf8("kongjing"), "kj/room/" + epoch, 24)),
    roomToken: b64url(await hkdf(gk, utf8("kongjing"), "kj/token/" + epoch)),
    encKey: await aesKey(await hkdf(gk, utf8("kongjing"), "kj/enc/" + epoch)),
  };
}
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function generatePairCode() {
  return Array.from(random(10), (x) => alphabet[x & 31]).join("");
}
export function normalizePairCode(input: string): string | null {
  let s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/^KJ/, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(s) ? s : null;
}
export function formatPairCode(code: string) {
  const c = normalizePairCode(code);
  if (!c) throw new ProtocolError("BAD_CODE");
  return "KJ-" + c.slice(0, 5) + "-" + c.slice(5);
}
export async function pairKeys(code: string) {
  return {
    room: b64url(await sha256(utf8("kj/pair/v1|" + code))).slice(0, 32),
    authKey: await hkdf(utf8(code), utf8("kj/pair/auth"), ""),
  };
}
export async function pairSession(
  privateKey: CryptoKey,
  otherPub: string,
  epkI: string,
  epkJ: string,
  idJ: string,
) {
  const shared = await ecdh(privateKey, otherPub),
    th = await sha256(utf8("kj/pair/v1|" + epkI + "|" + epkJ + "|" + idJ));
  const sasBytes = await hkdf(shared, th, "kj/pair/sas", 4),
    digits = (new DataView(buf(sasBytes)).getUint32(0) % 1000000)
      .toString()
      .padStart(6, "0");
  return {
    key: await aesKey(await hkdf(shared, th, "kj/pair/session")),
    sas: digits.slice(0, 3) + " " + digits.slice(3),
  };
}
export async function sealEnvelope(
  key: CryptoKey,
  room: string,
  plain: EnvelopePlain,
): Promise<Envelope> {
  const e = await encrypt(
    key,
    utf8(JSON.stringify(plain)),
    utf8("kj/env/" + room),
  );
  return { v: 1, iv: b64url(e.iv), ct: b64url(e.ct) };
}
export async function openEnvelope(
  key: CryptoKey,
  room: string,
  env: Envelope,
): Promise<EnvelopePlain> {
  if (env.v !== 1) throw new Error("Envelope version");
  return JSON.parse(
    text(
      await decrypt(key, unb64(env.iv), unb64(env.ct), utf8("kj/env/" + room)),
    ),
  );
}

// Raw DEFLATE decoder, including dynamic Huffman blocks. This fallback keeps
// Node 18 compatibility, where DecompressionStream does not accept deflate-raw.
export function inflateRaw(
  input: Uint8Array,
  max = 32 * 1024 * 1024,
): Uint8Array {
  let pos = 0,
    bits = 0,
    hold = 0,
    out = new Uint8Array(Math.min(65536, max)),
    len = 0;
  const read = (n: number) => {
    while (bits < n) {
      if (pos >= input.length) throw new Error("Truncated deflate");
      hold |= input[pos++] << bits;
      bits += 8;
    }
    const v = hold & ((1 << n) - 1);
    hold >>>= n;
    bits -= n;
    return v;
  };
  const emit = (v: number) => {
    if (len >= max) throw new Error("Inflated data too large");
    if (len === out.length) {
      const b = new Uint8Array(Math.min(max, out.length * 2));
      b.set(out);
      out = b;
    }
    out[len++] = v;
  };
  const table = (lengths: number[]) => {
    const counts = new Array(16).fill(0),
      next = new Array(16).fill(0),
      maps = new Map<number, number>();
    lengths.forEach((l) => counts[l]++);
    counts[0] = 0;
    let code = 0;
    for (let i = 1; i <= 15; i++) {
      code = (code + (counts[i - 1] || 0)) << 1;
      next[i] = code;
    }
    lengths.forEach((l, sym) => {
      if (l) {
        let c = next[l]++,
          r = 0;
        for (let j = 0; j < l; j++) {
          r = (r << 1) | (c & 1);
          c >>>= 1;
        }
        maps.set((1 << l) | r, sym);
      }
    });
    return maps;
  };
  const symbol = (t: Map<number, number>) => {
    let c = 0;
    for (let l = 1; l <= 15; l++) {
      c |= read(1) << (l - 1);
      const s = t.get((1 << l) | c);
      if (s !== undefined) return s;
    }
    throw new Error("Invalid Huffman code");
  };
  const lb = [
      3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
      67, 83, 99, 115, 131, 163, 195, 227, 258,
    ],
    le = [
      0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
      5, 5, 5, 0,
    ];
  const db = [
      1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
      769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ],
    de = [
      0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
      11, 11, 12, 12, 13, 13,
    ];
  let final = 0;
  do {
    final = read(1);
    const type = read(2);
    if (type === 0) {
      hold = 0;
      bits = 0;
      const n = read(16),
        inv = read(16);
      if ((n ^ inv) !== 65535) throw new Error("Invalid stored block");
      for (let i = 0; i < n; i++) emit(read(8));
      continue;
    }
    if (type === 3) throw new Error("Invalid deflate block");
    let lit: number[], dist: number[];
    if (type === 1) {
      lit = Array.from({ length: 288 }, (_, i) =>
        i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8,
      );
      dist = new Array(32).fill(5);
    } else {
      const nl = read(5) + 257,
        nd = read(5) + 1,
        nc = read(4) + 4;
      const cl = new Array(19).fill(0),
        co = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      for (let i = 0; i < nc; i++) cl[co[i]] = read(3);
      const ct = table(cl),
        ls: number[] = [];
      while (ls.length < nl + nd) {
        const s = symbol(ct);
        if (s < 16) ls.push(s);
        else {
          const n =
              s === 16 ? read(2) + 3 : s === 17 ? read(3) + 3 : read(7) + 11,
            v = s === 16 ? ls[ls.length - 1] : 0;
          if (v === undefined) throw new Error("Invalid repeat");
          for (let i = 0; i < n; i++) ls.push(v);
        }
      }
      if (ls.length !== nl + nd) throw new Error("Invalid lengths");
      lit = ls.slice(0, nl);
      dist = ls.slice(nl);
    }
    const lt = table(lit),
      dt = table(dist);
    while (true) {
      const s = symbol(lt);
      if (s < 256) emit(s);
      else if (s === 256) break;
      else {
        const i = s - 257;
        if (i >= lb.length) throw new Error("Invalid length");
        const n = lb[i] + read(le[i]),
          d = symbol(dt);
        if (d >= db.length) throw new Error("Invalid distance");
        const distance = db[d] + read(de[d]);
        if (distance > len) throw new Error("Invalid backreference");
        for (let j = 0; j < n; j++) emit(out[len - distance]);
      }
    }
  } while (!final);
  return out.slice(0, len);
}
export async function deflateRaw(input: Uint8Array) {
  const stream = new Blob([buf(input)])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  const z = new Uint8Array(await new Response(stream).arrayBuffer());
  return z.slice(2, -4);
}
export async function sealSnapshot<D>(
  key: CryptoKey,
  room: string,
  plain: SnapshotPlain<D>,
  iv?: Uint8Array,
) {
  const e = await encrypt(
    key,
    await deflateRaw(utf8(JSON.stringify(plain))),
    utf8("kj/snapshot/" + room),
    iv,
  );
  const bytes = concat(new Uint8Array([1]), e.iv, e.ct);
  if (bytes.length > 1048576)
    throw new ProtocolError(
      "SNAPSHOT_TOO_LARGE",
      "同步数据超过 1 MB，请减少自定义图标或背景",
    );
  return bytes;
}
export async function openSnapshot<D>(
  key: CryptoKey,
  room: string,
  bytes: Uint8Array,
): Promise<SnapshotPlain<D>> {
  if (bytes[0] !== 1 || bytes.length < 29) throw new Error("Snapshot version");
  const raw = await decrypt(
    key,
    bytes.slice(1, 13),
    bytes.slice(13),
    utf8("kj/snapshot/" + room),
  );
  const plain = JSON.parse(text(inflateRaw(raw)));
  if (plain.v !== 1) throw new Error("Snapshot version");
  return plain;
}
export async function wrapKey(
  privateKey: CryptoKey,
  pub: string,
  deviceId: string,
  epoch: number,
  plain: unknown,
) {
  const k = await aesKey(
    await hkdf(
      await ecdh(privateKey, pub),
      utf8("kj/rotate/" + epoch),
      deviceId,
    ),
  );
  const e = await encrypt(k, utf8(JSON.stringify(plain)));
  return b64url(concat(e.iv, e.ct));
}
export async function unwrapKey(
  privateKey: CryptoKey,
  pub: string,
  deviceId: string,
  epoch: number,
  wrap: string,
) {
  const b = unb64(wrap),
    k = await aesKey(
      await hkdf(
        await ecdh(privateKey, pub),
        utf8("kj/rotate/" + epoch),
        deviceId,
      ),
    );
  return JSON.parse(text(await decrypt(k, b.slice(0, 12), b.slice(12))));
}
