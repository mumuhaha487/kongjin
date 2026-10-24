import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import sharp from "sharp";
import { launchChrome } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import {
  mobileScene,
  bridgeCall,
  longPress,
  swipe,
  mobileOptions,
} from "./android-fixtures.mjs";
const screenshots = process.argv.includes("--screenshots"),
  landscapeScreenshot = screenshots || process.argv.includes("--landscape"),
  out = "../docs/v3-mobile/screenshots";
const server = await homeServer(process.env.KJ_QA_ANDROID_DIR || "dist-android-qa", 4183),
  browser = await launchChrome({ args: [] });
const passed = [],
  errors = [],
  images = [];
await mkdir(out, { recursive: true });
const pass = (name) => {
  passed.push(name);
  console.log("PASS " + name);
};
async function capture(page, name) {
  if (!screenshots) return;
  await page.waitForTimeout(1400);
  await page.screenshot({ path: out + "/" + name });
  const meta = await sharp(await readFile(out + "/" + name)).metadata();
  assert.equal(meta.width, 1082);
  assert.equal(meta.height, 2402);
  images.push({ name, width: meta.width, height: meta.height });
}
try {
  const { context, page } = await mobileScene(browser, server.base);
  page.on("pageerror", (e) => errors.push(e.message));
  const geometry = await page.evaluate(() => {
    const rect = (s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      header: rect(".topbar"),
      search: rect(".search-box"),
      tile: rect(".bookmark-link .tile-icon"),
      gridWidth: rect(".bookmark-grid").width,
      grid: getComputedStyle(document.querySelector(".bookmark-grid"))
        .gridTemplateColumns,
      clock: getComputedStyle(document.querySelector(".clock")).fontSize,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(geometry.header.height, 56);
  assert.equal(geometry.search.height, 48);
  assert.equal(geometry.search.x, 20);
  assert.equal(geometry.search.width, 372);
  assert.equal(geometry.tile.width, 52);
  assert.equal(geometry.grid.split(" ").length, 4);
  assert.equal(geometry.overflow, false);
  assert.equal(await page.locator(".settings-trigger").count(), 0);
  assert.equal(geometry.gridWidth, 372);
  await capture(page, "01-home-light.png");
  pass("412×915/DPR2.625：56px顶栏、48px搜索、4列/52px图标，无横向溢出");
  await page.getByRole("button", { name: "切换主题", exact: true }).tap();
  await page.waitForTimeout(800);
  assert.equal(
    await page.evaluate(
      () =>
        window.__nativeCalls.filter((c) => c.method === "setTheme").slice(-1)[0]
          .args[0],
    ),
    "dark",
  );
  await capture(page, "02-home-dark.png");
  await page.getByRole("button", { name: "切换主题", exact: true }).tap();
  await page.waitForTimeout(800);
  pass("主题同步原生setTheme");
  await page.locator(".search-box").tap({ position: { x: 140, y: 26 } });
  assert.equal(
    await page
      .getByRole("textbox", { name: "搜索", exact: true })
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await page.getByRole("textbox", { name: "搜索", exact: true }).fill("空境 测试");
  await page.getByRole("textbox", { name: "搜索", exact: true }).press("Enter");
  const call = await page.evaluate(
    () => window.__nativeCalls.filter((c) => c.method === "open").slice(-1)[0],
  );
  assert.match(call.args[0], /^https:\/\/www.bing.com\/search\?q=/);
  await page.getByRole("textbox", { name: "搜索", exact: true }).fill("");
  await page.getByRole("textbox", { name: "搜索", exact: true }).blur();
  pass("整条搜索聚焦与原生模板搜索");
  await longPress(page, page.locator(".bookmark-link").first());
  await page.getByRole("dialog", { name: "书签菜单", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("dialog", { name: "书签菜单" })
      .getByRole("menuitem")
      .count(),
    4,
  );
  assert.equal(
    await page.evaluate(() =>
      window.__nativeCalls.some(
        (c) => c.method === "haptic" && c.args[0] === "light",
      ),
    ),
    true,
  );
  await capture(page, "03-bookmark-actions.png");
  await page.getByRole("menuitem", { name: "打开", exact: true }).focus();
  await page.keyboard.press("End");
  assert.equal(
    await page
      .getByRole("menuitem", { name: "删除", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Home");
  assert.equal(
    await page
      .getByRole("menuitem", { name: "打开", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByRole("menuitem", { name: "在新标签页中打开", exact: true })
    .tap();
  assert.equal(
    (
      await page.evaluate(
        () =>
          window.__nativeCalls.filter((c) => c.method === "open").slice(-1)[0],
      )
    ).args[1],
    true,
  );
  await page
    .getByRole("dialog", { name: "书签菜单" })
    .waitFor({ state: "hidden" });
  pass("450ms长按操作表、实际执行菜单项与轻触感");
  await page.waitForTimeout(600);
  const to = await page.locator("[data-bookmark]").nth(2).boundingBox();
  await longPress(page, page.locator(".bookmark-link").first(), {
    x: to.x + to.width / 2,
    y: to.y + 20,
  });
  await page.waitForTimeout(600);
  const reordered = await page.evaluate(
    () =>
      window.kjTest
        .getState()
        .data.bookmarks.find((b) => b.id === "default-github").order,
  );
  assert.notEqual(reordered, 0);
  await page
    .locator(".drag-overlay")
    .waitFor({ state: "hidden", timeout: 5000 });
  pass("长按不松手拖拽排序");
  await page.getByRole("button", { name: "添加书签", exact: true }).tap();
  await page.getByRole("dialog", { name: "添加书签", exact: true }).waitFor();
  await capture(page, "04-add-bookmark.png");
  const sheet = await page.locator(".modal:visible").boundingBox();
  assert.equal(Math.round(sheet.x), 0);
  assert.equal(Math.round(sheet.width), 412);
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .locator(".modal:visible")
        .evaluate((el) => el.contains(document.activeElement)),
      true,
    );
  }
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "添加书签", exact: true }).tap();
  await page.waitForTimeout(600);
  const grip = await page.locator(".modal:visible .sheet-grip-zone").boundingBox();
  await swipe(page, { x: 206, y: grip.y + 12 }, { x: 206, y: grip.y + 172 });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  pass("底部抽屉焦点陷阱、Esc及下拉超过120px关闭");
  await bridgeCall(page, "openSettings", { section: "browser" });
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "默认搜索引擎", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Google", exact: true }).tap();
  const template = await bridgeCall(page, "getSearchTemplate");
  assert.match(template.data.template, /google/);
  await page
    .getByRole("switch", { name: "在新标签页打开书签", exact: true })
    .tap();
  await page
    .locator("#settings-browser")
    .getByRole("button", { name: "清除", exact: true })
    .tap();
  await page
    .getByRole("dialog", { name: "确认", exact: true })
    .getByRole("button", { name: "清除", exact: true })
    .tap();
  assert.equal(
    await page.evaluate(() =>
      window.__nativeCalls.some(
        (c) =>
          c.method === "clearBrowsingData" &&
          c.args[0] === '["cookies","cache","history"]',
      ),
    ),
    true,
  );
  await page
    .locator("#settings-browser")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, "05-settings.png");
  pass("全屏设置/浏览器分区、搜索模板更新与原生清除浏览数据");
  await page.getByRole("button", { name: "关闭设置", exact: true }).tap();
  await page.waitForTimeout(500);
  await page.locator(".bookmark-link").first().tap();
  assert.equal(
    (
      await page.evaluate(
        () =>
          window.__nativeCalls.filter((c) => c.method === "open").slice(-1)[0],
      )
    ).args[1],
    true,
  );
  const groups = await bridgeCall(page, "getGroups");
  assert.equal(groups.data[0].name, "常用");
  const added = await bridgeCall(page, "addBookmark", {
    url: "HTTPS://Example.COM:443/#one",
    title: "桥接收藏",
    iconDataUrl: await page.evaluate(() => window.__testIcon),
  });
  assert.equal(added.ok, true);
  const found = await bridgeCall(page, "findBookmark", { url: "example.com" });
  assert.equal(found.data.id, added.data.id);
  const suggestions = await bridgeCall(page, "searchBookmarks", {
    query: "EXAMPLE.COM",
    limit: 1,
  });
  const cachedIcon = await page.evaluate(
    (id) =>
      window.kjTest.getState().data.bookmarks.find((b) => b.id === id).icon
        .dataUrl,
    added.data.id,
  );
  assert.deepEqual(suggestions, {
    ok: true,
    data: [
      {
        title: "桥接收藏",
        url: "https://example.com/#one",
        iconDataUrl: cachedIcon,
      },
    ],
  });
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.__nativeCalls
          .filter(
            (c) => c.method === "reply" && c.args[0] === "test-searchBookmarks",
          )
          .slice(-1)[0],
    ),
    {
      method: "reply",
      args: ["test-searchBookmarks", JSON.stringify(suggestions)],
    },
  );
  assert.deepEqual(await bridgeCall(page, "searchBookmarks", { query: "" }), {
    ok: true,
    data: [],
  });
  for (const args of [
    {},
    { query: "a", limit: -1 },
    { query: "a", limit: 1.5 },
  ])
    assert.deepEqual(await bridgeCall(page, "searchBookmarks", args), {
      ok: false,
      error: "INVALID_ARGS",
    });
  await bridgeCall(page, "removeBookmark", { id: added.data.id });
  assert.equal(
    (await bridgeCall(page, "findBookmark", { url: "example.com" })).data.found,
    false,
  );
  assert.equal((await bridgeCall(page, "getTheme")).data.theme, "light");
  pass(
    "原生桥全部8方法、searchBookmarks原生reply、规范化收藏/移除、真实IndexedDB持久化",
  );
  const nativeIcon = await bridgeCall(page, "addBookmark", {
    url: "https://native-icon.example",
    title: "缓存图标",
  });
  await page.waitForFunction(
    (id) =>
      !!window.kjTest.getState().data.bookmarks.find((b) => b.id === id)?.icon
        .dataUrl,
    nativeIcon.data.id,
  );
  await bridgeCall(page, "removeBookmark", { id: nativeIcon.data.id });
  pass("原生favicon缓存优先于中转");
  await bridgeCall(page, "openSettings", { section: "pairing" });
  await page.getByRole("button", { name: "加入已有配对组", exact: true }).tap();
  const input = page.getByLabel("配对码", { exact: true });
  await input.waitFor();
  assert.equal(await input.getAttribute("autocapitalize"), "characters");
  await capture(page, "06-pair-join.png");
  await input.fill("8f3qzt7m2c");
  await page.getByRole("button", { name: "连接", exact: true }).tap();
  await page
    .getByRole("heading", { name: "核对安全码", exact: true })
    .waitFor();
  await capture(page, "07-pair-sas.png");
  await page.getByRole("button", { name: "一致", exact: true }).tap();
  await page.getByRole("heading", { name: "配对成功", exact: true }).waitFor();
  await page.waitForTimeout(1900);
  assert.equal(
    await page.evaluate(() =>
      window.__nativeCalls.some(
        (c) => c.method === "haptic" && c.args[0] === "success",
      ),
    ),
    true,
  );
  pass("手机加入优先、大写配对码、SAS与成功触感");
  await context.close();
  const scrolling = await mobileScene(browser, server.base);
  await scrolling.page.evaluate(() =>
    window.kjTest.getState().update((d) => {
      const b = d.bookmarks[0];
      for (let i = 0; i < 40; i++)
        d.bookmarks.push({ ...b, id: "scroll-" + i, order: i + 10 });
      for (let i = 0; i < 10; i++)
        d.groups.push({
          id: "g-" + i,
          name: "分组" + i,
          order: i + 1,
          updatedAt: 1,
        });
    }),
  );
  await scrolling.page.waitForTimeout(500);
  const tile = await scrolling.page
    .locator(".bookmark-link")
    .first()
    .boundingBox();
  await swipe(
    scrolling.page,
    { x: tile.x + 20, y: tile.y + 30 },
    { x: tile.x + 20, y: tile.y - 130 },
  );
  assert.ok((await scrolling.page.evaluate(() => scrollY)) > 0);
  await scrolling.page.evaluate(() => scrollTo(0, 0));
  await scrolling.page.waitForFunction(() => scrollY === 0);
  // Finish the previous compositor scroll before locating the next touch rail.
  await scrolling.page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const groupsBox = await scrolling.page.locator(".groups").boundingBox();
  await swipe(
    scrolling.page,
    { x: 330, y: groupsBox.y + 18 },
    { x: 60, y: groupsBox.y + 18 },
  );
  await scrolling.page.waitForFunction(() => document.querySelector('.groups').scrollLeft > 0);
  assert.ok(
    (await scrolling.page.locator(".groups").evaluate((el) => el.scrollLeft)) >
      0,
  );
  await scrolling.page.getByRole("textbox", { name: "搜索", exact: true }).focus();
  await scrolling.page.setViewportSize({ width: 412, height: 400 });
  await scrolling.page.waitForTimeout(700);
  const search = await scrolling.page.locator(".search-box").boundingBox();
  assert.ok(search.y + search.height <= 400);
  await scrolling.context.close();
  pass("普通触摸纵向滚动、分组横向滑动及缩小键盘视口时搜索可见");
  const paired = await mobileScene(browser, server.base, { paired: true });
  await bridgeCall(paired.page, "openSettings", { section: "pairing" });
  await paired.page.locator(".device-list").waitFor();
  assert.equal(await paired.page.locator(".device-row").count(), 3);
  await capture(paired.page, "08-paired-devices.png");
  await paired.context.close();
  const landscape = await mobileScene(browser, server.base);
  landscape.page.on("pageerror", (e) => errors.push(e.message));
  await landscape.page.setViewportSize({ width: 915, height: 412 });
  const session = await landscape.context.newCDPSession(landscape.page);
  await session.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 0, bottom: 0, left: 32, right: 24 },
  });
  await landscape.page.waitForTimeout(700);
  const measureSafeArea = (page, selector) =>
    page.evaluate((selector) => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;visibility:hidden;padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)";
      document.body.append(probe);
      const insetStyle = getComputedStyle(probe);
      const insets = {
        left: parseFloat(insetStyle.paddingLeft),
        right: parseFloat(insetStyle.paddingRight),
      };
      probe.remove();
      const header = document.querySelector(selector),
        style = getComputedStyle(header),
        first = header.firstElementChild.getBoundingClientRect(),
        last = header.lastElementChild.getBoundingClientRect();
      return {
        insets,
        left: first.left,
        right: innerWidth - last.right,
        paddingLeft: parseFloat(style.paddingLeft),
        paddingRight: parseFloat(style.paddingRight),
      };
    }, selector);
  const topbar = await measureSafeArea(landscape.page, ".topbar");
  assert.deepEqual(topbar.insets, { left: 32, right: 24 });
  assert.ok(topbar.left >= topbar.insets.left + 20);
  assert.ok(topbar.right >= topbar.insets.right + 20);
  assert.equal(topbar.paddingLeft, 52);
  assert.equal(topbar.paddingRight, 44);
  if (landscapeScreenshot) {
    const name = "09-home-landscape.png";
    await landscape.page.screenshot({ path: out + "/" + name });
    const meta = await sharp(await readFile(out + "/" + name)).metadata();
    assert.equal(meta.width, 2402);
    assert.equal(meta.height, 1082);
    images.push({ name, width: meta.width, height: meta.height });
  }
  await bridgeCall(landscape.page, "openSettings");
  await landscape.page
    .getByRole("dialog", { name: "设置", exact: true })
    .waitFor();
  await landscape.page.waitForTimeout(700);
  const settingsHeader = await measureSafeArea(
    landscape.page,
    ".settings-panel > header",
  );
  assert.deepEqual(settingsHeader.insets, { left: 32, right: 24 });
  assert.ok(settingsHeader.left >= settingsHeader.insets.left + 24);
  assert.ok(settingsHeader.right >= settingsHeader.insets.right + 24);
  assert.equal(settingsHeader.paddingLeft, 56);
  assert.equal(settingsHeader.paddingRight, 48);
  const landscapeGeometry = {
    viewport: { width: 915, height: 412 },
    topbar,
    settingsHeader,
  };
  await session.detach();
  await landscape.context.close();
  pass("915×412横屏：非零左右安全区32/24px，顶栏及设置头部保留20/24px间距");
  const missing = await browser.newContext(mobileOptions),
    noNative = await missing.newPage();
  await noNative.goto(server.base);
  await noNative.waitForFunction(() => !!window.kongjing);
  assert.equal((await bridgeCall(noNative, "getGroups")).ok, true);
  await missing.close();
  pass("无KongjingNative预览正常降级");
  assert.deepEqual(errors, []);
  await writeFile(
    "tests/android-ui-result.json",
    JSON.stringify(
      {
        passed,
        errors,
        geometry,
        landscapeGeometry,
        images,
        viewport: mobileOptions,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
