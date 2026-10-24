// Node-only round 2 regression. Never runs against a remote relay.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { KongjingSync, MemorySecretStore } from "../src/index.ts";

const base = process.argv[2] ?? "http://127.0.0.1:8792";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
// Use the relay's existing Node WebSocket dependency, with no browser imports.
const require = createRequire(new URL("../../../relay/package.json", import.meta.url));
const WebSocket = require("ws") as typeof globalThis.WebSocket;
const names = ["MacBook · Chrome", "工作机 B", "Android · Chrome"],
  platforms = ["macOS · Chrome", "Windows · Edge", "Android · Chrome"],
  stores = names.map(() => new MemorySecretStore()),
  rooms = new Map<string, string>(),
  checks: string[] = [],
  pairings: { inviter: string; joiner: string; inviterName: string; platform: string; sasMatches: boolean }[] = [];
type Data = { updatedAt: number; bookmarks: { url: string; title: string }[] };
const local: Data[] = names.map(() => ({ updatedAt: 1, bookmarks: [] }));
const privateUrl = "https://round2-" + Date.now().toString(36) + ".example/bookmark",
  privateTitle = "hello-i 邀请方名称私密测试";
const transport: typeof fetch = async (url, init = {}) => {
  const room = /\/v1\/groups\/([\w-]{32})/.exec(new URL(String(url)).pathname)?.[1],
    token = new Headers(init.headers).get("X-KJ-Token");
  if (room && token) rooms.set(room, token);
  return fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
};
const make = (i: number) => new KongjingSync<Data>({
  relayUrl: base, secrets: stores[i], WebSocket, fetch: transport,
  loadLocal: async () => local[i], saveMerged: async data => { local[i] = data; },
  merge: (a, b) => a.updatedAt >= b.updatedAt ? a : b,
});
const devices = names.map((_, i) => make(i));
const wait = async (fn: () => boolean, ms = 15000) => {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() >= until) throw new Error("Condition timeout");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
async function pair(i: number, j: number) {
  const invite = await devices[i].invite(),
    peer = new Promise<{ name: string; platform: string; sas: string }>(resolve => invite.onPeer(resolve)),
    join = await devices[j].join(invite.code, names[j], platforms[j]);
  const [a, b] = await Promise.all([peer, join.sas]);
  assert.equal(a.sas, b.sas);
  assert.equal(a.name, names[j]);
  assert.equal(a.platform, platforms[j]);
  assert.equal(b.inviterName, names[i]);
  assert.equal(b.platform, platforms[i]);
  pairings.push({ inviter: "ABC"[i], joiner: "ABC"[j],
    inviterName: b.inviterName, platform: b.platform, sasMatches: a.sas === b.sas });
  await join.confirm();
  await invite.confirm();
  await Promise.all([invite.done, join.done]);
  await wait(() => devices[j].status().connection === "online");
}
async function step(name: string, run: () => Promise<void>) {
  await run(); checks.push(name); console.log("PASS " + name);
}
const summary = { timestamp: new Date().toISOString(), base, checks, pairings,
  result: "running", aToBms: 0, residualRooms: [] as string[], error: undefined as string | undefined };
try {
  await Promise.all(devices.map(d => d.init()));
  await step("A creates group; B pairs; SAS and inviter labels match", async () => {
    await devices[0].createGroup(names[0], platforms[0]);
    await pair(0, 1);
  });
  await step("A data reaches B within 5 seconds", async () => {
    const at = Date.now();
    local[0] = { updatedAt: at, bookmarks: [{ url: privateUrl, title: privateTitle }] };
    devices[0].notifyLocalChange();
    await wait(() => local[1].bookmarks[0]?.url === privateUrl, 5000);
    summary.aToBms = Date.now() - at;
  });
  await step("C joins through B with B's authenticated labels; C data reaches A", async () => {
    await pair(1, 2);
    local[2] = { updatedAt: Date.now(), bookmarks: [{ url: privateUrl, title: privateTitle + "-C" }] };
    devices[2].notifyLocalChange();
    await wait(() => local[0].bookmarks[0]?.title === privateTitle + "-C", 5000);
  });
  await step("A removes C; A/B rotate; C is removed and cannot read new data", async () => {
    let removed = false;
    devices[2].on("removed", () => { removed = true; });
    await devices[0].removeDevice(devices[2].status().devices.find(d => d.self)!.deviceId);
    await wait(() => removed && devices[1].status().epoch === 2);
    assert.equal(devices[2].status().paired, false);
    local[0] = { updatedAt: Date.now(), bookmarks: [{ url: privateUrl, title: privateTitle + "-rotated" }] };
    await devices[0].syncNow();
    await wait(() => local[1].bookmarks[0]?.title === privateTitle + "-rotated");
    assert.notEqual(local[2].bookmarks[0]?.title, privateTitle + "-rotated");
  });
  await step("B offline during second rotation; forwarding restores B on restart", async () => {
    devices[1].dispose();
    await pair(0, 2);
    devices[1] = make(1);
    await devices[1].init();
    await wait(() => devices[1].status().devices.length === 3);
    devices[1].dispose();
    await devices[0].removeDevice(devices[2].status().devices.find(d => d.self)!.deviceId);
    devices[1] = make(1);
    await devices[1].init();
    await wait(() => devices[1].status().epoch === 3 && devices[1].status().connection === "online");
  });
  await step("snapshot bytes contain no test bookmark URL or title", async () => {
    let snapshots = 0;
    for (const [room, token] of rooms) {
      const r = await transport(base + "/v1/groups/" + room + "/snapshot", { headers: { "X-KJ-Token": token } });
      if (r.status === 410) continue;
      assert.equal(r.status, 200);
      snapshots++;
      const raw = Buffer.from(await r.arrayBuffer());
      assert.equal(raw.includes(Buffer.from(privateUrl)), false);
      assert.equal(raw.includes(Buffer.from(privateTitle)), false);
    }
    assert.ok(snapshots > 0);
  });
  summary.result = "passed";
} catch (e) {
  summary.result = "failed";
  summary.error = e instanceof Error ? e.message : String(e);
  console.error(summary.error);
  process.exitCode = 1;
} finally {
  devices.forEach(d => d.dispose());
  for (const [room, token] of rooms) {
    try {
      const r = await transport(base + "/v1/groups/" + room, { method: "DELETE", headers: { "X-KJ-Token": token } });
      if (r.status !== 204) summary.residualRooms.push(room);
    } catch { summary.residualRooms.push(room); }
  }
  if (summary.residualRooms.length) { summary.result = "failed"; process.exitCode = 1; }
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await writeFile(new URL("../artifacts/round2-local-e2e.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");
  console.log(`${summary.result.toUpperCase()} ${checks.length}/6; residualRooms=${summary.residualRooms.length}`);
}
