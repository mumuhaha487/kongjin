import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { launchChrome, launchExtension } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import { mobileOptions, nativeMock, bridgeCall } from "./android-fixtures.mjs";

// This runner has no online mode. Run it only against its own fresh local relay.
process.env.KJ_BLOCK_ONLINE_RELAY = "1";
const relay = "http://127.0.0.1:8790";
const extensionId = "agijcmabomapmbobdgblmckibkpobdij";
const dir = await mkdtemp(resolve("tests/.continuity-212-"));
const contexts = [],
  pages = [];
let server,
  home,
  browser,
  phone,
  serverLog = "";
const result = {
  passed: false,
  online: false,
  relay,
  checks: [],
  errors: [],
  timings: {},
};
const pair = (page, action, args = {}) =>
  page.evaluate(
    ({ action, args }) =>
      chrome.runtime.sendMessage({ type: "kj:pair", action, args }),
    { action, args },
  );
const continuity = async (page, action, args = {}) => {
  const value = await page.evaluate(
    ({ action, args }) =>
      chrome.runtime.sendMessage({ type: "kj:continuity", action, args }),
    { action, args },
  );
  assert.ok(!value?.error, action + ": " + value?.error);
  return value;
};
async function poll(fn, predicate, label, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value?.pair?.view === "failure")
      throw Error(label + ": " + value.pair.error);
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error(label + " timed out");
}
function watch(page) {
  page.on("pageerror", (error) => result.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") result.errors.push(message.text());
  });
}
const members = (state) =>
  state.status.devices
    .map((d) => [d.deviceId, d.name, d.platform])
    .sort((a, b) => a[0].localeCompare(b[0]));
