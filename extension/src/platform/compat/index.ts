// This module is loaded before the entire Android application dependency graph.
// Desktop builds never import it. Limit core-js to APIs actually used by home
// and the shared protocol (including clone support for Maps/typed buffers).
import "core-js/actual/structured-clone";
import "core-js/actual/array/at";
import { installCompressionStreams } from "./compression";

if (!crypto.randomUUID) {
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
}
if (!AbortSignal.timeout) {
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (ms: number) => {
      if (!Number.isSafeInteger(ms) || ms < 0)
        throw new RangeError("Invalid timeout");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    },
  });
}
installCompressionStreams();
