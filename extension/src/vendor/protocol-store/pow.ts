import { b64url, sha256, unb64 } from "./crypto.ts";
import type { PowChallenge, PowProof } from "./types.ts";
export function leadingZeros(b: Uint8Array) {
  let n = 0;
  for (const x of b) {
    if (x === 0) n += 8;
    else {
      n += Math.clz32(x) - 24;
      break;
    }
  }
  return n;
}
export async function solvePow(
  challenge: PowChallenge,
  signal?: AbortSignal,
): Promise<PowProof> {
  const prefix = unb64(challenge.challenge);
  for (let n = 0n; n <= 0xffffffffffffffffn;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() >= challenge.expiresAt) throw new Error("EXPIRED");
    // Bounded parallel WebCrypto calls avoid one native round trip per nonce.
    const candidates: Uint8Array[] = [];
    for (let i = 0; i < 64 && n <= 0xffffffffffffffffn; i++, n++) {
      const data = new Uint8Array(prefix.length + 8);
      data.set(prefix);
      new DataView(data.buffer).setBigUint64(prefix.length, n);
      candidates.push(data);
    }
    const digests = await Promise.all(candidates.map(sha256));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() >= challenge.expiresAt) throw new Error("EXPIRED");
    for (let i = 0; i < digests.length; i++)
      if (leadingZeros(digests[i]) >= challenge.difficulty)
        return { ...challenge, nonce: b64url(candidates[i].subarray(prefix.length)) };
  }
  throw new Error("PoW exhausted");
}
export async function solvePowWorker(
  challenge: PowChallenge,
  url?: string,
): Promise<PowProof> {
  if (!url || typeof Worker === "undefined") return solvePow(challenge);
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { type: "module" });
    worker.onmessage = (e) => {
      worker.terminate();
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(challenge);
  });
}
