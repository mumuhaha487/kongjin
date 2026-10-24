import { it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import ts from "typescript";

it("rotates snapshot, retained journal, slot and blob in a DOM-free worker with import() forbidden", async () => {
  // Transpile only syntax: Node16 preserves dynamic import expressions. The VM
  // rejects them, whereas static imports are linked by our local module loader.
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const context = createContext({
    crypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    Response, Headers, Blob, CompressionStream, DecompressionStream,
    structuredClone, btoa, atob, URL, URLSearchParams, AbortController, performance, EventTarget, setTimeout, clearTimeout,
    setInterval, clearInterval, console,
  });
  expect(new Script("typeof window + '/' + typeof document").runInContext(context)).toBe("undefined/undefined");
  const denied = () => { throw new Error("import() is disallowed on ServiceWorkerGlobalScope"); };
  // Without --experimental-vm-modules Node itself rejects first; either way
  // dynamic import cannot succeed in this worker host.
  await expect(new Script('import("./forbidden.js")', { importModuleDynamically: denied })
    .runInContext(context)).rejects.toThrow();
  const cache = new Map<string, { exports: any }>();
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file)!.exports;
    const source = readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node)) expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
      if (ts.isIdentifier(node)) expect(node.text).not.toBe("window");
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
    const code = ts.transpileModule(source, { fileName: file.replace(/\.ts$/, ".cts"),
      compilerOptions: { module: ts.ModuleKind.Node16, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    cache.set(file, module);
    const run = new Script("(function(require,module,exports){" + code + "\n})", {
      filename: file, importModuleDynamically: denied,
    }).runInContext(context);
    run((id: string) => load(resolve(dirname(file), id)), module, module.exports);
    return module.exports;
  }
  // Audit every runtime source module, including modules not used by this run.
  for (const file of readdirSync(root).filter(f => f.endsWith(".ts") && !f.endsWith(".worker.ts"))) load(resolve(root, file));
  const api = load(resolve(root, "index.ts"));
  const { KongjingSync, MemorySecretStore, MemoryQueueStore, identity, b64url,
    unb64, deriveGroup, openSnapshot, openJournal, deriveSlotId, openSlot, openBlob, bytesEnvelope } = api;
  const [self, peer, removed] = await Promise.all([identity(), identity(), identity()]);
  const secrets = new MemorySecretStore(), queue = new MemoryQueueStore();
  const oldGk = new Uint8Array(32), old = await deriveGroup(oldGk, 1);
  const members = [self, peer, removed].map((v, i) => ({ deviceId: v.deviceId, pub: v.pub,
    name: String(i), platform: "worker", joinedAt: 1, addedBy: self.deviceId }));
  await secrets.set("identity", self);
  await secrets.set("group", { gk: b64url(oldGk), epoch: 1, members, rev: 0, name: "0", platform: "worker" });
  const rooms = new Map<string, any>();
  const room = (id: string) => {
    if (!rooms.has(id)) rooms.set(id, { rows: [], slots: new Map(), blobs: new Map(), rev: 0 });
    return rooms.get(id);
  };
  class Socket extends EventTarget { readyState = 1; send() {} close() { this.readyState = 3; } }
  const request = async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname, [, , , id, kind, key] = path.split("/");
    if (path === "/v1/groups") return Response.json({ createdAt: Date.now() }, { status: 201 });
    const data = room(id);
    if (kind === "snapshot") {
      if (init.method === "PUT") { data.snapshot = new Uint8Array(init.body as ArrayBuffer); return Response.json({ rev: ++data.rev }); }
      return data.snapshot ? new Response(data.snapshot, { headers: { ETag: '"' + data.rev + '"' } }) : new Response(null, { status: 204 });
    }
    if (kind === "journal") {
      if (init.method === "POST") {
        const seqs = JSON.parse(init.body as string).items.map((item: any) => {
          const found = data.rows.find((r: any) => r.id === item.id);
          if (found) return found.seq;
          const seq = data.rows.length + 1; data.rows.push({ ...item, seq, at: Date.now() }); return seq;
        });
        return Response.json({ seqs, head: data.rows.length });
      }
      const after = Number(new URL(url).searchParams.get("after"));
      return Response.json({ items: data.rows.filter((r: any) => r.seq > after), head: data.rows.length, floor: 1 });
    }
    if (kind === "slots" || kind === "blobs") {
      const store = data[kind];
      if (init.method === "PUT") { store.set(key, new Uint8Array(init.body as ArrayBuffer)); return Response.json({}); }
      return key ? new Response(store.get(key)) : Response.json({ slots: [] });
    }
    if (kind === "forward") { data.forward = JSON.parse(init.body as string); return Response.json({}); }
    if (init.method === "DELETE") { data.retired = true; return Response.json({}); }
    throw Error("Unexpected route " + path);
  };
  const local = { settings: { background: {} }, bookmarks: ["retained"] };
  const client = new KongjingSync({ relayUrl: "https://relay.example", secrets, queueStore: queue,
    loadLocal: async () => local, saveMerged: async () => {}, merge: (a: unknown) => a,
    WebSocket: Socket, fetch: request });
  try {
    await client.init();
    client.journalAppend("hv", { v: [{ u: "https://retained.example/", ti: "Retained title", at: Date.now() }] });
    await client.syncNow();
    await client.putSlot({ windows: [{ tabs: [{ u: "https://retained.example/" }] }] });
    const blob = await client.putBlob(new Uint8Array([1, 2, 3, 4]), "image/webp");
    await client.removeDevice(removed.deviceId);
    const group = await secrets.get("group"), next = await deriveGroup(unb64(group.gk), 2), data = room(next.roomId);
    expect(client.status().epoch).toBe(2);
    expect(group.members.map((m: any) => m.deviceId)).toEqual([self.deviceId, peer.deviceId]);
    expect((await openSnapshot(next.encKey, next.roomId, data.snapshot)).data).toEqual(local);
    const journal = await Promise.all(data.rows.map((r: any) => openJournal(next.encKey, next.roomId, r.id, r.env)));
    expect(journal.find((r: any) => r.t === "hv").v[0].ti).toBe("Retained title");
    const slotId = await deriveSlotId(unb64(group.gk), 2, self.deviceId);
    expect((await openSlot(next.encKey, next.roomId, slotId, bytesEnvelope(data.slots.get(slotId)))).windows).toHaveLength(1);
    expect(await openBlob(next.encKey, next.roomId, blob.blobId, data.blobs.get(blob.blobId))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(room(old.roomId).retired).toBe(true);
    await expect(openSnapshot(old.encKey, next.roomId, data.snapshot)).rejects.toThrow();
    expect((await queue.get("continuity/" + self.deviceId + "/" + next.roomId)).blobs).toContain(blob.blobId);
  } finally { client.dispose(); }
}, 15000);
