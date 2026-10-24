import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import vectors from "./vectors.json";
import {
  deriveGroup,
  unb64,
  b64url,
  identity,
  pairSession,
  pairKeys,
  normalizePairCode,
  formatPairCode,
  sealSnapshot,
  openSnapshot,
  sealEnvelope,
  openEnvelope,
  inflateRaw,
  wrapKey,
  unwrapKey,
  buf,
  leadingZeros,
  solvePow,
  hmac,
  verifyMac,
} from "../src/index.ts";
describe("PROTOCOL fixed vectors", () => {
  it("HKDF group derivations", async () => {
    const k = await deriveGroup(unb64(vectors.group.gk), vectors.group.epoch);
    expect(k.roomId).toBe(vectors.group.roomId);
    expect(k.roomToken).toBe(vectors.group.roomToken);
    expect(k.encKey.extractable).toBe(false);
  });
  it("fixed ECDH transcript and six digit SAS", async () => {
    const p = unb64(vectors.pair.epkI);
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: vectors.pair.privateI,
        x: b64url(p.slice(1, 33)),
        y: b64url(p.slice(33)),
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const s = await pairSession(
      privateKey,
      vectors.pair.epkJ,
      vectors.pair.epkI,
      vectors.pair.epkJ,
      vectors.pair.idJ,
    );
    expect(s.sas).toBe(vectors.pair.sas);
    expect(s.key.extractable).toBe(false);
  });
  it("pair code normalization and key derivation", async () => {
    expect(normalizePairCode("KJ23456789")).toBe("KJ23456789");
    expect(formatPairCode("KJ23456789")).toBe("KJ-KJ234-56789");
    expect(normalizePairCode(" kj-oI234 - 56789 ")).toBe(vectors.code.raw);
    expect(formatPairCode(vectors.code.raw)).toBe(vectors.code.formatted);
    expect(normalizePairCode("KJ-UUUUU-UUUUU")).toBeNull();
    const k = await pairKeys(vectors.code.raw);
    expect(k.room).toBe(vectors.code.room);
    expect(b64url(k.authKey)).toBe(vectors.code.authKey);
  });
  it("hello-i fixed MAC authenticates the inviter name and platform", async () => {
    const { name, platform, mac } = vectors.helloI,
      key = unb64(vectors.code.authKey),
      message = (n: string, p: string) =>
        "I|" + vectors.pair.epkI + "|" + vectors.pair.epkJ + "|" + n + "|" + p;
    // This expected MAC was generated independently with Node createHmac.
    expect(await hmac(key, message(name, platform))).toBe(mac);
    expect(await verifyMac(key, message(name, platform), mac)).toBe(true);
    expect(await verifyMac(key, message(name + "!", platform), mac)).toBe(false);
    expect(await verifyMac(key, message(name, platform + "!"), mac)).toBe(false);
    expect(await verifyMac(key, "I|" + vectors.pair.epkI + "|" + vectors.pair.epkJ, mac)).toBe(false);
  });
  it("identity private key non-extractable", async () => {
    const id = await identity();
    expect(id.privateKey.extractable).toBe(false);
    expect(unb64(id.pub)).toHaveLength(65);
    expect(id.deviceId).toHaveLength(16);
  });
  it("raw DEFLATE all block types and output bound", () => {
    const plain = new TextEncoder().encode("hello中文".repeat(10000));
    for (const options of [
      { level: 0 },
      { level: 1 },
      { level: 9 },
      { strategy: 4 },
    ])
      expect(inflateRaw(deflateRawSync(plain, options))).toEqual(plain);
    expect(() => inflateRaw(deflateRawSync(plain), 10)).toThrow();
  });
  it("snapshot layout, roundtrip, AAD and authentication", async () => {
    const k = await deriveGroup(unb64(vectors.group.gk), 1),
      p = {
        v: 1 as const,
        writer: "A",
        at: 1,
        group: { epoch: 1, members: [] },
        data: { url: "https://private.example", title: "secret" },
      };
    const b = await sealSnapshot(k.encKey, k.roomId, p);
    expect(b[0]).toBe(1);
    expect(await openSnapshot(k.encKey, k.roomId, b)).toEqual(p);
    expect(new TextDecoder().decode(b)).not.toContain(p.data.url);
    await expect(openSnapshot(k.encKey, "other", b)).rejects.toThrow();
    b[b.length - 1] ^= 1;
    await expect(openSnapshot(k.encKey, k.roomId, b)).rejects.toThrow();
  });
  it("rejects encoded snapshots above 1 MiB before upload", async () => {
    const random = new Uint8Array(1200000);
    for (let i = 0; i < random.length; i += 65536)
      crypto.getRandomValues(random.subarray(i, i + 65536));
    const k = await deriveGroup(unb64(vectors.group.gk), 1);
    await expect(
      sealSnapshot(k.encKey, k.roomId, {
        v: 1,
        writer: "A",
        at: 1,
        group: { epoch: 1, members: [] },
        data: { payload: b64url(random) },
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" });
  });
  it("envelopes bind to room", async () => {
    const k = await deriveGroup(unb64(vectors.group.gk), 1),
      m = {
        t: "presence",
        from: "A",
        at: 1,
        name: "device",
        platform: "test",
        online: true,
      },
      e = await sealEnvelope(k.encKey, k.roomId, m);
    expect(await openEnvelope(k.encKey, k.roomId, e)).toEqual(m);
    await expect(openEnvelope(k.encKey, "bad", e)).rejects.toThrow();
  });
  it("rotation wraps only decrypt for target identity and epoch", async () => {
    const a = await identity(),
      b = await identity(),
      c = await identity(),
      p = { gk: b64url(new Uint8Array(32)), epoch: 2 };
    const wrap = await wrapKey(a.privateKey, b.pub, b.deviceId, 2, p);
    expect(await unwrapKey(b.privateKey, a.pub, b.deviceId, 2, wrap)).toEqual(
      p,
    );
    await expect(
      unwrapKey(c.privateKey, a.pub, c.deviceId, 2, wrap),
    ).rejects.toThrow();
    await expect(
      unwrapKey(b.privateKey, a.pub, b.deviceId, 3, wrap),
    ).rejects.toThrow();
  });
  it("PoW uint64 big endian + leading bits", async () => {
    expect(leadingZeros(new Uint8Array([0, 1]))).toBe(15);
    const p = await solvePow({
      challenge: b64url(new Uint8Array(16)),
      difficulty: 4,
      expiresAt: Date.now() + 120000,
      purpose: "group",
      sig: "test",
    });
    expect(unb64(p.nonce)).toHaveLength(8);
    const input = new Uint8Array(24);
    input.set(unb64(p.challenge));
    input.set(unb64(p.nonce), 16);
    expect(leadingZeros(new Uint8Array(await crypto.subtle.digest('SHA-256', input)))).toBeGreaterThanOrEqual(p.difficulty);
    const expired = { ...p, expiresAt: Date.now() - 1 };
    await expect(solvePow(expired)).rejects.toThrow('EXPIRED');
    const controller = new AbortController(); controller.abort();
    await expect(solvePow(p, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
