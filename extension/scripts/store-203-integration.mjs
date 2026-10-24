import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { launchExtension } from "./browser.mjs";

// No online mode: unmodified, keyless release ZIP -> CORS-only loopback proxy
// -> the actual relay/local server on 8790. No application or protocol mocks.
process.env.KJ_BLOCK_ONLINE_RELAY = "1";
const dir = await mkdtemp(resolve("tests/.store-203-"));
const relay = "http://127.0.0.1:8790",
  proxyUrl = "http://127.0.0.1:8791";
const contexts = [],
  pages = [],
  allowedOrigins = new Set(),
  proxySockets = new Set();
const result = {
  passed: false,
  online: false,
  relay,
  proxyUrl,
  checks: [],
  errors: [],
  requests: [],
  profiles: [],
};
let server,
  proxy,
  serverLog = "";
const cmd = (page, action, args = {}) =>
  page.evaluate(
    ({ action, args }) =>
      chrome.runtime.sendMessage({ type: "kj:pair", action, args }),
    { action, args },
  );
async function poll(read, accept, label, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (value?.pair?.view === "failure")
      throw Error(label + ": " + value.pair.error);
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(label + " timed out");
}
const members = (s) =>
  s.status.devices
    .map((d) => [d.deviceId, d.name, d.platform])
    .sort((a, b) => a[0].localeCompare(b[0]));
