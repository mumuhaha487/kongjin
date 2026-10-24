import { createServer } from "node:http";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, PassThrough } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { publicFetch } from "./public-fetch.mjs";
import { handle, GroupRoom, PairRoom, Guard } from "../src/worker.mjs";
const args = process.argv.slice(2),
  arg = (key, value) =>
    args.includes(key) ? args[args.indexOf(key) + 1] : value;
const port = Number(arg("--port", "8790")),
  data = resolve(
    arg(
      "--data",
      new URL("../.data", import.meta.url).pathname.replace(
        /^\/(?=[A-Za-z]:)/,
        "",
      ),
    ),
  ),
  difficulty = Number(arg("--pow", "18"));
const useSqlite=args.includes('--sqlite'),testControls=args.includes('--test-controls');
if(testControls&&arg('--host','127.0.0.1')!=='127.0.0.1')throw new Error('Test controls require loopback');
const metrics={http:0,doCalls:0,wsFrames:0,sqlBaseWrites:0,sqlIndexWrites:0};
let testTime=Date.now();
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isInteger(difficulty) ||
  difficulty < 0 ||
  difficulty > 256
)
  throw new Error("Invalid --port or --pow");
await mkdir(data, { recursive: true });
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
async function atomic(path, content) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temp = path + "." + randomBytes(6).toString("hex");
  await writeFile(temp, content);
  await rename(temp, path);
}
let secrets = await readJson(join(data, "runtime.json"));
if (!secrets) {
  secrets = {
    POW_SECRET: randomBytes(32).toString("base64url"),
    IP_HASH_SALT: randomBytes(32).toString("base64url"),
  };
  await atomic(join(data, "runtime.json"), JSON.stringify(secrets));
}
const env = {
  iconFetch: publicFetch,
  ...secrets,
  LOCAL: true,
  TESTING: "true",
  testConfig: { difficulty },
  EXTRA_ORIGINS: "http://localhost:*,https://appassets.androidplatform.net",
  ...(testControls?{testClock:()=>testTime}:{}),
  BUCKET: {
    async put(key, value, options = {}) {
      const content =
        typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      await atomic(join(data, "r2", key), content);
      await atomic(
        join(data, "r2", key + ".meta"),
        JSON.stringify(options.customMetadata ?? {}),
      );
    },
    async get(key) {
      try {
        const b = await readFile(join(data, "r2", key));
        return {
          body: Readable.toWeb(Readable.from([b])),
          arrayBuffer: async () =>
            b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
          json: async () => JSON.parse(b.toString()),
          customMetadata: await readJson(join(data, "r2", key + ".meta"), {}),
        };
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys])
        for (const path of [
          join(data, "r2", key),
          join(data, "r2", key + ".meta"),
        ])
          try {
            await unlink(path);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
    },
  },
};
const objects = new Map(),
  contexts = new Map();
function namespace(name, Class) {
  const loading = new Map();
  async function load(id) {
    const key = name + "/" + id;
    if (!loading.has(key) && !objects.has(key)) {
      loading.set(key, (async () => {
            const file = join(
                data,
                "do",
                name,
                Buffer.from(id).toString("hex") + ".json",
              ),
              values = await readJson(file, {}),
              sockets = new Set();
            let timer;
            const arm=(time)=>{if(testControls)return;clearTimeout(timer);timer=setTimeout(()=>void objects.get(key).alarm(),Math.min(2147483647,Math.max(1,time-Date.now())));timer.unref();};
            const save = () => atomic(file, JSON.stringify(values));
            const ctx = {
              storage: {
                async get(k) {
                  return values[k];
                },
                async put(k, v) {
                  values[k] = v;
                  await save();
                },
                async delete(k) {
                  delete values[k];
                  await save();
                },
                async deleteAll() {
                  for (const k of Object.keys(values)) delete values[k];
                  clearTimeout(timer);
                  await save();
                },
                async list({ prefix = "", limit = Infinity } = {}) {
                  return new Map(
                    Object.entries(values)
                      .filter(([k]) => k.startsWith(prefix))
                      .slice(0, limit),
                  );
                },
                async setAlarm(time) {
                  values._alarm = time;
                  await save();
                  clearTimeout(timer);
                  timer = setTimeout(
                    () => {
                      void objects.get(key).alarm();
                    },
                    Math.min(2147483647, Math.max(1, time - Date.now())),
                  );
                  timer.unref();
                },
                async getAlarm(){return values._alarm;},
              },
              acceptWebSocket(ws) {
                sockets.add(ws);
                ws.on("message", (data, binary) => {
                  metrics.wsFrames++;
                  void objects
                    .get(key)
                    .webSocketMessage(ws, binary ? data : data.toString());
                });
                ws.on("close", (code, reason) => {
                  sockets.delete(ws);
                  objects
                    .get(key)
                    .webSocketClose?.(ws, code, reason.toString());
                });
                ws.on("error", () => objects.get(key).webSocketError?.(ws));
              },
              getWebSockets() {
                return [...sockets].filter((s) => s.readyState === 1);
              },
            };
            if(useSqlite){
              await mkdir(resolve(file,'..'),{recursive:true});
              const {sqliteStorage}=await import('./sqlite-storage.mjs');
              ctx.storage=sqliteStorage(file.replace(/\.json$/,'.sqlite'),metrics,arm);
            }
            objects.set(key, new Class(ctx, env));
            contexts.set(key, ctx);
            const persistedAlarm=await ctx.storage.getAlarm();
            if (persistedAlarm) {
              if (persistedAlarm <= (testControls?testTime:Date.now())) await objects.get(key).alarm();
              else arm(persistedAlarm);
            }
            return objects.get(key);
      })());
    }
    const pending = loading.get(key);
    if (pending) {
      try { return await pending; }
      catch (error) { objects.delete(key); contexts.delete(key); throw error; }
      finally { loading.delete(key); }
    }
    return objects.get(key);
  }
  return {
    idFromName: (name) => name,
    get: (id) => ({ fetch: async (request) => {metrics.doCalls++;return (await load(id)).fetch(request);} }),
    async restore() {
      let files;
      try { files = await readdir(join(data, 'do', name)); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const file of files)
        if ((useSqlite?/^(?:[a-f0-9]{2})+\.sqlite$/:/^(?:[a-f0-9]{2})+\.json$/).test(file))
          await load(Buffer.from(file.replace(/\.(?:sqlite|json)$/, ''), 'hex').toString());
    }
  };
}
env.GROUPS = namespace("groups", GroupRoom);
env.PAIRS = namespace("pairs", PairRoom);
env.GUARDS = namespace("guards", Guard);
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
env.ASSETS = {
  async fetch(request) {
    const url = new URL(request.url),
      path = resolve(
        publicDir,
        "." +
          decodeURIComponent(
            url.pathname === "/" ? "/index.html" : url.pathname,
          ),
      );
    if (!path.startsWith(publicDir)) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(path), {
        headers: {
          "Content-Type":
            {
              ".html": "text/html; charset=utf-8",
              ".css": "text/css",
              ".js": "text/javascript",
              ".svg": "image/svg+xml",
              ".zip": "application/zip",
            }[extname(path)] ?? "application/octet-stream",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  },
};
const upgrades = new Map(),
  wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("kj.v1") ? "kj.v1" : false),
    maxPayload: 1048576,
  });