try {
  // Do not attach to or stop an engineer's already-running relay.
  const health = await fetch(relay + "/v1/health")
    .then(() => true)
    .catch(() => false);
  assert.equal(
    health,
    false,
    "8790 must be free before starting this isolated test",
  );
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
  await poll(
    () =>
      fetch(relay + "/v1/health")
        .then((r) => r.ok)
        .catch(() => false),
    Boolean,
    "local relay",
    15000,
  );

  const testExtension = resolve(dir, "extension");
  await cp("dist", testExtension, { recursive: true });
  const manifest = JSON.parse(
    await readFile(resolve(testExtension, "manifest.json"), "utf8"),
  );
  manifest.permissions.push(...manifest.optional_permissions);
  delete manifest.optional_permissions;
  await writeFile(
    resolve(testExtension, "manifest.json"),
    JSON.stringify(manifest),
  );
  result.testManifest =
    "Only test copy pregrants existing optional permissions; source JavaScript equals production.";
  for (let i = 0; i < 2; i++) {
    const context = await launchExtension(
      resolve(dir, "profile-" + i),
      testExtension,
    );
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    watch(page);
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    await page.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
    await pair(page, "relay", { url: relay });
    await page.evaluate(async () => {
      const { data } = await chrome.storage.local.get("data");
      data.bookmarks.forEach((b) => {
        b.icon = { mode: "letter" };
      });
      await chrome.storage.local.set({ data });
      window.__pairFailures = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (m.type === "kj:status" && m.pair?.view === "failure")
          window.__pairFailures.push(m.pair.error);
      });
    });
  }
  const [a, b] = pages;
  await a.waitForTimeout(1000);
  await pair(a, "create", { name: "接力电脑 A" });
  const invitation = await poll(
    () => pair(a, "status"),
    (s) => s.pair.view === "invite",
    "desktop invite",
  );
  await b.getByRole("button", { name: "设置", exact: true }).click();
  await b.getByRole("button", { name: "加入已有配对组", exact: true }).click();
  await b.getByLabel("配对码", { exact: true }).fill(invitation.pair.code);
  await b.getByLabel("本机名称", { exact: true }).fill("接力电脑 B");
  await b.getByRole("button", { name: "连接", exact: true }).click();
  await b.getByRole("heading", { name: "核对安全码", exact: true }).waitFor();
  const sas = await poll(
    () => pair(a, "status"),
    (s) => s.pair.view === "sas",
    "desktop SAS",
  );
  assert.equal(
    (await b.locator(".sas-code").innerText()).replace(/\s/g, ""),
    sas.pair.sas.replace(/\s/g, ""),
  );
  const started = Date.now();
  await Promise.all([
    pair(a, "confirm"),
    b.getByRole("button", { name: "一致", exact: true }).click(),
  ]);
  const statusA = await poll(
    () => pair(a, "status"),
    (s) => s.pair.view === "success" && s.status.devices.length === 2,
    "inviter done",
  );
  const statusB = await poll(
    () => pair(b, "status"),
    (s) => s.pair.view === "success" && s.status.devices.length === 2,
    "joiner done",
  );
  assert.deepEqual(members(statusA), members(statusB));
  result.timings.desktopJoinMs = Date.now() - started;
  result.checks.push(
    "B types invitation into real join UI; equal SAS, both session.done succeed after welcome, equal two-member lists; no NETWORK",
  );
  await b.locator(".pair-content").waitFor({ state: "detached" });
  await b.getByRole("button", { name: "关闭设置", exact: true }).click();
  await b.locator(".settings-panel").waitFor({ state: "detached" });
  await b.getByRole("button", { name: "接力", exact: true }).click();
  await b.getByRole("button", { name: "历史", exact: true }).click();
  await continuity(a, "option", { key: "history", value: true });
  await continuity(a, "option", { key: "tabs", value: true });
  assert.equal(
    await a.evaluate(() =>
      chrome.permissions.contains({ permissions: ["tabs"] }),
    ),
    true,
  );
  const url = "https://late.continuity.example/eleven-seconds";
  const title = "接力迟到标题";
  const visit = await contexts[0].newPage();
  await visit.route(url, (route) =>
    route.fulfill({
      contentType: "text/html;charset=utf-8",
      body: '<!doctype html><title></title><h1>等待网页脚本设置标题</h1><script>setTimeout(()=>{document.title="接力迟到标题";document.querySelector("h1").textContent=document.title;},11000)</script>',
    }),
  );
  const visitedAt = Date.now();
  await visit.goto(url);
  await b.bringToFront();
  const original = await poll(
    () => continuity(b, "history"),
    (s) => s.items.some((v) => v.u === url),
    "empty visit before title",
    10000,
  );
  const originalRow = original.items.find((v) => v.u === url);
  assert.ok(!originalRow.ti || originalRow.ti === url);
  const row = b.locator(".relay-history-row a").filter({ hasText: title });
  await row.waitFor({
    state: "visible",
    timeout: Math.max(1, 60000 - (Date.now() - visitedAt)),
  });
  result.timings.lateTitleMs = Date.now() - visitedAt;
  const updated = (
    await continuity(b, "history", { query: title })
  ).items.filter((v) => v.u === url);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, originalRow.id);
  assert.equal(updated[0].at, originalRow.at);
  assert.equal(updated[0].ti, title);
  assert.ok(result.timings.lateTitleMs < 60000);
  const nativeHistory = await a.evaluate(
    (url) => chrome.history.search({ text: url, startTime: 0, maxResults: 10 }),
    url,
  );
  result.historyEvidence = {
    nativeTitle: nativeHistory.find((v) => v.url === url)?.title,
    syncedTitle: updated[0].ti,
    sameIdAndAt: true,
    rows: 1,
  };
  await b
    .locator(".relay-panel")
    .evaluate((el) => el.focus({ preventScroll: true }));
  await b.waitForTimeout(500);
  const screenshot = "../docs/v4-continuity/screenshots/late-title-fix-b.png";
  await mkdir(resolve(screenshot, ".."), { recursive: true });
  await b.screenshot({ path: screenshot });
  const metadata = await sharp(screenshot).metadata();
  assert.equal(metadata.width, 2880);
  assert.equal(metadata.height, 1800);
  result.screenshot = {
    path: screenshot,
    width: metadata.width,
    height: metadata.height,
  };
  result.checks.push(
    "A has tabs permission: actual page changes title after 11s; B history UI enriches within 60s, one row and same id/at; title search index refreshed",
  );
  await visit.close();

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
  // Loopback avoids current desktop Chrome's LNA permission prompt; appassets
  // resource/worker checks run separately without weakening browser security.
  await phone.goto(home.base.replace("127.0.0.1", "localhost"));
  await phone.waitForFunction(() =>
    window.__nativeCalls.some((c) => c.method === "ready"),
  );
  await bridgeCall(phone, "openSettings", { section: "pairing" });
  await phone.getByText("高级", { exact: true }).tap();
  await phone.getByLabel("中转服务器", { exact: true }).fill(relay);
  await phone.getByRole("button", { name: "测试连接", exact: true }).tap();
  await phone.getByText("连接成功", { exact: true }).waitFor();
  await pair(a, "invite");
  const mobileInvitation = await poll(
    () => pair(a, "status"),
    (s) => s.pair.view === "invite",
    "mobile invite",
  );
  await phone
    .getByRole("button", { name: "加入已有配对组", exact: true })
    .tap();
  await phone
    .getByLabel("配对码", { exact: true })
    .fill(mobileInvitation.pair.code);
  await phone.getByRole("button", { name: "连接", exact: true }).tap();
  await phone
    .getByRole("heading", { name: "核对安全码", exact: true })
    .waitFor();
  const mobileSas = await poll(
    () => pair(a, "status"),
    (s) => s.pair.view === "sas",
    "mobile SAS",
  );
  assert.equal(
    (await phone.locator(".sas-code").innerText()).replace(/\s/g, ""),
    mobileSas.pair.sas.replace(/\s/g, ""),
  );
  assert.equal(
    await phone.locator(".pair-content .help").innerText(),
    "对方设备：接力电脑 A",
  );
  const mobileStarted = Date.now();
  await Promise.all([
    pair(a, "confirm"),
    phone.getByRole("button", { name: "一致", exact: true }).tap(),
  ]);
  await phone
    .getByRole("heading", { name: "配对成功", exact: true })
    .waitFor({ timeout: 60000 });
  const finalA = await poll(
    () => pair(a, "status"),
    (s) => s.pair.view === "success" && s.status.devices.length === 3,
    "three members at A",
  );
  const finalB = await poll(
    () => pair(b, "status"),
    (s) => s.status.devices.length === 3,
    "three members at B",
  );
  const remoteAtPhone = await poll(
    () => bridgeCall(phone, "getDevices"),
    (s) => s.ok && s.data.length === 2,
    "phone members",
  );
  assert.deepEqual(members(finalA), members(finalB));
  assert.deepEqual(
    remoteAtPhone.data.map((d) => d.deviceId).sort(),
    finalA.status.devices
      .filter((d) => !d.name.startsWith("Pixel"))
      .map((d) => d.deviceId)
      .sort(),
  );
  result.timings.mobileJoinMs = Date.now() - mobileStarted;
  result.mobileOrigin = new URL(phone.url()).origin;
  result.checks.push(
    "Production Android home at local preview origin joins desktop via actual join UI; equal SAS and real inviter name; phone success and all three member lists consistent; no NETWORK",
  );
  for (const page of pages)
    assert.deepEqual(await page.evaluate(() => window.__pairFailures), []);
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.failure = String(error);
  result.states = await Promise.all(
    pages.map((p) => pair(p, "status").catch(() => null)),
  );
  throw error;
} finally {
  // The isolated local server/data are test-only; production devices are never touched.
  await browser?.close();
  for (const context of contexts) await context.close();
  await home?.close();
  server?.kill();
  await writeFile(resolve(dir, "relay.log"), serverLog);
  await writeFile(
    "tests/continuity-212-integration-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
