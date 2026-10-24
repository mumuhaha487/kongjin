import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (family === 6) {
    const a = address.toLowerCase();
    // Conservatively allow global unicast only. Mapped IPv4, link local,
    // unique local, multicast and documentation ranges never reach a socket.
    return (
      /^[23]/.test(a) &&
      !a.startsWith("2001:db8:") &&
      !a.startsWith("2001:0:") &&
      !a.startsWith("2002:")
    );
  }
  return false;
}

// Resolve once, validate every answer, then pin the validated addresses to this
// TLS/HTTP connection. A second DNS answer cannot redirect us to a private IP.
export async function publicFetch(input, init = {}) {
  const url = new URL(input);
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise((_, reject) =>
      init.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    ),
  ]);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Private DNS destination rejected");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        signal: init.signal,
        headers: { ...init.headers, "Accept-Encoding": "identity" },
        lookup(_hostname, options, cb) {
          const selected = addresses.filter(
            (a) => !options.family || a.family === options.family,
          );
          if (!selected.length) {
            cb(new Error("No public address in requested family"));
            return;
          }
          if (options.all) cb(null, selected);
          else cb(null, selected[0].address, selected[0].family);
        },
      },
      (response) => {
        const headers = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        resolve(
          new Response(Readable.toWeb(response), {
            status: response.statusCode,
            headers,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}
