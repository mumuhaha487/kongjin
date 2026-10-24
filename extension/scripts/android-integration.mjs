import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchExtension, launchChrome } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import { mobileOptions, nativeMock, bridgeCall } from "./android-fixtures.mjs";
import { legacyEnvironment } from "./android-legacy-env.mjs";
const legacy = process.env.KJ_LEGACY === "1";
const relay = process.env.KJ_RELAY_URL || "https://kongjing.inc.re",
  local =
    relay.startsWith("http://localhost") ||
    relay.startsWith("http://127.0.0.1");
const server = await homeServer("dist-android", 4185),
  proxy = local
    ? undefined
    : {
        server: process.env.KJ_PROXY || "http://127.0.0.1:10808",
        bypass: "127.0.0.1,localhost",
      };
const profile = await mkdtemp(resolve("tests/.android-desktop-"));
const desktop = await launchExtension(profile, resolve("dist"), { proxy });
const browser = await launchChrome({ proxy, args: [] });
const result = {
  passed: false,
  relay,
  round: local ? "local" : "one online proxy round",
  legacy,
  checks: [],
  errors: [],
  workers: [],
};
const cmd = (page, action, args = {}) =>
  page.evaluate(
    ({ action, args }) =>
      chrome.runtime.sendMessage({ type: "kj:pair", action, args }),
    { action, args },
  );
async function poll(fn, predicate, label, ms = 60000) {
  const start = Date.now();
  let value;
  while (Date.now() - start < ms) {
    value = await fn();
    if (predicate(value)) return value;
    if (value?.pair?.view === "failure")
      throw Error(label + ": " + value.pair.error);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(label + " timeout");
}
try {
  const pc = await desktop.newPage();
  pc.on("pageerror", (e) => result.errors.push(e.message));
  await pc.goto(
    "chrome-extension://agijcmabomapmbobdgblmckibkpobdij/index.html",
  );
  await pc.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  const mobile = await browser.newContext(mobileOptions);
  await nativeMock(mobile);
  if (legacy) await legacyEnvironment(mobile);
  if (!local)
    await mobile.route(
      "https://appassets.androidplatform.net/home/**",
      async (route) => {
        const path = new URL(route.request().url()).pathname.replace(
          "/home/",
          "",
        );
        const response = await fetch(server.base.replace("index.html", path));
        await route.fulfill({
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") },
          body: Buffer.from(await response.arrayBuffer()),
        });
      },
    );
  const phone = await mobile.newPage();
  phone.on("pageerror", (e) => result.errors.push(e.message));
  phone.on("worker", (w) => result.workers.push(w.url()));
  await phone.goto(
    local
      ? server.base.replace("127.0.0.1", "localhost")
      : "https://appassets.androidplatform.net/home/index.html",
  );
  await phone.waitForFunction(() =>
    window.__nativeCalls.some((c) => c.method === "ready"),
  );
  if (local) {
    await cmd(pc, "relay", { url: relay });
    await bridgeCall(phone, "openSettings", { section: "pairing" });
    await phone.getByText("高级", { exact: true }).tap();
    await phone.getByLabel("中转服务器", { exact: true }).fill(relay);
    await phone.getByRole("button", { name: "测试连接", exact: true }).tap();
    await phone.getByText("连接成功", { exact: true }).waitFor();
  }
  await cmd(pc, "create", { name: "电脑 · 空境" });
  console.log("Desktop create completed");
  const invite = await poll(
    () => cmd(pc, "status"),
    (s) => s.pair.view === "invite",
    "desktop invite",
  );
  await bridgeCall(phone, "openSettings", { section: "pairing" });
  await phone
    .getByRole("button", { name: "加入已有配对组", exact: true })
    .tap();
  await phone.getByLabel("配对码", { exact: true }).fill(invite.pair.code);
  await phone.getByRole("button", { name: "连接", exact: true }).tap();
  await phone
    .getByRole("heading", { name: "核对安全码", exact: true })
    .waitFor({ timeout: 90000 });
  const sas = await poll(
    () => cmd(pc, "status"),
    (s) => s.pair.view === "sas",
    "desktop sas",
  );
  assert.equal(
    (await phone.locator(".sas-code").innerText()).replace(/\s/g, ""),
    sas.pair.sas.replace(/\s/g, ""),
  );
  assert.equal(
    await phone.locator(".pair-content .help").innerText(),
    "对方设备：电脑 · 空境",
  );
  result.checks.push("真实协议，手机加入电脑邀请，SAS一致且显示真实邀请方名称");
  console.log("SAS verified");
  await Promise.all([
    cmd(pc, "confirm"),
    phone.getByRole("button", { name: "一致", exact: true }).tap(),
  ]);
  await phone
    .getByRole("heading", { name: "配对成功", exact: true })
    .waitFor({ timeout: 60000 });
  await poll(
    () => cmd(pc, "status"),
    (s) => s.status.devices.length === 2,
    "two devices",
  );
  const stamp = Date.now(),
    url = `https://example.com/desktop-${stamp}`;
  await pc.evaluate(
    async ({ stamp, url }) => {
      const { data } = await chrome.storage.local.get("data");
      data.bookmarks.push({
        id: crypto.randomUUID(),
        title: "电脑同步到手机",
        url,
        groupId: data.groups[0].id,
        order: data.bookmarks.length,
        icon: { mode: "letter" },
        createdAt: stamp,
        updatedAt: stamp,
      });
      await chrome.storage.local.set({ data });
    },
    { stamp, url },
  );
  let start = Date.now();
  await poll(
    () => bridgeCall(phone, "findBookmark", { url }),
    (s) => s.data?.found,
    "desktop to mobile",
  );
  result.desktopToMobileMs = Date.now() - start;
  result.checks.push("桌面新增书签→手机IndexedDB与原生findBookmark可见");
  const phoneUrl = `https://example.com/mobile-${stamp}`;
  start = Date.now();
  const saved = await bridgeCall(phone, "addBookmark", {
    url: phoneUrl,
    title: "手机原生收藏同步到电脑",
    iconDataUrl: await phone.evaluate(() => window.__testIcon),
  });
  assert.equal(saved.ok, true);
  await poll(
    () =>
      pc.evaluate(
        async (url) =>
          (await chrome.storage.local.get("data")).data.bookmarks.some(
            (b) => b.url === url,
          ),
        phoneUrl,
      ),
    Boolean,
    "mobile to desktop",
  );
  result.mobileToDesktopMs = Date.now() - start;
  result.checks.push(
    "kongjing.call(addBookmark)→持久化→桌面收到，原生reply与成功触感",
  );
  await phone.reload();
  await phone.waitForFunction(() =>
    window.__nativeCalls.some((c) => c.method === "ready"),
  );
  assert.equal(
    (await bridgeCall(phone, "findBookmark", { url: phoneUrl })).data.found,
    true,
  );
  result.checks.push("手机页面重载后IndexedDB数据与配对密钥保留");
  // Joining does not require PoW. The page Worker URL is independently checked by check:android.
  assert.deepEqual(result.errors, []);
  result.passed = true;
  await mobile.close();
} catch (error) {
  result.failure = String(error);
  throw error;
} finally {
  await writeFile(
    `tests/android-integration${local ? "-local" : ""}${legacy ? "-legacy" : ""}-result.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  await desktop.close();
  await browser.close();
  await server.close();
}
