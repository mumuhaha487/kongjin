import { readFile } from "node:fs/promises";
import { it, expect } from "vitest";
import {
  deriveGroup,
  pairKeys,
  pairSession,
  unb64,
  b64url,
  hkdf,
  utf8,
  ecdh,
  sha256,
} from "../../shared/protocol/src/crypto.ts";
const vectors = JSON.parse(
  await readFile(
    new URL("../../shared/protocol/test/vectors.json", import.meta.url),
    "utf8",
  ),
);
it("shared protocol deterministic vectors: group keys, pair authentication, ECDH and SAS", async () => {
  const v = vectors;
  const group = await deriveGroup(unb64(v.group.gk), v.group.epoch);
  expect(group.roomId).toBe(v.group.roomId);
  expect(group.roomToken).toBe(v.group.roomToken);
  expect(
    b64url(await hkdf(unb64(v.group.gk), utf8("kongjing"), "kj/enc/1")),
  ).toBe(v.group.encKey);
  const pair = await pairKeys(v.code.raw);
  expect(pair.room).toBe(v.code.room);
  expect(b64url(pair.authKey)).toBe(v.code.authKey);
  const pub = unb64(v.pair.epkI),
    scalar = new Uint8Array(32);
  scalar.set(unb64(v.pair.privateI), 31);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64url(pub.slice(1, 33)),
      y: b64url(pub.slice(33)),
      d: b64url(scalar),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  expect(b64url(await ecdh(key, v.pair.epkJ))).toBe(v.pair.shared);
  expect(
    b64url(
      await sha256(
        utf8(
          "kj/pair/v1|" + v.pair.epkI + "|" + v.pair.epkJ + "|" + v.pair.idJ,
        ),
      ),
    ),
  ).toBe(v.pair.transcriptHash);
  const session = await pairSession(
    key,
    v.pair.epkJ,
    v.pair.epkI,
    v.pair.epkJ,
    v.pair.idJ,
  );
  expect(session.sas).toBe(v.pair.sas);
});
