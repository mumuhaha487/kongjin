import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtemp, readFile, writeFile, cp, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { launchExtension } from "./browser.mjs";
import { fixture } from "./fixtures.mjs";
const id = "agijcmabomapmbobdgblmckibkpobdij",
  release = resolve("../release/unpacked"),
  errors = [],
  checks = [],
  out = resolve("../docs/v2/screenshots");
const capture = process.env.KJ_SMOKE_CAPTURE !== "0";
await mkdir(out, { recursive: true });
const server = createServer((req, res) => {
  if (req.url === "/favicon.webp") {
    res.setHeader("content-type", "image/webp");
    res.end(
      Buffer.from(fixture().bookmarks[0].icon.dataUrl.split(",")[1], "base64"),
    );
    return;
  }
  res.setHeader("content-type", "text/html;charset=utf-8");
  res.end(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="icon" type="image/webp" href="/favicon.webp"><title>空境栏 · 示例文章</title><style>body{margin:0;background:#F3F6FA;color:#121826;font:16px/1.8 system-ui}main{max-width:760px;margin:120px auto}small{color:#65748B}h1{font-weight:500}hr{border:0;border-top:1px solid #D5DFED}</style><main><small>KONGJING · 示例网页</small><h1>让每一次打开，都留一点空境</h1><hr><p>这里是用于验证空境栏的本地示例页面。</p><p>将鼠标移到页面顶部，随时访问你的书签，或收藏当前页面。</p></main></html>',
  );
});
await new Promise((r) => server.listen(8801, "127.0.0.1", r));
let c;
try {
  c = await launchExtension(await mkdtemp(resolve("tests/.smoke-")), release);
  const page = await c.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("chrome://newtab");
  await page.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  await page.waitForFunction(() => performance.getEntriesByName("kongjing-storage-ready").length > 0);
  assert.equal(await page.evaluate(() => chrome.runtime.id), id);
  assert.ok(page.url().includes(id));
  assert.equal(
    await page.evaluate(
      async () =>
        (await chrome.storage.local.get("data")).data.settings.autoClose,
    ),
    true,
  );
  checks.push("正式 unpacked 新标签页替换与ID");
  const continuity = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "kj:continuity", action: "state" }),
  );
  assert.equal(continuity.available, true);
  assert.equal(continuity.options.history, false);
  assert.equal(continuity.options.tabs, false);
  checks.push("未授予可选权限时后台接力初始化成功、敏感采集默认关闭");
  const menu = await page.evaluate(async () => {
    const a = [];
    for (const id of ["kj-page", "kj-link"]) {
      await chrome.contextMenus.update(id, { enabled: true });
      a.push(id);
    }
    return a;
  });
  assert.equal(menu.length, 2);
  checks.push("正式 unpacked 两个右键菜单项存在");
  const pop = await c.newPage();
  await pop.goto("chrome-extension://" + id + "/popup.html");
  await pop.locator(".popup-app").waitFor();
  assert.equal(await pop.locator(".popup-header").innerText(), "空境");
  checks.push("正式 unpacked popup 与 MV3 CSP");
  const cachedPage = await c.newPage();
  await cachedPage.goto("http://127.0.0.1:8801/favicon-probe");
  await cachedPage.waitForTimeout(1500);
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "kj:collect",
      url: "http://127.0.0.1:8801/favicon-probe",
      title: "favicon缓存测试",
    }),
  );
  await page.waitForFunction(async () => {
    const b = (await chrome.storage.local.get("data")).data.bookmarks.find(
      (b) => b.title === "favicon缓存测试",
    );
    return !!b?.icon.dataUrl && b.icon.tone === "dark";
  });
  checks.push("正式权限下真实_favicon缓存识别、压缩和tone计算");
  await c.close();
  c = undefined;
  // Test-only copy pregrants the optional origin: Chromium headless cannot click
  // the native optional-permission dialog. All source JS is byte-identical.
  const testExt = await mkdtemp(resolve("tests/.bar-extension-"));
  await cp(release, testExt, { recursive: true });
  const manifest = JSON.parse(
    await readFile(resolve(testExt, "manifest.json"), "utf8"),
  );
  manifest.host_permissions.push("<all_urls>");
  await writeFile(resolve(testExt, "manifest.json"), JSON.stringify(manifest));
  c = await launchExtension(
    await mkdtemp(resolve("tests/.bar-profile-")),
    testExt,
    capture
      ? { recordVideo: { dir: out, size: { width: 1440, height: 900 } } }
      : {},
  );
  const home = await c.newPage();
  await home.goto("chrome-extension://" + id + "/index.html");
  await home.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  await home.waitForFunction(
    () => performance.getEntriesByName("kongjing-storage-ready").length > 0,
  );
  const worker = c.serviceWorkers()[0];
  const traceStorage = () => {
    self.__storageWrites = [];
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async values => {
      if (values.data) self.__storageWrites.push({ bar: values.data.settings.barEnabled, icon: values.data.bookmarks.map(b => [b.title,b.icon.mode]), stack: new Error().stack });
      return original(values);
    };
  };
  await worker.evaluate(traceStorage);
  await home.evaluate(traceStorage);
  const data = fixture();
  for (const b of data.bookmarks)
    b.icon.mode = b.icon.dataUrl ? "custom" : "letter";
  data.settings.barEnabled = true;
  await home.evaluate((data) => chrome.storage.local.set({ data }), data);
  await home.waitForFunction(
    async () =>
      !!(await chrome.scripting.getRegisteredContentScripts()).find(
        (s) => s.id === "kongjing-bar",
      ),
  );
  checks.push("可选权限已授予路径：动态 registerContentScripts");
  const p = await c.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("http://127.0.0.1:8801/article");
  await p.locator("kongjing-bar").waitFor({ state: "attached" });
  assert.equal(
    await p.locator("kongjing-bar").evaluate((el) => el.shadowRoot),
    null,
  );
  const cdp = await c.newCDPSession(p);
  async function shadow(selector, action = "rect") {
    const { root } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    function find(n) {
      if (n.nodeName === "KONGJING-BAR") return n;
      for (const x of [...(n.children || []), ...(n.shadowRoots || [])]) {
        const r = find(x);
        if (r) return r;
      }
    }
    const h = find(root);
    assert.ok(h?.shadowRoots?.length);
    const { object } = await cdp.send("DOM.resolveNode", {
      nodeId: h.shadowRoots[0].nodeId,
    });
    const { result, exceptionDetails } = await cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration:
          'function(selector,action){const el=this.querySelector(selector);if(!el)return null;if(action==="text")return el.textContent;if(action==="attributes")return Object.fromEntries([...el.attributes].map(a=>[a.name,a.value]));if(action==="style")return {opacity:getComputedStyle(el).opacity,display:getComputedStyle(el).display};const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}',
        arguments: [{ value: selector }, { value: action }],
        returnByValue: true,
      },
    );
    assert.ok(!exceptionDetails);
    return result.value;
  }
  const click = async (sel, button = "left") => {
    const r = await shadow(sel);
    await p.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { button });
  };
  await p.mouse.move(200, 40);
  await p.waitForTimeout(250);
  if (capture)
    await p.screenshot({ path: resolve(out, "17-dock-collapsed.png") });
  await p.mouse.move(720, 3);
  await p.waitForTimeout(1200);
  assert.equal((await shadow(".dock", "style")).opacity, "1");
  checks.push("closed Shadow DOM 注入、热区180ms展开");
  const chevron = await shadow(".group svg", "attributes");
  assert.equal(chevron.width, "12");
  assert.equal(chevron.height, "12");
  assert.equal(chevron["stroke-width"], "1.5");
  assert.equal(
    (await shadow(".group svg path", "attributes")).d,
    "m6 9 6 6 6-6",
  );
  assert.equal(await shadow(".group", "text"), "常用");
  const divider = await shadow(".group + .divider");
  assert.equal(divider.width, 1);
  assert.equal(divider.height, 20);
  checks.push("空境栏ChevronDown为12px/1.5 SVG，分组后分隔线1×20px");
  const b = await shadow(".bookmark");
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.waitForTimeout(800);
  assert.equal((await shadow(".bookmark .tip", "style")).opacity, "1");
  if (capture)
    await p.screenshot({ path: resolve(out, "18-dock-expanded.png") });
  await click(".collect");
  await home.waitForFunction(async () =>
    (await chrome.storage.local.get("data")).data.bookmarks.some((b) =>
      b.url.includes("8801/article"),
    ),
  );
  await p.waitForTimeout(200);
  assert.match(await shadow(".collect .tip", "text"), /已收藏到「/);
  await home.evaluate(async () => {
    const { data } = await chrome.storage.local.get("data");
    data.profile.updatedAt = Date.now();
    await chrome.storage.local.set({ data });
  });
  await p.waitForTimeout(200);
  assert.match(await shadow(".collect .tip", "text"), /已收藏到「/);
  checks.push("空境栏收藏本页、storage实时更新");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(250);
  assert.equal((await shadow(".dock", "style")).opacity, "0");
  await home.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find((t) =>
      t.url?.includes("8801"),
    );
    await chrome.tabs.sendMessage(tab.id, { type: "kj:toggle-bar" });
  });
  await p.waitForTimeout(1100);
  assert.equal((await shadow(".dock", "style")).opacity, "1");
  checks.push("Esc收起、快捷键消息展开");
  await click(".dock", "right");
  await click(".menu button");
  await home.waitForFunction(async () =>
    (await chrome.storage.local.get("data")).data.settings.hiddenSites.includes(
      "127.0.0.1",
    ),
  );
  assert.equal(
    await p
      .locator("kongjing-bar")
      .evaluate((el) => getComputedStyle(el).display),
    "none",
  );
  checks.push("按网站隐藏与storage即时响应");
  await home.evaluate(async () => {
    const { data } = await chrome.storage.local.get("data");
    data.settings.barEnabled = false;
    await chrome.storage.local.set({ data });
  });
  await home.waitForFunction(
    async () => !(await chrome.scripting.getRegisteredContentScripts()).length,
  );
  checks.push("关闭后注销动态脚本");
  const video = p.video();
  await p.close();
  if (video) {
    await video.saveAs(resolve(out, "motion-dock.webm"));
    await video.delete();
  }
  for (const other of c.pages()) {
    const unused = other.video();
    await other.close();
    if (unused) await unused.delete();
  }
  await writeFile(
    "tests/smoke-result.json",
    JSON.stringify(
      {
        id,
        browser: c.browser()?.version(),
        checks,
        errors,
        capture,
        permissionTest:
          "test-only manifest pregrant; production manifest unchanged",
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(checks.join("\n"));
} catch (error) {
  if (c) {
    const diagnostics = [];
    for (const page of c.pages()) {
      diagnostics.push({
        url: page.url(),
        bar: await page.locator("kongjing-bar").evaluateAll((nodes) =>
          nodes.map((e) => ({
            display: getComputedStyle(e).display,
            rect: e.getBoundingClientRect().toJSON(),
          })),
        ),
        extension: await page
          .evaluate(async () =>
            typeof chrome !== "undefined" && chrome.runtime?.id
              ? {
                  data: (await chrome.storage.local.get("data")).data.settings,
                  scripts: await chrome.scripting.getRegisteredContentScripts(),
                  permissions: await chrome.permissions.getAll(),
                }
              : null,
          )
          .catch(() => null),
      });
    }
    console.log("Smoke diagnostic", JSON.stringify(diagnostics, null, 2));
    for (const worker of c.serviceWorkers()) console.log("Worker writes",JSON.stringify(await worker.evaluate(()=>self.__storageWrites),null,2));
    for (const page of c.pages()) console.log("Page writes",JSON.stringify(await page.evaluate(()=>self.__storageWrites),null,2));
  }
  throw error;
} finally {
  if (c) await c.close();
  server.close();
}
