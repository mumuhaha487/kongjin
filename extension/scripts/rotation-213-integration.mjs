import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchChrome, launchExtension } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import { mobileOptions, nativeMock, bridgeCall } from "./android-fixtures.mjs";

process.env.KJ_BLOCK_ONLINE_RELAY = "1";
const relay = "http://127.0.0.1:8790",
  id = "agijcmabomapmbobdgblmckibkpobdij";
const dir = await mkdtemp(resolve("tests/.rotation-213-")),
  contexts = [],
  pages = [],
  workers = [];
const result = {
  passed: false,
  online: false,
  relay,
  workers: [],
  checks: [],
  timings: {},
  errors: [],
  screenshots: [],
};
let server,
  home,
  browser,
  phone,
  log = "";
const pair = (page, action, args = {}) =>
  page.evaluate(
    ({ action, args }) =>
      chrome.runtime.sendMessage({ type: "kj:pair", action, args }),
    { action, args },
  );
const continuity = (page, action, args = {}) =>
  page.evaluate(
    ({ action, args }) =>
      chrome.runtime.sendMessage({ type: "kj:continuity", action, args }),
    { action, args },
  );
async function poll(fn, predicate, label, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) =>
      setTimeout(r, label === "relay rate window" ? 2000 : 150),
    );
  }
  throw Error(label + " timed out: " + JSON.stringify(last));
}
const watch = (page) =>
  page.on("pageerror", (e) => result.errors.push(e.message));
async function settings(page) {
  if (!(await page.locator(".settings-panel").count()))
    await page.getByRole("button", { name: "设置", exact: true }).click();
}
async function closeSettings(page) {
  if (await page.locator(".settings-panel").count()) {
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.locator(".settings-panel").waitFor({ state: "detached" });
  }
}
async function invite(a) {
  await pair(a, "invite");
  return (
    await poll(
      () => pair(a, "status"),
      (s) => s.pair.view === "invite",
      "invite",
    )
  ).pair.code;
}
async function join(a, b, name, initial = false) {
  const code = initial
    ? (
        await poll(
          () => pair(a, "status"),
          (s) => s.pair.view === "invite",
          "initial invite",
        )
      ).pair.code
    : await invite(a);
  await settings(b);
  await b.getByRole("button", { name: "加入已有配对组", exact: true }).click();
  await b.getByLabel("配对码", { exact: true }).fill(code);
  await b.getByLabel("本机名称", { exact: true }).fill(name);
  await b.getByRole("button", { name: "连接", exact: true }).click();
  await b.getByRole("heading", { name: "核对安全码", exact: true }).waitFor();
  const sas = await poll(
    () => pair(a, "status"),
    (s) => s.pair.view === "sas",
    "SAS",
  );
  assert.equal(
    (await b.locator(".sas-code").innerText()).replace(/\s/g, ""),
    sas.pair.sas.replace(/\s/g, ""),
  );
  await Promise.all([
    pair(a, "confirm"),
    b.getByRole("button", { name: "一致", exact: true }).click(),
  ]);
  await poll(
    () => pair(b, "status"),
    (s) => s.pair.view === "success",
    "joined",
  );
  await b.locator(".pair-content").waitFor({ state: "detached" });
  await closeSettings(b);
}
async function add(page, title) {
  await page.evaluate(async (title) => {
    const { data } = await chrome.storage.local.get("data"),
      at = Date.now();
    data.bookmarks.push({
      id: crypto.randomUUID(),
      groupId: data.groups[0].id,
      title,
      url: "https://rotation.example/" + encodeURIComponent(title),
      order: data.bookmarks.length,
      createdAt: at,
      updatedAt: at,
      icon: { mode: "letter" },
    });
    await chrome.storage.local.set({ data });
  }, title);
  await pair(page, "sync");
}
const has = (page, title) =>
  page.evaluate(
    async (title) =>
      (await chrome.storage.local.get("data")).data.bookmarks.some(
        (b) => b.title === title,
      ),
    title,
  );
