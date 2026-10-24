import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { launchChrome, launchExtension } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import { mobileOptions, nativeMock, bridgeCall } from "./android-fixtures.mjs";

process.env.KJ_BLOCK_ONLINE_RELAY = "1";
const store = process.argv.includes("--store");
const homeOnly = process.argv.includes("--home-only");
const relay = "http://127.0.0.1:8790";
const dir = await mkdtemp(resolve("tests/.removed-notice-214-"));
const result = {
  passed: false,
  online: false,
  store,
  relay,
  checks: [],
  screenshots: [],
  errors: [],
};
const contexts = [],
  allowedOrigins = new Set(),
  sockets = new Set();
let server,
  proxy,
  home,
  browser,
  a,
  b,
  phone,
  log = "";
const cmd = (p, action, args = {}) =>
  p.evaluate(
    ({ action, args }) =>
      chrome.runtime.sendMessage({ type: "kj:pair", action, args }),
    { action, args },
  );
async function poll(fn, accept, label, timeout = 30000) {
  const at = Date.now();
  let value;
  while (Date.now() - at < timeout) {
    value = await fn();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error(label + " timed out: " + JSON.stringify(value));
}
async function settings(p, mobile = false) {
  if (await p.locator(".settings-panel").count()) return;
  if (mobile) {
    await p.waitForFunction(() => typeof window.kongjing?.call === "function");
    await bridgeCall(p, "openSettings", { section: "pairing" });
  } else await p.getByRole("button", { name: "设置", exact: true }).click();
}
async function closeSettings(p) {
  if (await p.locator(".settings-panel").count()) {
    await p.getByRole("button", { name: "关闭设置", exact: true }).click();
    await p.locator(".settings-panel").waitFor({ state: "detached" });
  }
}
async function invitation(first = false) {
  await cmd(
    a,
    first ? "create" : "invite",
    first ? { name: "通知测试电脑 A" } : {},
  );
  return (
    await poll(
      () => cmd(a, "status"),
      (s) => s.pair.view === "invite",
      "invitation",
    )
  ).pair.code;
}
async function join(p, name, code) {
  await settings(p, p === phone);
  await p.getByRole("button", { name: "加入已有配对组", exact: true }).click();
  await p.getByLabel("配对码", { exact: true }).fill(code);
  await p.getByLabel("本机名称", { exact: true }).fill(name);
  await p.getByRole("button", { name: "连接", exact: true }).click();
  await p.getByRole("heading", { name: "核对安全码", exact: true }).waitFor();
  const sas = await poll(
    () => cmd(a, "status"),
    (s) => s.pair.view === "sas",
    "SAS",
  );
  assert.equal(
    (await p.locator(".sas-code").innerText()).replace(/\s/g, ""),
    sas.pair.sas.replace(/\s/g, ""),
  );
  await Promise.all([
    cmd(a, "confirm"),
    p.getByRole("button", { name: "一致", exact: true }).click(),
  ]);
  await p.getByRole("heading", { name: "配对成功", exact: true }).waitFor();
  await p.locator(".pair-content").waitFor({ state: "detached" });
  await closeSettings(p);
}
async function remove(name) {
  await settings(a);
  await a
    .locator(".device-row")
    .filter({ hasText: name })
    .getByRole("button", { name: "移除", exact: true })
    .click();
  await a.getByRole("button", { name: "移除", exact: true }).last().click();
}
async function shot(p, name) {
  if (homeOnly && !["desktop-home", "android-home"].includes(name)) return;
  await p.mouse.move(8, 8);
  await p.waitForTimeout(650);
  if (await p.locator(".settings-panel").count()) {
    await p
      .locator("#settings-pairing")
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await p
      .locator(".settings-panel")
      .evaluate((el) => el.focus({ preventScroll: true }));
  }
  const path =
    "../docs/v4-continuity/screenshots/removed-notice-" + name + ".png";
  await p.screenshot({ path });
  result.screenshots.push(path);
}
async function verify(p, label) {
  await p.bringToFront();
  const toast = p.locator(".toast").filter({ hasText: "本设备已被移出配对组" });
  await toast.waitFor();
  assert.equal(await toast.locator("svg.lucide-shield-off").count(), 1);
  assert.equal(await toast.locator("svg.lucide-check").count(), 0);
  const icon = toast.locator("svg.lucide-shield-off");
  assert.equal(await icon.getAttribute("width"), "16");
  assert.equal(await icon.getAttribute("height"), "16");
  const colors = await p.evaluate(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    const actual = {};
    for (const theme of ["light", "dark"]) {
      root.dataset.theme = theme;
      actual[theme] = getComputedStyle(
        document.querySelector(".toast .lucide-shield-off"),
      ).color;
    }
    if (before === undefined) delete root.dataset.theme;
    else root.dataset.theme = before;
    return actual;
  });
  assert.deepEqual(colors, {
    light: "rgb(201, 138, 18)",
    dark: "rgb(255, 200, 107)",
  });
  result.checks.push(
    label +
      ": removed Toast is ShieldOff16px (no Check), light/dark warning colors correct",
  );
  assert.deepEqual(
    await toast.evaluate((el) => ({
      display: getComputedStyle(el).display,
      height: getComputedStyle(el).height,
      position: getComputedStyle(el.parentElement).position,
    })),
    { display: "flex", height: "40px", position: "fixed" },
    "Common Toast styles must survive store exclusion",
  );
  const start = Date.now();
  await shot(p, label + "-home");
  assert.equal(await p.locator(".sync-status").innerText(), "仅本机");
  await settings(p, p === phone);
  const card = p.locator(".removed-notice");
  await card.waitFor();
  assert.equal(
    await card.locator("strong").innerText(),
    "本设备已被移出配对组",
  );
  assert.ok(
    (await card.locator("p").innerText()).endsWith(
      "。书签和设置已保留在本机，不会再同步到其他设备。",
    ),
  );
  const visual = await card.evaluate((el) => ({
    padding: getComputedStyle(el).padding,
    radius: getComputedStyle(el).borderRadius,
    titleSize: getComputedStyle(el.querySelector("strong")).fontSize,
    titleWeight: getComputedStyle(el.querySelector("strong")).fontWeight,
    bodySize: getComputedStyle(el.querySelector("p")).fontSize,
    iconWidth: el.querySelector("svg").getAttribute("width"),
  }));
  assert.deepEqual(visual, {
    padding: "16px",
    radius: "20px",
    titleSize: "14px",
    titleWeight: "600",
    bodySize: "12px",
    iconWidth: "18",
  });
  await shot(p, label + "-settings");
  await p.waitForTimeout(Math.max(0, 5000 - (Date.now() - start)));
  assert.equal(await toast.count(), 1, "Toast persists for at least5s");
  await toast.waitFor({ state: "detached", timeout: 3000 });
  result.checks.push(
    label +
      ": notice card + only-local footer + once-only6000ms Toast; card visual tokens verified",
  );
  // Repeated status refreshes and a full page reload must retain the notice,
  // but never replay the already claimed Toast.
  if (p !== phone) {
    for (let i = 0; i < 12; i++) await cmd(p, "status");
    assert.equal(await card.count(), 1);
  }
  await p.reload();
  await p.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  await settings(p, p === phone);
  await card.waitFor();
  await p.waitForTimeout(1200);
  assert.equal(await toast.count(), 0);
  await card.getByRole("button", { name: "知道了", exact: true }).click();
  await card.waitFor({ state: "detached" });
  await p.reload();
  await p.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  await settings(p, p === phone);
  await p.waitForTimeout(800);
  assert.equal(await card.count(), 0);
  assert.equal(await p.locator(".sync-status").innerText(), "仅本机");
  result.checks.push(
    label +
      ": retained after status/reload, no repeated Toast; acknowledgement persists after reload; bookmarks/settings retained",
  );
}
try {
  await mkdir("../docs/v4-continuity/screenshots", { recursive: true });
  const healthy = await fetch(relay + "/v1/health")
    .then((r) => r.ok)
    .catch(() => false);
  if (!healthy) {
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
    server.stdout.on("data", (b) => (log += b));
    server.stderr.on("data", (b) => (log += b));
    await poll(
      () =>
        fetch(relay + "/v1/health")
          .then((r) => r.ok)
          .catch(() => false),
      Boolean,
      "local relay",
    );
  }
  result.reusedRelay = healthy;
  let path = resolve("dist"),
    url = relay;
  if (store) {
    const zip = await readFile("../release/store/kongjing-2.0.4-store.zip"),
      entries = unzipSync(zip);
    const manifest = JSON.parse(
      Buffer.from(entries["manifest.json"]).toString(),
    );
    assert.equal(manifest.version, "2.0.4");
    assert.equal("key" in manifest, false);
    result.zipSha256 = createHash("sha256").update(zip).digest("hex");
    result.permissions = manifest.permissions;
    result.hostPermissions = manifest.host_permissions;
    result.previousArchives = {};
    for (const version of ["2.0.1", "2.0.2", "2.0.3"]) {
      const old = await readFile(
        "../release/store/kongjing-" + version + "-store.zip",
      );
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
        assert.deepEqual(manifest[field], previous[field]);
      result.previousArchives[version] = {
        sha256: createHash("sha256").update(old).digest("hex"),
        samePermissions: true,
      };
    }
    path = resolve(dir, "extension");
    for (const [file, bytes] of Object.entries(entries)) {
      assert.ok(!file.startsWith("/") && !file.split("/").includes(".."));
      await mkdir(dirname(resolve(path, file)), { recursive: true });
      await writeFile(resolve(path, file), bytes);
    }
    proxy = createServer(async (req, res) => {
      try {
        const origin = req.headers.origin;
        assert.ok(!origin || allowedOrigins.has(origin));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const upstream = await fetch(relay + req.url, {
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
        res.statusCode = upstream.status;
        for (const [k, v] of upstream.headers)
          if (
            ![
              "transfer-encoding",
              "content-encoding",
              "content-length",
              "connection",
            ].includes(k)
          )
            res.setHeader(k, v);
        if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (e) {
        result.errors.push(String(e));
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
      for (const s of [socket, upstream]) {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
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
    url = "http://127.0.0.1:8791";
  }
  const workers = [];
  for (const name of ["A", "B"]) {
    const context = await launchExtension(
      resolve(dir, "profile-" + name),
      path,
    );
    contexts.push(context);
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    workers.push(worker);
    const id = new URL(worker.url()).hostname;
    allowedOrigins.add("chrome-extension://" + id);
    assert.equal(
      await worker.evaluate(() => self instanceof ServiceWorkerGlobalScope),
      true,
    );
    const p = await context.newPage();
    if (name === "A") a = p;
    else b = p;
    p.on("pageerror", (e) => result.errors.push(e.message));
    await p.goto("chrome-extension://" + id + "/index.html");
    await p.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
    await cmd(p, "relay", { url });
    await p.evaluate(async () => {
      const { data } = await chrome.storage.local.get("data");
      data.bookmarks.forEach((b) => (b.icon = { mode: "letter" }));
      await chrome.storage.local.set({ data });
    });
  }
  await join(b, "通知测试电脑 B", await invitation(true));
  const before = await b.evaluate(
    async () => (await chrome.storage.local.get("data")).data,
  );
  const homeUrl = b.url();
  await b.goto(new URL("popup.html", homeUrl).href);
  await b.locator(".popup-app").waitFor();
  await b.waitForTimeout(700);
  await remove("通知测试电脑 B");
  await poll(
    () => cmd(b, "status"),
    (s) => !s.status.paired && s.status.removedNotice,
    "B notice",
  );
  assert.equal(
    await b.evaluate(
      async () =>
        (await chrome.storage.local.get("removedNoticeToast"))
          .removedNoticeToast,
    ),
    undefined,
    "Quick collect popup must not consume the home Toast",
  );
  assert.equal(
    await b
      .locator(".toast")
      .filter({ hasText: "本设备已被移出配对组" })
      .count(),
    0,
  );
  await b.goto(homeUrl);
  await b.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  await verify(b, store ? "store" : "desktop");
  const after = await b.evaluate(
    async () => (await chrome.storage.local.get("data")).data,
  );
  assert.equal(after.bookmarks.length, before.bookmarks.length);
  assert.deepEqual(after.profile, before.profile);
  result.desktopCheckedAt = new Date().toISOString();
  console.log(
    "PASS " + (store ? "store" : "desktop") + " persistent removed notice",
  );
  if (!store) {
    await poll(
      () => fetch(relay + "/v1/health").then((r) => r.ok),
      Boolean,
      "relay rate window",
      75000,
    );
    home = await homeServer("dist-android", 4185);
    browser = await launchChrome({ args: [] });
    const mobile = await browser.newContext(mobileOptions);
    await nativeMock(mobile);
    const icon = await readFile("tests/fixtures/github.webp");
    await mobile.route("https://kongjing.inc.re/**", (route) =>
      new URL(route.request().url()).pathname === "/v1/icon"
        ? route.fulfill({ contentType: "image/webp", body: icon })
        : route.abort(),
    );
    phone = await mobile.newPage();
    phone.on("pageerror", (e) => result.errors.push(e.message));
    await phone.goto(home.base.replace("127.0.0.1", "localhost"));
    await phone.waitForFunction(() =>
      window.__nativeCalls.some((c) => c.method === "ready"),
    );
    await settings(phone, true);
    await phone.getByText("高级", { exact: true }).click();
    await phone.getByLabel("中转服务器", { exact: true }).fill(relay);
    await phone.getByRole("button", { name: "测试连接", exact: true }).click();
    await phone.getByText("连接成功", { exact: true }).waitFor();
    await join(phone, "通知测试手机", await invitation());
    const phoneBefore = (
      await bridgeCall(phone, "searchBookmarks", { query: "", limit: 50 })
    ).data;
    await remove("通知测试手机");
    await verify(phone, "android");
    result.mobileOrigin = new URL(phone.url()).origin;
    assert.deepEqual((await bridgeCall(phone, "getDevices")).data, []);
    assert.deepEqual(
      (await bridgeCall(phone, "searchBookmarks", { query: "", limit: 50 }))
        .data,
      phoneBefore,
    );
    console.log("PASS Android persistent removed notice");
  }
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (e) {
  result.failure = String(e);
  for (const [name, p] of [
    ["a", a],
    ["b", b],
    ["phone", phone],
  ])
    if (p) {
      result[name + "Body"] = await p
        .locator("body")
        .innerText()
        .catch(() => null);
      await p
        .screenshot({ path: resolve(dir, name + "-failure.png") })
        .catch(() => {});
    }
  throw e;
} finally {
  for (const p of [a, b])
    if (p) {
      const s = await cmd(p, "status").catch(() => null);
      if (s?.status?.paired) await cmd(p, "leave").catch(() => {});
    }
  await browser?.close();
  for (const c of contexts) await c.close();
  await home?.close();
  for (const s of sockets) s.destroy();
  if (proxy?.listening) await new Promise((r) => proxy.close(r));
  server?.kill();
  await writeFile(resolve(dir, "relay.log"), log);
  await writeFile(
    "tests/removed-notice-" + (store ? "store204" : "214") + "-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