try {
  const zip = await readFile("../release/store/kongjing-2.0.3-store.zip"),
    entries = unzipSync(zip);
  result.zipSha256 = createHash("sha256").update(zip).digest("hex");
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
  assert.equal(manifest.version, "2.0.3");
  assert.equal("key" in manifest, false);
  result.permissions = manifest.permissions;
  result.hostPermissions = manifest.host_permissions;
  result.previousArchives = {};
  for (const [version, expected] of Object.entries({
    "2.0.1": "d4c4360476b1ec4dc02e8c6ed921c8065233b44716f40256f37d2954c6db93ca",
    "2.0.2": "87432f29cf5dbb064779de4ac9a8219af2df43ccfacdce135787cb7f8dfea92d",
  })) {
    const old = await readFile(
      `../release/store/kongjing-${version}-store.zip`,
    );
    assert.equal(createHash("sha256").update(old).digest("hex"), expected);
    const previous = JSON.parse(
      Buffer.from(unzipSync(old)["manifest.json"]).toString(),
    );
    for (const field of [
      "permissions",
      "host_permissions",
      "optional_permissions",
      "optional_host_permissions",
      "content_scripts",
      "key",
    ])
      assert.deepEqual(
        manifest[field],
        previous[field],
        version + ": " + field,
      );
    result.previousArchives[version] = {
      sha256: expected,
      samePermissions: true,
      unchanged: true,
    };
  }
  const extension = resolve(dir, "extension");
  for (const [path, bytes] of Object.entries(entries)) {
    assert.ok(!path.startsWith("/") && !path.split("/").includes(".."));
    await mkdir(dirname(resolve(extension, path)), { recursive: true });
    await writeFile(resolve(extension, path), bytes);
  }
  result.checks.push(
    "Original 2.0.3 ZIP loaded without changing manifest/key/permissions or JavaScript; permissions equal 2.0.1/2.0.2; old ZIP hashes unchanged",
  );
  const existing = await fetch(relay + "/v1/health")
    .then((r) => r.json())
    .catch(() => null);
  if (existing) {
    assert.equal(existing.service, "kongjing-relay");
    assert.equal(existing.ok, true);
    result.relayOwnership =
      "Existing local relay reused only for fresh test identities/group; no server/config changes or shutdown";
  } else {
    server = spawn(
      process.execPath,
      [
        "../relay/local/server.mjs",
        "--port",
        "8790",
        "--pow",
        "0",
        "--data",
        resolve(dir, "relay"),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout.on("data", (b) => {
      serverLog += b;
    });
    server.stderr.on("data", (b) => {
      serverLog += b;
    });
    result.relayOwnership =
      "Isolated relay/local server started and stopped by this script";
  }
  await poll(
    () =>
      fetch(relay + "/v1/health")
        .then((r) => r.ok)
        .catch(() => false),
    Boolean,
    "relay",
    15000,
  );

  // The development relay's CORS list only includes the fixed self-use ID.
  // Extend response CORS solely for these random store IDs in the test proxy.
  // Forward bodies, tokens, encrypted frames and all protocol responses unchanged.
  proxy = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      assert.ok(
        !origin || allowedOrigins.has(origin),
        "unexpected test origin",
      );
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(relay + req.url, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(
            ([k]) => !["host", "connection", "content-length"].includes(k),
          ),
        ),
        ...(!["GET", "HEAD"].includes(req.method)
          ? { body: Buffer.concat(chunks) }
          : {}),
      });
      result.requests.push({
        method: req.method,
        path: req.url,
        status: response.status,
      });
      res.statusCode = response.status;
      for (const [key, value] of response.headers)
        if (
          ![
            "transfer-encoding",
            "content-encoding",
            "content-length",
            "connection",
          ].includes(key)
        )
          res.setHeader(key, value);
      if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      result.errors.push(String(error));
      res.writeHead(502).end();
    }
  });
  proxy.on("upgrade", (req, socket, head) => {
    if (!allowedOrigins.has(req.headers.origin)) {
      socket.destroy();
      return;
    }
    const upstream = connect(8790, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
          req.rawHeaders.reduce(
            (s, h, i, a) => s + (i % 2 ? "" : h + ": " + a[i + 1] + "\r\n"),
            "",
          ) +
          "\r\n",
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    proxySockets.add(socket);
    proxySockets.add(upstream);
    for (const s of [socket, upstream]) {
      s.on("close", () => proxySockets.delete(s));
      s.on("error", () => {
        socket.destroy();
        upstream.destroy();
      });
    }
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(8791, "127.0.0.1", resolve);
  });
  for (const name of ["商店电脑 A", "商店电脑 B"]) {
    const context = await launchExtension(resolve(dir, name), extension);
    contexts.push(context);
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).hostname;
    allowedOrigins.add("chrome-extension://" + id);
    result.profiles.push({ name, id });
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (e) => result.errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") result.errors.push(m.text());
    });
    await page.goto("chrome://newtab");
    await page.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
    assert.ok(page.url().startsWith(`chrome-extension://${id}/`));
    assert.equal(
      await page.evaluate(() => chrome.runtime.getManifest().key),
      undefined,
    );
    await cmd(page, "relay", { url: proxyUrl });
    await page.evaluate(async () => {
      window.__pairFailures = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (m.type === "kj:status" && m.pair?.view === "failure")
          window.__pairFailures.push(m.pair.error);
      });
      const { data } = await chrome.storage.local.get("data");
      data.bookmarks.forEach((b) => {
        b.icon = { mode: "letter" };
      });
      await chrome.storage.local.set({ data });
    });
  }
  const [a, b] = pages;
  await a.waitForTimeout(500);
  await cmd(a, "create", { name: "商店电脑 A" });
  const invitation = await poll(
    () => cmd(a, "status"),
    (s) => s.pair.view === "invite",
    "invite",
  );
  await b.getByRole("button", { name: "设置", exact: true }).click();
  await b.getByRole("button", { name: "加入已有配对组", exact: true }).click();
  await b.getByLabel("配对码", { exact: true }).fill(invitation.pair.code);
  await b.getByLabel("本机名称", { exact: true }).fill("商店电脑 B");
  await b.getByRole("button", { name: "连接", exact: true }).click();
  await b.getByRole("heading", { name: "核对安全码", exact: true }).waitFor();
  const sas = await poll(
    () => cmd(a, "status"),
    (s) => s.pair.view === "sas",
    "SAS",
  );
  assert.equal(
    (await b.locator(".sas-code").innerText()).replace(/\s/g, ""),
    sas.pair.sas.replace(/\s/g, ""),
  );
  assert.equal(
    await b.locator(".pair-content .help").innerText(),
    "对方设备：商店电脑 A",
  );
  const start = Date.now();
  await Promise.all([
    cmd(a, "confirm"),
    b.getByRole("button", { name: "一致", exact: true }).click(),
  ]);
  const states = await Promise.all(
    pages.map((p) =>
      poll(
        () => cmd(p, "status"),
        (s) => s.pair.view === "success" && s.status.devices.length === 2,
        "done",
      ),
    ),
  );
  assert.deepEqual(members(states[0]), members(states[1]));
  result.joinMs = Date.now() - start;
  result.checks.push(
    "B enters invitation in real store UI, equal SAS/real inviter name; both done succeed; equal two-member lists, no NETWORK",
  );
  await b.locator(".pair-content").waitFor({ state: "detached" });
  await b.getByRole("button", { name: "关闭设置", exact: true }).click();
  await b.evaluate(async () => {
    const { data } = await chrome.storage.local.get("data");
    data.profile = { nickname: "商店2.0.3本地同步", updatedAt: Date.now() };
    await chrome.storage.local.set({ data });
  });
  await cmd(b, "sync");
  await a.waitForFunction(
    async () =>
      (await chrome.storage.local.get("data")).data.profile.nickname ===
      "商店2.0.3本地同步",
    undefined,
    { timeout: 30000 },
  );
  result.checks.push(
    "Existing encrypted snapshot sync works after joining; B profile update arrives at A",
  );
  await b.waitForTimeout(1500);
  for (const page of pages)
    assert.deepEqual(await page.evaluate(() => window.__pairFailures), []);
  assert.deepEqual(result.errors, []);
  assert.ok(
    !result.requests.some((r) =>
      /\/(journal|slots|blobs|incoming)(?:[/?]|$)/.test(r.path),
    ),
  );
  result.checks.push(
    "Only existing pairing/snapshot APIs used, no continuity requests; no console/page/CSP errors; online relay blocked",
  );
  result.passed = true;
} catch (error) {
  result.failure = String(error);
  result.states = await Promise.all(
    pages.map((p) => cmd(p, "status").catch(() => null)),
  );
  throw error;
} finally {
  for (const page of [...pages].reverse()) {
    const state = await cmd(page, "status").catch(() => null);
    if (state?.status?.paired) await cmd(page, "leave").catch(() => {});
  }
  for (const context of contexts) await context.close();
  for (const socket of proxySockets) socket.destroy();
  if (proxy?.listening) await new Promise((r) => proxy.close(r));
  server?.kill();
  await writeFile(resolve(dir, "relay.log"), serverLog);
  await writeFile(
    "tests/store-203-integration-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