async function bidirectional(a, b, label) {
  await add(a, label + " A→B");
  await poll(() => has(b, label + " A→B"), Boolean, label + " A→B");
  await add(b, label + " B→A");
  await poll(() => has(a, label + " B→A"), Boolean, label + " B→A");
}
async function shot(page, name) {
  await page.bringToFront();
  await page.mouse.move(20, 20);
  await page.waitForTimeout(700);
  await page
    .locator(".settings-panel")
    .evaluate((el) => el.focus({ preventScroll: true }));
  const path =
    "../docs/v4-continuity/screenshots/rotation-fix-" + name + ".png";
  await page.screenshot({ path });
  result.screenshots.push(path);
}
async function epochTogether(a, b, epoch, count) {
  const states = await Promise.all(
    [a, b].map((p) =>
      poll(
        () => pair(p, "status"),
        (s) =>
          s.status.epoch === epoch &&
          s.status.devices.length === count &&
          s.status.connection === "online",
        "new epoch",
      ),
    ),
  );
  assert.deepEqual(
    states[0].status.devices.map((d) => d.deviceId).sort(),
    states[1].status.devices.map((d) => d.deviceId).sort(),
  );
  return states;
}
async function leave(page) {
  await settings(page);
  await page.getByRole("button", { name: "离开配对组", exact: true }).click();
  await page.getByRole("button", { name: "离开", exact: true }).click();
}
try {
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
    server.stdout.on("data", (b) => {
      log += b;
    });
    server.stderr.on("data", (b) => {
      log += b;
    });
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
  await mkdir("../docs/v4-continuity/screenshots", { recursive: true });
  for (const name of ["A", "B", "C", "D"]) {
    // Load the actual production manifest and JS, without test permissions or app mocks.
    const context = await launchExtension(
      resolve(dir, "profile-" + name),
      resolve("dist"),
    );
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    watch(page);
    await page.goto(`chrome-extension://${id}/index.html`);
    await page.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    workers.push(worker);
    const evidence = await worker.evaluate(() => {
      globalThis.__rotationErrors = [];
      addEventListener("error", (e) =>
        globalThis.__rotationErrors.push(e.message),
      );
      addEventListener("unhandledrejection", (e) =>
        globalThis.__rotationErrors.push(String(e.reason)),
      );
      return {
        serviceWorker: self instanceof ServiceWorkerGlobalScope,
        window: typeof window,
        document: typeof document,
        url: location.href,
      };
    });
    assert.equal(evidence.serviceWorker, true);
    assert.equal(evidence.window, "undefined");
    assert.equal(evidence.document, "undefined");
    result.workers.push(evidence);
    await pair(page, "relay", { url: relay });
    await page.evaluate(async () => {
      const { data } = await chrome.storage.local.get("data");
      data.bookmarks.forEach((b) => (b.icon = { mode: "letter" }));
      await chrome.storage.local.set({ data });
    });
  }
  const [a, b, c, d] = pages;
  await pair(a, "create", { name: "接力电脑 A" });
  await join(a, b, "接力电脑 B", true);
  await join(a, c, "接力电脑 C");
  await poll(
    () => pair(b, "status"),
    (s) => s.status.devices.length === 3,
    "three members",
  );
  await continuity(a, "option", { key: "search", value: true });
  await continuity(a, "search", { query: "换密钥前保留的搜索" });
  await pair(a, "sync");
  const initial = (await pair(a, "status")).status,
    removedId = initial.devices.find((v) => v.name === "接力电脑 C").deviceId;
  await settings(a);
  await a
    .locator(".device-row")
    .filter({ hasText: "接力电脑 C" })
    .getByRole("button", { name: "移除", exact: true })
    .click();
  console.log("PASS joined A/B/C; removing C");
  const startA = Date.now();
  await a.getByRole("button", { name: "移除", exact: true }).last().click();
  await epochTogether(a, b, initial.epoch + 1, 2);
  const removed = await poll(
    () => pair(c, "status"),
    (s) => !s.status.paired && s.status.error?.includes("已被移出"),
    "C removed",
  );
  assert.ok(!removed.status.paired);
  await bidirectional(a, b, "场景 a");
  assert.equal(await has(c, "场景 a A→B"), false);
  assert.equal(await has(c, "场景 a B→A"), false);
  result.timings.removeCMs = Date.now() - startA;
  console.log("PASS scenario a", result.timings.removeCMs);
  await shot(a, "a-survivors");
  await settings(c);
  await shot(c, "a-removed-c");
  result.checks.push(
    "a: A removes C through settings in actual service worker; A/B epoch+1 and bidirectional sync; C removed and receives neither new bookmark",
  );
  await closeSettings(a);
  await join(a, d, "接力电脑 D");
  const beforeB = (await pair(a, "status")).status.epoch;
  const startB = Date.now();
  await leave(b);
  await epochTogether(a, d, beforeB + 1, 2);
  result.timings.desktopLeaveRotationMs = Date.now() - startB;
  assert.ok(result.timings.desktopLeaveRotationMs < 30000);
  await bidirectional(a, d, "场景 b");
  await settings(a);
  await shot(a, "b-auto-rotation");
  result.checks.push(
    "b: B voluntarily leaves; remaining A/D automatically rotate within30s and synchronize both directions",
  );
  await closeSettings(a);
  console.log(
    "PASS desktop a/b; waiting for local relay global rate window if needed",
  );
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
  watch(phone);
  phone.on("console", (m) => {
    if (m.type() === "error") console.log("PHONE", m.text());
  });
  phone.on("requestfailed", (r) =>
    console.log("PHONE failed", r.url(), r.failure()),
  );
  await phone.goto(home.base.replace("127.0.0.1", "localhost"));
  await phone.waitForFunction(() =>
    window.__nativeCalls.some((c) => c.method === "ready"),
  );
  await bridgeCall(phone, "openSettings", { section: "pairing" });
  await phone.getByText("高级", { exact: true }).tap();
  await phone.getByLabel("中转服务器", { exact: true }).fill(relay);
  await phone.getByRole("button", { name: "测试连接", exact: true }).tap();
  await phone.getByText("连接成功", { exact: true }).waitFor();
  const code = await invite(a);
  await phone
    .getByRole("button", { name: "加入已有配对组", exact: true })
    .tap();
  await phone.getByLabel("配对码", { exact: true }).fill(code);
  await phone.getByRole("button", { name: "连接", exact: true }).tap();
  await phone
    .getByRole("heading", { name: "核对安全码", exact: true })
    .waitFor();
  const sas = await poll(
    () => pair(a, "status"),
    (s) => s.pair.view === "sas",
    "phone SAS",
  );
  assert.equal(
    (await phone.locator(".sas-code").innerText()).replace(/\s/g, ""),
    sas.pair.sas.replace(/\s/g, ""),
  );
  await Promise.all([
    pair(a, "confirm"),
    phone.getByRole("button", { name: "一致", exact: true }).tap(),
  ]);
  await phone.getByRole("heading", { name: "配对成功", exact: true }).waitFor();
  await phone.locator(".pair-content").waitFor({ state: "detached" });
  await poll(
    () => pair(d, "status"),
    (s) => s.status.devices.length === 3,
    "phone in group",
  );
  console.log("PASS phone joined");
  const beforePhone = (await pair(a, "status")).status.epoch,
    startPhone = Date.now();
  await phone.getByRole("button", { name: "离开配对组", exact: true }).tap();
  await phone.getByRole("button", { name: "离开", exact: true }).tap();
  await epochTogether(a, d, beforePhone + 1, 2);
  result.timings.mobileLeaveRotationMs = Date.now() - startPhone;
  assert.ok(result.timings.mobileLeaveRotationMs < 30000);
  assert.deepEqual((await bridgeCall(phone, "getDevices")).data, []);
  await bidirectional(a, d, "场景 c");
  await settings(a);
  await shot(a, "c-auto-rotation");
  await shot(phone, "c-phone-left");
  result.checks.push(
    "c: production Android home joins and voluntarily leaves; real desktop workers A/D rotate within30s and remain bidirectionally synchronized",
  );
  const errors = await Promise.all(
    workers.map((w) => w.evaluate(() => globalThis.__rotationErrors)),
  );
  result.workerErrors = errors;
  assert.deepEqual(errors, [[], [], [], []]);
  assert.deepEqual(result.errors, []);
  result.states = await Promise.all(pages.map((p) => pair(p, "status")));
  result.mobileOrigin = new URL(phone.url()).origin;
  result.passed = true;
} catch (e) {
  result.failure = String(e);
  if (phone) {
    result.phoneBody = await phone.locator("body").innerText();
    await phone.screenshot({ path: resolve(dir, "phone-failure.png") });
  }
  result.states = await Promise.all(
    pages.map((p) => pair(p, "status").catch(() => null)),
  );
  if (pages[0])
    await pages[0]
      .screenshot({ path: resolve(dir, "failure.png") })
      .catch(() => {});
  throw e;
} finally {
  await browser?.close();
  for (const c of contexts) await c.close();
  await home?.close();
  server?.kill();
  await writeFile(resolve(dir, "relay.log"), log);
  await writeFile(
    "tests/rotation-213-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
