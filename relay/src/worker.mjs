import {
  json,
  failure,
  error,
  bodyJson,
  bodyBytes,
  validRoom,
  hash,
  mac,
  b64,
  random,
  cors,
  config,
  now,
} from "./common.mjs";
import { guard } from "./guard.mjs";
import { icon } from "./icon.mjs";
export { GroupRoom, PairRoom } from "./rooms.mjs";
export { Guard } from "./guard.mjs";
async function objectFetch(namespace, room, op, request, body) {
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  return namespace
    .get(namespace.idFromName(room))
    .fetch(
      new Request("https://internal/" + op, {
        method: body ? "POST" : request.method,
        headers,
        body: body
          ? JSON.stringify(body)
          : ["POST", "PUT"].includes(request.method)
            ? await bodyBytes(request,
                op === "snapshot" ? 1048576 : op.startsWith("journal") ? 262144 : op.startsWith("slots/") ? 65536 : op.startsWith("blobs/") ? 3145728 : 16384)
            : undefined,
      }),
    );
}
export async function handle(request, env, ctx) {
  if (env.TESTING === "true" && env.TEST_CONFIG)
    env.testConfig = JSON.parse(env.TEST_CONFIG);
  const started = Date.now(),
    url = new URL(request.url);
  let ipHash = "";
  try {
    if (!env.POW_SECRET || !env.IP_HASH_SALT)
      error(503, "SERVER_ERROR", "Service not configured");
    if (url.protocol !== "https:" && !env.LOCAL)
      error(400, "BAD_REQUEST", "HTTPS required");
    ipHash = await hash(
      (request.headers.get("CF-Connecting-IP") ?? "unknown") +
        "|" +
        env.IP_HASH_SALT,
    );
    if (env.KONGJING_GLOBAL_LIMIT) {
      const result = await env.KONGJING_GLOBAL_LIMIT.limit({ key: ipHash });
      if (!result.success) error(429, "RATE_LIMITED", "Too many requests", 60);
    }
    await guard(env, ipHash, "rate", { op: "global" });
    if (request.method === "OPTIONS")
      return json(null, 204, cors(request, env));
    let response;
    if (url.pathname === "/v1/health" && request.method === "GET")
      response = json({
        ok: true,
        service: "kongjing-relay",
        version: "2.0.0",
        time: now(env),
      });
    else if (url.pathname === "/v1/pow" && request.method === "GET") {
      const purpose = url.searchParams.get("purpose");
      if (!["group", "pair"].includes(purpose)) error(400, "BAD_REQUEST");
      const limit = await guard(env, ipHash, "rate", { op: "pow", purpose }),
        challenge = b64(random(16)),
        difficulty = config(env, "difficulty", limit.difficulty),
        expiresAt = now(env) + 120000,
        sig = await mac(
          env.POW_SECRET,
          challenge + String(difficulty) + String(expiresAt) + purpose,
        );
      await guard(env, ipHash, "issue", { challenge, expiresAt });
      response = json({ challenge, difficulty, expiresAt, purpose, sig });
    } else if (url.pathname === "/v1/groups" && request.method === "POST") {
      const b = await bodyJson(request);
      if (
        !validRoom(b.room) ||
        typeof b.tokenHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(b.tokenHash)
      )
        error(400, "BAD_REQUEST");
      if (b.rotateFrom) {
        if (!validRoom(b.rotateFrom)) error(400, "BAD_REQUEST");
        const auth = await objectFetch(
          env.GROUPS,
          b.rotateFrom,
          "authorize",
          new Request(request.url, { headers: request.headers }),
        );
        if (!auth.ok) return decorate(auth, request, env);
        if ((await auth.json()).retired) error(410, "GONE");
        await guard(env, ipHash, "rate", { op: "rotate" });
      } else {
        await guard(env, ipHash, "proof", { purpose: "group", proof: b.pow });
        await guard(env, ipHash, "rate", { op: "group" });
      }
      const reservation = await guard(env, ipHash, "capacity", { room: b.room, op: "reserve" });
      try {
        response = await objectFetch(env.GROUPS, b.room, "create", request, {
          room: b.room,
          tokenHash: b.tokenHash,
        });
        if (response.status !== 201 && reservation.reserved)
          await guard(env, ipHash, "capacity", { room: b.room, op: "release" });
      } catch (e) {
        if (reservation.reserved)
          await guard(env, ipHash, "capacity", { room: b.room, op: "release" });
        throw e;
      }
    } else if (url.pathname === "/v1/pair" && request.method === "POST") {
      const b = await bodyJson(request);
      if (!validRoom(b.room)) error(400, "BAD_REQUEST");
      await guard(env, ipHash, "proof", { purpose: "pair", proof: b.pow });
      await guard(env, ipHash, "rate", { op: "pair" });
      response = await objectFetch(env.PAIRS, b.room, "create", request, {
        room: b.room,
      });
    } else if (/^\/v1\/groups\/[\w-]{32}\/(?:journal|slots(?:\/[\w-]{22})?|blobs\/[\w-]{22})$/.test(url.pathname)) {
      const [, , , room, ...path] = url.pathname.split("/");
      const headers = new Headers(request.headers);
      headers.set("X-KJ-IP-Hash", ipHash);
      response = await objectFetch(env.GROUPS, room, path.join("/") + url.search,
        new Request(request, { headers }));
    } else if (
      /^\/v1\/groups\/[\w-]{32}(?:\/(?:snapshot|ws|forward))?$/.test(
        url.pathname,
      )
    ) {
      const [, , , room, op] = url.pathname.split("/");
      if (
        (!op && request.method !== "DELETE") ||
        (op === "snapshot" && !["GET", "PUT"].includes(request.method)) ||
        (op === "ws" && request.method !== "GET") ||
        (op === "forward" && !["GET", "POST"].includes(request.method))
      )
        error(400, "BAD_REQUEST");
      response = await objectFetch(env.GROUPS, room, op ?? "delete", request);
    } else if (/^\/v1\/pair\/[\w-]{32}\/ws$/.test(url.pathname)) {
      const room = url.pathname.split("/")[3];
      if (
        !(request.headers.get("Sec-WebSocket-Protocol") ?? "")
          .split(",")
          .some((s) => s.trim().startsWith("kjh."))
      ) {
        const exists = await (
          await objectFetch(env.PAIRS, room, "exists", new Request(request.url))
        ).json();
        await guard(env, ipHash, "rate", {
          op: "guest",
          missing: !exists.exists,
        });
      }
      response = await objectFetch(env.PAIRS, room, "ws", request);
    } else if (url.pathname === "/v1/icon" && request.method === "GET") {
      await guard(env, ipHash, "rate", { op: "icon" });
      response = await icon(request, env, ctx);
    } else if (
      !url.pathname.startsWith("/v1/") &&
      ["GET", "HEAD"].includes(request.method) &&
      env.ASSETS
    ) {
      response = await env.ASSETS.fetch(
        request.method === "HEAD"
          ? new Request(request, { method: "GET" })
          : request,
      );
      if (request.method === "HEAD") {
        const headers = new Headers(response.headers);
        if (!headers.has("Content-Length") && response.body) {
          // Assets can omit the length header; count the stream without buffering it.
          const reader = response.body.getReader();
          let length = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
          }
          headers.set("Content-Length", String(length));
        } else await response.body?.cancel();
        response = new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } else error(404, "NOT_FOUND");
    return decorate(response, request, env);
  } catch (e) {
    return decorate(failure(e), request, env);
  } finally {
    if (env.LOG_REQUESTS === "true")
      console.log(
        JSON.stringify({
          route: url.pathname.replace(/[\w-]{32}/g, ":room"),
          ms: Date.now() - started,
          ip: ipHash.slice(0, 8),
        }),
      );
  }
}
function decorate(response, request, env) {
  if (response.status === 101 || response.localSocket) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors(request, env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
export default { fetch: handle };
