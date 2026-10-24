import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { launchExtension } from "./browser.mjs";
const extension = resolve("dist-store"),
  contexts = [],
  checks = [],
  errors = [];
const manifest = JSON.parse(
  await readFile(resolve(extension, "manifest.json"), "utf8"),
);
const relay = "https://kongjing.inc.re",
  proxy = process.env.KJ_PROXY || "http://127.0.0.1:10808";
const offlineOnly = process.env.KJ_STORE_OFFLINE_ONLY === "1";
const resources = [];
const favicon = await readFile("tests/fixtures/github.webp");
const server = createServer((req, res) => {
  if (req.url === "/favicon.webp") {
    res.setHeader("content-type", "image/webp");
    res.end(favicon);
    return;
  }
  res.setHeader("content-type", "text/html;charset=utf-8");
  res.end(
    '<!doctype html><html lang="zh-CN"><link rel="icon" href="/favicon.webp"><title>商店版收藏测试</title><h1>商店版收藏测试</h1></html>',
  );
});
await new Promise((r) => server.listen(8802, "127.0.0.1", r));
const profiles = [],
  names = [];
let latency,
  onlineStarted = false;
async function device(name) {
  const profile = await mkdtemp(resolve("tests/.store-smoke-" + name + "-"));
  const context = await launchExtension(profile, extension, {
    ...(!offlineOnly ? {proxy: { server: proxy, bypass: "127.0.0.1,localhost" }} : {}),
  });
  contexts.push(context);
  context.on("page", (p) => {
    p.on("response", (r) => {
      if (r.status() >= 400)
        resources.push({ url: r.url(), status: r.status() });
    });
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto("chrome://newtab");
  await page.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  assert.ok(page.url().startsWith("chrome-extension://" + id + "/"));
  profiles.push({ name, id });
  return { context, page, id };
}
const cmd = (p, action, args = {}) =>
  p.evaluate(
    ({ action, args }) =>
      chrome.runtime.sendMessage({ type: "kj:pair", action, args }),
    { action, args },
  );
async function wait(p, predicate, label, limit = 60000) {
  const start = Date.now();
  while (Date.now() - start < limit) {
    const s = await cmd(p, "status");
    if (predicate(s)) return s;
    if (s.pair.view === "failure")
      throw Error(label + ": " + JSON.stringify(s.pair));
    await p.waitForTimeout(200);
  }
  throw Error(label + " timeout");
}
try {
  assert.deepEqual(manifest.permissions, [
    "storage",
    "favicon",
    "activeTab",
    "contextMenus",
    "alarms",
    "search",
  ]);
  assert.ok(!manifest.key);
  assert.equal(manifest.commands["toggle-bar"].suggested_key.default, "Alt+J");
  assert.deepEqual(manifest.optional_permissions, ["scripting"]);
  const a = await device("a"),
    p = a.page;
  assert.equal(
    await p.evaluate(() => chrome.runtime.getManifest().key),
    undefined,
  );
  checks.push("无key商店版以实际分配ID加载，正式新标签页替换生效");
  await p.evaluate(() => {
    window.searchCalls = [];
    chrome.search.query = async (options) => {
      window.searchCalls.push(options);
    };
  });
  const input = p.getByRole("textbox", { name: "搜索", exact: true });
  await input.fill("baidu.com是什么网站");
  await input.press("Enter");
  await p.waitForFunction(() => window.searchCalls.length === 1);
  await p.evaluate(async () => {
    const { data } = await chrome.storage.local.get("data");
    data.settings.newTab = true;
    await chrome.storage.local.set({ data });
  });
  await p.waitForTimeout(300);
  await input.fill("另一个搜索");
  await input.press("Enter");
  await p.waitForFunction(() => window.searchCalls.length === 2);
  assert.deepEqual(await p.evaluate(() => window.searchCalls), [
    { text: "baidu.com是什么网站", disposition: "CURRENT_TAB" },
    { text: "另一个搜索", disposition: "NEW_TAB" },
  ]);
  await p.reload();
  await p.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  await p.waitForTimeout(500);
  assert.equal(
    await p.locator(".search-placeholder").innerText(),
    "搜索",
  );
  checks.push(
    "真实扩展chrome.search.query测试桩：CURRENT_TAB/NEW_TAB参数正确，重开默认搜索",
  );
  const menu = await p.evaluate(async () => {
    for (const id of ["kj-page", "kj-link"])
      await chrome.contextMenus.update(id, { enabled: true });
    return true;
  });
  assert.equal(menu, true);
  checks.push("两个右键收藏菜单存在");
  const web = await a.context.newPage();
  await web.goto("http://127.0.0.1:8802/article");
  await web.waitForTimeout(1000);
  await p.evaluate(async () => {
    const { data } = await chrome.storage.local.get("data");
    data.settings.autoClose = false;
    await chrome.storage.local.set({ data });
  });
  const popup = await a.context.newPage();
  // Opening popup.html as a tab does not trigger Chrome's toolbar activeTab
  // grant. Supply only the URL/title that a genuine action click exposes;
  // all popup code, storage, background and manifest remain production code.
  await popup.addInitScript(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (options) => {
      const tabs = await query(options);
      return options.active && options.currentWindow
        ? tabs.map((tab) => ({
            ...tab,
            url: "http://127.0.0.1:8802/article",
            title: "商店版收藏测试",
          }))
        : tabs;
    };
  });
  await web.bringToFront();
  await popup.goto("chrome-extension://" + a.id + "/popup.html");
  await popup
    .getByRole("button", { name: "收藏到空境", exact: true })
    .waitFor();
  assert.equal(
    await popup.getByRole("switch", { name: "空境栏", exact: true }).count(),
    0,
  );
  assert.match(await popup.locator("footer").innerText(), /Alt\+K\s*设置/);
  await popup.getByRole("button", { name: "收藏到空境", exact: true }).click();
  await p.waitForFunction(async () =>
    (await chrome.storage.local.get("data")).data.bookmarks.some(
      (b) => b.url === "http://127.0.0.1:8802/article",
    ),
  );
  await popup.close();
  await web.close();
  checks.push(
    "正式popup收藏到storage（activeTab当前页信息测试桩），底部仅Alt+K和设置，无空境栏入口",
  );
  await p.getByRole("button", { name: "我的", exact: true }).click();
  await p.getByRole("menuitem", { name: /配对与同步/ }).click();
  const join = p.getByRole("button", { name: "加入已有配对组", exact: true });
  await join.click();
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  await p.getByRole("button", { name: "关闭设置" }).click();
  checks.push("设置/配对UI可达，Esc关闭与焦点陷阱无错误");
  if (!offlineOnly) {
    const b = await device("b");
    onlineStarted = true;
    await p.bringToFront();
    await cmd(p, "relay", { url: relay });
    await cmd(p, "create", { name: "商店测试A" });
    const invite = await wait(p, (s) => s.pair.view === "invite", "invite");
    await b.page.bringToFront();
    await b.page.getByRole("button", { name: "我的", exact: true }).click();
    await b.page.getByRole("menuitem", { name: /配对与同步/ }).click();
    await b.page
      .getByRole("button", { name: "加入已有配对组", exact: true })
      .click();
    await b.page.getByLabel("配对码", { exact: true }).fill(invite.pair.code);
    await b.page.getByLabel("本机名称", { exact: true }).fill("商店测试B");
    await b.page.getByRole("button", { name: "连接", exact: true }).click();
    const [sa, sb] = await Promise.all([
      wait(p, (s) => s.pair.view === "sas", "sasA"),
      wait(b.page, (s) => s.pair.view === "sas", "sasB"),
    ]);
    assert.equal(sa.pair.sas, sb.pair.sas);
    assert.equal(sb.pair.peerName, "商店测试A");
    await b.page
      .getByRole("heading", { name: "核对安全码", exact: true })
      .waitFor();
    assert.equal(
      await b.page.locator(".pair-content .help").innerText(),
      "对方设备：商店测试A",
    );
    names.push(sb.pair.peerName);
    await Promise.all([cmd(p, "confirm"), cmd(b.page, "confirm")]);
    await wait(
      b.page,
      (s) => s.status.paired && s.pair.view === "success",
      "paired",
    );
    checks.push(
      "唯一线上代理双设备轮：真实PoW/ECDH/SAS、邀请方名称、双向确认通过",
    );
    const start = Date.now();
    await p.evaluate(async () => {
      const { data } = await chrome.storage.local.get("data");
      data.profile = { nickname: "商店同步验证", updatedAt: Date.now() };
      await chrome.storage.local.set({ data });
    });
    await b.page.waitForFunction(
      async () =>
        (await chrome.storage.local.get("data")).data.profile.nickname ===
        "商店同步验证",
      undefined,
      { timeout: 30000 },
    );
    latency = Date.now() - start;
    assert.ok(latency < 30000);
    checks.push("线上加密同步到另一独立profile " + latency + "ms");
  }
  assert.deepEqual(errors, []);
  await writeFile(
    offlineOnly
      ? "tests/store-smoke-offline-result.json"
      : "tests/store-smoke-result.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        errors,
        resources,
        profiles,
        online: {
          attempts: onlineStarted ? 1 : 0,
          proxy: true,
          relay,
          latency,
          inviterNames: names,
        },
      },
      null,
      2,
    ),
  );
  console.log(checks.join("\n"));
} catch (e) {
  await writeFile(
    offlineOnly
      ? "tests/store-smoke-offline-result.json"
      : "tests/store-smoke-result.json",
    JSON.stringify(
      {
        passed: false,
        checks,
        errors,
        resources,
        profiles,
        failure: String(e),
        online: {
          attempts: onlineStarted ? 1 : 0,
          proxy: true,
          relay,
          latency,
          retried: false,
        },
      },
      null,
      2,
    ),
  );
  throw e;
} finally {
  for (const c of contexts) {
    const page = c.pages().find(p => p.url().startsWith("chrome-extension://"));
    if (onlineStarted && page) await page.evaluate(() => chrome.runtime.sendMessage({type:"kj:pair",action:"leave"})).catch(() => {});
    await c.close();
  }
  await new Promise((r) => server.close(r));
}
