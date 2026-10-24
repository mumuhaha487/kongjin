export const enc = new TextEncoder();
export const bytes = (s) => enc.encode(s);
export const b64 = (b) => {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64 = (s) => {
  if (typeof s !== "string" || !/^[\w-]*$/.test(s) || s.length % 4 === 1)
    throw new Error("base64url");
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
};
export const random = (n) => crypto.getRandomValues(new Uint8Array(n));
export const hash = async (s) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof s === "string" ? bytes(s) : s,
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
export async function mac(key, s) {
  const k = await crypto.subtle.importKey(
    "raw",
    bytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes(s))));
}
export async function checkMac(key, s, sig) {
  try {
    const k = await crypto.subtle.importKey(
      "raw",
      bytes(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("HMAC", k, unb64(sig), bytes(s));
  } catch {
    return false;
  }
}
export class HttpError extends Error {
  constructor(status, code, message = code, retryAfter) {
    super(message);
    Object.assign(this, { status, code, retryAfter });
  }
}
export const error = (status, code, message, retryAfter) => {
  throw new HttpError(status, code, message, retryAfter);
};
export function json(value, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
export function failure(e) {
  return json(
    {
      error: {
        code: e.code ?? "SERVER_ERROR",
        message: e instanceof HttpError ? e.message : "Internal server error",
      },
      ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
    },
    e.status ?? 500,
    e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {},
  );
}
export async function bodyBytes(request, max) {
  const length = request.headers.get("content-length");
  if (length && Number(length) > max) error(413, "PAYLOAD_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        error(413, "PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let i = 0;
  for (const c of chunks) {
    result.set(c, i);
    i += c.length;
  }
  return result;
}
export async function bodyJson(request, max = 16384) {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await bodyBytes(request, max),
      ),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      error(400, "BAD_REQUEST", "JSON object required");
    return value;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    error(400, "BAD_REQUEST", "Invalid JSON");
  }
}
export const validRoom = (r) => typeof r === "string" && /^[\w-]{32}$/.test(r);
export const validEnv = (e) =>
  e?.v === 1 &&
  typeof e.iv === "string" &&
  /^[\w-]{16}$/.test(e.iv) &&
  typeof e.ct === "string" &&
  /^[\w-]{22,}$/.test(e.ct);
export const now = (env) =>
  env.TESTING === "true" && env.testClock ? env.testClock() : Date.now();
export const config = (env, key, normal) =>
  env.TESTING === "true" && env.testConfig?.[key] !== undefined
    ? env.testConfig[key]
    : normal;
export function hit(map, key, limit, period, time, weight = 1) {
  let item = map[key];
  if (!item || item.start + period <= time)
    item = map[key] = { start: time, count: 0 };
  if (item.count + weight > limit)
    error(
      429,
      "RATE_LIMITED",
      "Too many requests",
      Math.max(1, Math.ceil((item.start + period - time) / 1000)),
    );
  item.count += weight;
  return item.count;
}
export function cors(request, env) {
  const origin = request.headers.get("Origin");
  const extra = (env.EXTRA_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean);
  const allowed =
    /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? "") ||
    extra.some(
      (x) =>
        x === origin ||
        (x === "http://localhost:*" &&
          /^http:\/\/localhost:\d+$/.test(origin ?? "")),
    );
  return {
    Vary: "Origin",
    "Access-Control-Allow-Headers": "Content-Type, X-KJ-Token, If-Match",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "ETag, Retry-After",
    ...(allowed ? { "Access-Control-Allow-Origin": origin } : {}),
  };
}
export function protocols(request) {
  return (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((x) => x.trim());
}
export function upgrade(ctx, env, request, attachment, onAccept) {
  if (env.localUpgrade) {
    const r = env.localUpgrade(ctx, request, attachment);
    onAccept?.(r.localSocket);
    return r;
  }
  const pair = new WebSocketPair();
  ctx.acceptWebSocket(pair[1]);
  pair[1].serializeAttachment(attachment);
  onAccept?.(pair[1]);
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: { "Sec-WebSocket-Protocol": "kj.v1" },
  });
}
export function closeAll(ctx, code = 1000, message = "") {
  for (const ws of ctx.getWebSockets()) {
    try {
      ws.close(code, message);
    } catch {}
  }
}
export function broadcast(ctx, data, except) {
  const s = JSON.stringify(data);
  for (const ws of ctx.getWebSockets())
    if (ws !== except)
      try {
        ws.send(s);
      } catch {}
}
export class Serialized {
  constructor() {
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }
}
