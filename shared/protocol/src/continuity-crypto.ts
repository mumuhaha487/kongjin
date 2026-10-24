import { b64url, unb64, hkdf, utf8, deflateRaw, inflateRaw, encrypt, decrypt, concat, text, sha256 } from "./crypto.ts";
import { ProtocolError, type Envelope } from "./types.ts";

export async function deriveSlotId(gk: Uint8Array, epoch: number, deviceId: string) {
  return b64url(await hkdf(gk, utf8("kongjing"), "kj/slot/" + epoch + "/" + deviceId, 16));
}
export async function historyEntryId(dev: string, u: string, at: number) {
  return b64url(await sha256(utf8(dev + "|" + u + "|" + Math.floor(at / 60000)))).slice(0, 22);
}
export async function sealContinuity(key: CryptoKey, aad: string, bytes: Uint8Array, iv?: Uint8Array): Promise<Envelope> {
  const e = await encrypt(key, await deflateRaw(bytes), utf8(aad), iv);
  return { v: 1, iv: b64url(e.iv), ct: b64url(e.ct) };
}
export async function openContinuity(key: CryptoKey, aad: string, env: Envelope) {
  if (env?.v !== 1) throw new ProtocolError("BAD_REQUEST", "Envelope version");
  return inflateRaw(await decrypt(key, unb64(env.iv), unb64(env.ct), utf8(aad)));
}
export function envelopeBytes(env: Envelope): Uint8Array {
  return concat(new Uint8Array([1]), unb64(env.iv), unb64(env.ct));
}
export function bytesEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.length < 29 || bytes[0] !== 1) throw new ProtocolError("BAD_REQUEST", "Envelope version");
  return { v: 1, iv: b64url(bytes.slice(1, 13)), ct: b64url(bytes.slice(13)) };
}
export const sealJournal = (key: CryptoKey, room: string, id: string, plain: object, iv?: Uint8Array) =>
  sealContinuity(key, "kj/j/" + room + "/" + id, utf8(JSON.stringify(plain)), iv);
export const openJournal = async (key: CryptoKey, room: string, id: string, env: Envelope) =>
  JSON.parse(text(await openContinuity(key, "kj/j/" + room + "/" + id, env)));
export const sealSlot = async (key: CryptoKey, room: string, id: string, plain: object, iv?: Uint8Array) =>
  envelopeBytes(await sealContinuity(key, "kj/s/" + room + "/" + id, utf8(JSON.stringify(plain)), iv));
export const openSlot = async (key: CryptoKey, room: string, id: string, env: Envelope) =>
  JSON.parse(text(await openContinuity(key, "kj/s/" + room + "/" + id, env)));
export const sealBlob = async (key: CryptoKey, room: string, id: string, bytes: Uint8Array, iv?: Uint8Array) =>
  envelopeBytes(await sealContinuity(key, "kj/b/" + room + "/" + id, bytes, iv));
export const openBlob = (key: CryptoKey, room: string, id: string, bytes: Uint8Array) =>
  openContinuity(key, "kj/b/" + room + "/" + id, bytesEnvelope(bytes));