env.localUpgrade = (ctx, request, attachment) => {
  const key = request.headers.get("X-Local-Upgrade"),
    item = upgrades.get(key);
  if (!item) throw new Error("Upgrade context missing");
  upgrades.delete(key);
  let serverSocket;
  wss.handleUpgrade(item.req, item.socket, item.head, (ws) => {
    ws.serializeAttachment = (v) => {
      ws.attachment = structuredClone(v);
    };
    ws.deserializeAttachment = () => structuredClone(ws.attachment);
    ctx.acceptWebSocket(ws);
    ws.serializeAttachment(attachment);
    serverSocket = ws;
  });
  return { status: 101, localSocket: serverSocket };
};
function toRequest(req, upgrade) {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  headers.delete("CF-Connecting-IP");
  headers.set("CF-Connecting-IP", req.socket.remoteAddress ?? "unknown");
  if (upgrade) headers.set("X-Local-Upgrade", upgrade);
  if (!["GET", "HEAD"].includes(req.method)) {
    req._kjBody = new PassThrough();
    req.pipe(req._kjBody);
  }
  return new Request("http://localhost:" + port + req.url, {
    method: req.method,
    headers,
    ...(!["GET", "HEAD"].includes(req.method)
      ? { body: Readable.toWeb(req._kjBody), duplex: "half" }
      : {}),
  });
}
const server = createServer(async (req, res) => {
  try {
    if(testControls){
      if(req.headers['x-test-clock'])testTime=Number(req.headers['x-test-clock']);
      if(req.url==='/__test/metrics'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...metrics,sqlWrites:metrics.sqlBaseWrites+metrics.sqlIndexWrites}));return;}
      if(req.url==='/__test/tick'){
        for(const[key,ctx]of contexts){const at=await ctx.storage.getAlarm();if(at&&at<=testTime){await ctx.storage.delete('_alarm');await objects.get(key).alarm();}}
        res.writeHead(200);res.end('{}');return;
      }
    }
    metrics.http++;
    const request = toRequest(req),
      r = await handle(request, env);
    if (req._kjBody) {
      req.unpipe(req._kjBody);
      req._kjBody.destroy();
      req.resume();
    }
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      '{"error":{"code":"SERVER_ERROR","message":"Internal server error"}}',
    );
  }
});
server.on("upgrade", async (req, socket, head) => {
  const key = randomBytes(12).toString("hex");
  upgrades.set(key, { req, socket, head });
  try {
    const r = await handle(toRequest(req, key), env);
    if (!r.localSocket) {
      const b = Buffer.from(await r.arrayBuffer());
      socket.end(
        "HTTP/1.1 " +
          r.status +
          " Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " +
          b.length +
          "\r\n\r\n" +
          b,
      );
    }
  } catch {
    socket.destroy();
  } finally {
    upgrades.delete(key);
  }
});
// Restore persisted alarms before serving; dormant rooms must expire after restarts.
for (const namespace of [env.GUARDS, env.GROUPS, env.PAIRS]) await namespace.restore();
server.listen(port, arg("--host", "127.0.0.1"), () =>
  console.log(
    `Kongjing local relay: http://127.0.0.1:${port}; PoW difficulty=${difficulty}; data=${data}`,
  ),
);
