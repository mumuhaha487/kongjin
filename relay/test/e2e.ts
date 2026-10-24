import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  KongjingSync,
  MemorySecretStore,
} from "../../shared/protocol/src/index.ts";
import { network } from "../scripts/network.mjs";
const base = process.argv[2] ?? "http://127.0.0.1:8790",
  proxy = process.argv.includes("--proxy")
    ? process.argv[process.argv.indexOf("--proxy") + 1]
    : undefined;
let lastRequest: any;
const client = network(proxy),
  rooms = new Map<string, string>(),
  checks: string[] = [],
  pairings: { inviter: string; joiner: string; inviterName: string; platform: string; sasMatches: boolean }[] = [],
  names = ["MacBook · Chrome", "工作机 B", "Android · Chrome"],
  platforms = ["macOS · Chrome", "Windows · Edge", "Android · Chrome"],
  stores = [
    new MemorySecretStore(),
    new MemorySecretStore(),
    new MemorySecretStore(),
  ];
const id = Date.now().toString(36),
  privateUrl = "https://private-" + id + ".example/bookmark",
  privateTitle = "空境私密测试-" + id;
type Data = { updatedAt: number; bookmarks: { url: string; title: string }[] };
let local: Data[] = Array.from({ length: 3 }, () => ({
  updatedAt: 1,
  bookmarks: [],
}));
const transport = async (url: any, init: any = {}) => {
  const path = new URL(String(url)).pathname,
    m = /\/v1\/groups\/([\w-]{32})/.exec(path),
    token = new Headers(init.headers).get("X-KJ-Token");
  if (m && token) rooms.set(m[1], token);
  const r = await client.fetch(url, init);
  lastRequest = { path, method: init.method ?? "GET", status: r.status };
  return r;
};
let delayedJoin = false;
const make = (i: number) =>
  new KongjingSync<Data>({
    relayUrl: base,
    secrets: stores[i],
    loadLocal: async () => local[i],
    saveMerged: async (d) => {
      local[i] = d;
    },
    merge: (a, b) => (a.updatedAt >= b.updatedAt ? a : b),
    fetch: (async (url: any, init: any) => {
      if (
        i === 1 &&
        process.argv.includes("--slow-join") &&
        !delayedJoin &&
        String(url).endsWith("/snapshot")
      ) {
        delayedJoin = true;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return transport(url, init);
    }) as any,
    WebSocket: client.WebSocket as any,
  });
let devices = [make(0), make(1), make(2)];
const wait = async (fn: () => boolean, ms = 15000) => {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error("Condition timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const step = async (name: string, fn: () => Promise<void>) => {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
};
async function pair(inviter: number, joiner: number) {
  const invite = await devices[inviter].invite(),
    peer = new Promise<any>((resolve) => invite.onPeer(resolve)),
    join = await devices[joiner].join(
      invite.code,
      names[joiner],
      platforms[joiner],
    );
  const [a, b] = await Promise.all([peer, join.sas]);
  assert.equal(a.sas, b.sas);
  assert.equal(a.name, names[joiner]);
  assert.equal(a.platform, platforms[joiner]);
  assert.equal(b.inviterName, names[inviter]);
  assert.equal(b.platform, platforms[inviter]);
  pairings.push({ inviter: "ABC"[inviter], joiner: "ABC"[joiner],
    inviterName: b.inviterName, platform: b.platform, sasMatches: a.sas === b.sas });
  await join.confirm();
  await invite.confirm();
  await Promise.all([invite.done, join.done]);
  await wait(() => devices[joiner].status().connection === "online");
}
const summary: any = {
  timestamp: new Date().toISOString(),
  base,
  mode: proxy ? "proxy" : "direct",
  checks,
  pairings,
  result: "running",
  residualRooms: [],
};
try {
  await Promise.all(devices.map((d) => d.init()));
  await step("A creates group; B pairs; SAS matches", async () => {
    await devices[0].createGroup(names[0], platforms[0]);
    await pair(0, 1);
  });
  await step("A data reaches B within 5 seconds", async () => {
    const at = Date.now();
    local[0] = {
      updatedAt: at,
      bookmarks: [{ url: privateUrl, title: privateTitle }],
    };
    devices[0].notifyLocalChange();
    await wait(() => local[1].bookmarks[0]?.url === privateUrl, 5000);
    summary.aToBms = Date.now() - at;
  });
  await step("C joins through B; C data reaches A", async () => {
    await pair(1, 2);
    local[2] = {
      updatedAt: Date.now(),
      bookmarks: [{ url: privateUrl, title: privateTitle + "-C" }],
    };
    devices[2].notifyLocalChange();
    await wait(
      () => local[0].bookmarks[0]?.title === privateTitle + "-C",
      5000,
    );
  });
  await step(
    "A removes C; A/B rotate; C removed and cannot read new data",
    async () => {
      const c = devices[2].status().devices.find((d) => d.self)!.deviceId;
      let removed = false;
      devices[2].on("removed", () => (removed = true));
      await devices[0].removeDevice(c);
      await wait(() => removed && devices[1].status().epoch === 2);
      assert.equal(devices[2].status().paired, false);
      local[0] = {
        updatedAt: Date.now(),
        bookmarks: [{ url: privateUrl, title: privateTitle + "-rotated" }],
      };
      await devices[0].syncNow();
      await wait(
        () => local[1].bookmarks[0]?.title === privateTitle + "-rotated",
      );
      assert.notEqual(local[2].bookmarks[0]?.title, privateTitle + "-rotated");
    },
  );
  await step(
    "B offline during second rotation; forwarding restores B on restart",
    async () => {
      devices[1].dispose();
      await pair(0, 2);
      devices[1] = make(1);
      await devices[1].init();
      await wait(() => devices[1].status().devices.length === 3);
      devices[1].dispose();
      const c = devices[2].status().devices.find((d) => d.self)!.deviceId;
      await devices[0].removeDevice(c);
      devices[1] = make(1);
      await devices[1].init();
      await wait(
        () =>
          devices[1].status().epoch === 3 &&
          devices[1].status().connection === "online",
      );
    },
  );
  await step(
    "stored/served snapshot bytes contain no test URL or title",
    async () => {
      for (const [room, token] of rooms) {
        const r = await transport(base + "/v1/groups/" + room + "/snapshot", {
          headers: { "X-KJ-Token": token },
        });
        if (r.status === 200) {
          const raw = Buffer.from(await r.arrayBuffer());
          assert.equal(raw.includes(Buffer.from(privateUrl)), false);
          assert.equal(raw.includes(Buffer.from(privateTitle)), false);
        }
      }
      if (base.startsWith("https://kongjing.inc.re")) {
        const { checkR2 } = await import("../scripts/r2.mjs");
        summary.r2 = await checkR2(
          [...rooms.keys()],
          [privateUrl, privateTitle],
        );
      }
    },
  );
  summary.result = "passed";
} catch (e) {
  summary.result = "failed";
  summary.error = e instanceof Error ? e.message : "E2E failed";
  summary.retryAfter = (e as any)?.retryAfter;
  summary.errorCode = (e as any)?.code;
  summary.lastRequest = lastRequest;
  console.error("lastRequest", lastRequest);
  summary.cause = (e as any)?.cause?.code;
  console.error(summary.error);
  for (const [i, d] of devices.entries())
    console.error("device", i, JSON.stringify(d.status()));
  process.exitCode = 1;
} finally {
  for (const d of devices) d.dispose();
  for (const [room, token] of rooms) {
    try {
      const r = await transport(base + "/v1/groups/" + room, {
        method: "DELETE",
        headers: { "X-KJ-Token": token },
      });
      if (![204, 404].includes(r.status)) summary.residualRooms.push(room);
    } catch {
      summary.residualRooms.push(room);
    }
  }
  if (base.startsWith("https://kongjing.inc.re") && rooms.size > 0) {
    try {
      const { cleanR2 } = await import("../scripts/r2.mjs");
      summary.r2Cleanup = await cleanR2([...rooms.keys()]);
    } catch (e) {
      summary.cleanupError =
        e instanceof Error ? e.message : "R2 cleanup failed";
      process.exitCode = 1;
    }
  }
  if (summary.residualRooms.length || summary.cleanupError) {
    summary.result = "failed";
    process.exitCode = 1;
  }
  await client.close();
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await writeFile(
    new URL(
      "../artifacts/" + (process.argv.includes("--final") ? "final-" : "") + "e2e-" +
        (!base.includes("kongjing.inc.re") && !base.includes("8791")
          ? "local"
          : base.includes("8791")
            ? "worker"
            : proxy
              ? "proxy"
              : "direct") +
        ".json",
      import.meta.url,
    ),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(
    summary.result.toUpperCase() +
      " " +
      checks.length +
      " checks; residualRooms=" +
      summary.residualRooms.length,
  );
}
