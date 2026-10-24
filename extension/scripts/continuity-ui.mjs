import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import sharp from "sharp";
import { launchChrome } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import { fixture, setup } from "./fixtures.mjs";
import { mobileOptions, nativeMock, bridgeCall } from "./android-fixtures.mjs";
import { legacyEnvironment } from "./android-legacy-env.mjs";
const capture = process.argv.includes("--screenshots"),
  pillsOnly = process.argv.includes("--pills-only"),
  affectedOnly = process.argv.includes("--affected"),
  out = "../docs/v4-continuity/screenshots",
  now = Date.parse("2026-10-22T12:51:00+08:00");
const browser = await launchChrome({ args: [] }),
  desktop = await homeServer("dist-qa", 4190),
  mobile = await homeServer("dist-android-qa", 4191),
  errors = [],
  checks = [],
  images = [];
await mkdir(out, { recursive: true });
async function scene(android, theme, url, sendPreview = false) {
  const context = await browser.newContext({
    ...(android
      ? { ...mobileOptions }
      : {
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 2,
          locale: "zh-CN",
          timezoneId: "Asia/Singapore",
        }),
    ...(capture && !affectedOnly && theme === "dark" && !url
      ? {
          recordVideo: {
            dir: "tests/continuity-video",
            size: android
              ? { width: 412, height: 915 }
              : { width: 1440, height: 900 },
          },
        }
      : {}),
  });
  if (android) {
    await nativeMock(context);
    await legacyEnvironment(context);
  }
  const data = fixture(theme);
  data.settings.animated = false;
  data.settings.autoClose = false;
  const visits = Array.from({ length: 10010 }, (_, i) => ({
    u: "https://design.example.com/article/" + i,
    ti:
      i < 5
        ? [
            "空境视觉规范",
            "界面设计参考",
            "阅读：安静的工作方式",
            "今日灵感",
            "浏览器开发文档",
          ][i]
        : "设计资料 " + i,
    at: now - i * 120000,
  }));
  await setup(context, data, {
    "kj:mock": {
      paired: true,
      selfName: android ? "Pixel 7 · 空境" : "Windows · Chrome",
      extraDevices:
        url?.includes("popup.html") || sendPreview
          ? [
              "Xiaomi 14 · 空境",
              "Windows · Edge",
              "办公室的备用安卓手机超长名称 · 空境",
              "Mac mini · Chrome",
            ]
          : [],
    },
    "kj:popup": {
      id: 9,
      url: "https://kongjing.inc.re/",
      title: "空境 — 安静的新标签页",
    },
    "kj:continuity-fixture": {
      slots: [
        {
          dev: "b",
          at: now,
          payload: {
            windows: [
              {
                focused: true,
                tabs: [
                  {
                    u: "https://kongjing.inc.re/",
                    ti: "空境 — 安静的新标签页",
                    active: true,
                  },
                  {
                    u: "https://developer.chrome.com/",
                    ti: "Chrome 开发者文档",
                    active: false,
                  },
                  {
                    u: "https://www.figma.com/",
                    ti: "设计协作空间",
                    active: false,
                  },
                ],
              },
            ],
            last: {
              u: "https://kongjing.inc.re/",
              ti: "空境 — 安静的新标签页",
              at: now - 60000,
            },
          },
        },
      ],
      records: [
        {
          id: "fixture-history",
          seq: 1,
          dev: "b",
          at: now,
          t: "hv",
          v: visits,
        },
      ],
      inbox: [
        {
          id: "incoming-1",
          from: "b",
          at: now - 180000,
          k: "url",
          u: "https://developer.chrome.com/",
          ti: "Chrome 开发者文档",
        },
      ],
    },
  });
  await context.route(
    "https://kongjing.inc.re/v1/icon?host=kongjing.inc.re",
    async (route) =>
      route.fulfill({
        contentType: "image/png",
        body: await readFile("public/icons/128.png"),
      }),
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.setFixedTime(now);
  await page.goto(url || (android ? mobile.base : desktop.base));
  if (url?.includes("popup.html")) {
    await page.locator(".relay-send-row").waitFor();
    return { context, page };
  }
  await page.waitForFunction(
    () =>
      window.kjTest?.continuity &&
      window.kjTest?.relayState?.getState().status.paired,
  );
  await page.waitForFunction(
    async () =>
      (await window.kjTest.continuity("history", { limit: 1 })).items.length >
      0,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1000);
  return { context, page };
}
async function shot(page, name, android = false, popup = false) {
  if (
    !capture ||
    (affectedOnly &&
      !/^(02-history|04-resume|05-send-pills|search-fix)/.test(name))
  )
    return;
  await page.waitForTimeout(700);
  const dialog = page.locator('[role="dialog"]:not([inert])').last();
  if (await dialog.count()) {
    const box = await dialog.boundingBox(),
      viewport = page.viewportSize();
    assert.ok(
      box.x >= -1 &&
        box.y >= -1 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1,
      "Dialog stays inside viewport",
    );
  }
  await page
    .locator('[role="dialog"]')
    .last()
    .evaluateAll((elements) => elements[0]?.focus({ preventScroll: true }));
  if (popup) await page.locator(".popup-app").focus();
  const path = out + "/" + name;
  await page.screenshot({ path });
  const metadata = await sharp(path).metadata();
  assert.equal(metadata.width, popup ? 720 : android ? 1082 : 2880);
  if (!popup) assert.equal(metadata.height, android ? 2402 : 1800);
  images.push({ name, width: metadata.width, height: metadata.height });
}
async function assertPills(page) {
  await page.waitForTimeout(200);
  const geometry = await page.locator(".relay-send-rail").evaluate((rail) => {
    const r = rail.getBoundingClientRect(),
      pills = Array.from(rail.children)
        .filter((e) => e.tagName === "BUTTON")
        .map((e) => e.getBoundingClientRect());
    return {
      overflow: rail.scrollWidth > rail.clientWidth + 1,
      oneLine: pills.every(
        (p) =>
          Math.abs(p.top - r.top) < 1 &&
          p.right <= r.right + 0.5 &&
          p.bottom <= r.bottom + 0.5,
      ),
      count: pills.length,
      railHeight: r.height,
    };
  });
  assert.equal(geometry.oneLine, true);
  assert.equal(geometry.overflow, false);
  assert.equal(geometry.railHeight, 28);
  assert.ok(geometry.count > 1);
  const overflow = page.getByRole("button", { name: "更多设备", exact: true });
  await overflow.click();
  const menu = page.getByRole("menu", { name: "发送到设备", exact: true });
  await menu.waitFor();
  assert.ok((await menu.getByRole("menuitem").count()) > 0);
  await page.keyboard.press("End");
  assert.equal(
    await menu
      .getByRole("menuitem")
      .last()
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(
    await overflow.evaluate((e) => e === document.activeElement),
    true,
  );
  checks.push(
    "single line/overflow/menu keyboard at " + page.viewportSize().width + "px",
  );
}
async function command(page, action, args = {}) {
  return page.evaluate(
    ({ action, args }) => window.kjTest.continuity(action, args),
    { action, args },
  );
}
try {
  for (const android of pillsOnly ? [] : [false, true])
    for (const theme of ["light", "dark"]) {
      const { context, page } = await scene(android, theme),
        suffix = (android ? "mobile" : "desktop") + "-" + theme;
      assert.equal(await page.locator(".relay-trigger").count(), 1);
      assert.equal(await page.locator(".relay-unread").count(), 1);
      await page.locator(".relay-resume").waitFor();
      assert.equal(
        await page.locator(".relay-resume small").last().innerText(),
        "· MacBook",
      );
      if (theme === "light")
        await shot(
          page,
          "search-fix-" + (android ? "mobile" : "desktop") + "-light.png",
          android,
        );
      await shot(page, "04-resume-" + suffix + ".png", android);
      await page.getByRole("button", { name: "接力", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "接力", exact: true });
      await panel.waitFor();
      await panel.locator(".relay-device-card").first().waitFor();
      assert.equal(await panel.locator(".relay-tab-row").count(), 3);
      const box = await panel.boundingBox();
      assert.equal(Math.round(box.width), android ? 412 : 440);
      assert.match(
        await page.locator("#stage").getAttribute("style"),
        /translateX|translate3d|translate\(/,
      );
      await shot(page, "01-devices-" + suffix + ".png", android);
      await page.evaluate(() => {
        const store = window.kjTest.relayState;
        const slots = structuredClone(store.getState().slots);
        const tabs = slots[0].payload.windows[0].tabs;
        for (let i = tabs.length; i < 11; i++)
          tabs.push({
            u: "https://example.com/extra/" + i,
            ti: "额外标签 " + i,
            active: false,
          });
        store.setState({ slots });
      });
      assert.equal(await panel.locator(".relay-tab-row").count(), 8);
      await panel
        .getByRole("button", { name: "显示另外 3 个", exact: true })
        .click();
      assert.equal(await panel.locator(".relay-tab-row").count(), 11);
      await panel.getByRole("button", { name: "收起", exact: true }).click();
      assert.equal(await panel.locator(".relay-tab-row").count(), 8);
      await command(page, "state");
      await panel.getByRole("button", { name: "历史", exact: true }).click();
      await panel.locator(".relay-history-row").first().waitFor();
      assert.ok((await panel.locator(".relay-history-row").count()) < 30);
      assert.equal(
        await panel
          .locator(".relay-history-search")
          .evaluate((e) => e.getBoundingClientRect().height),
        40,
      );
      assert.ok(
        (await page.locator(".relay-source").allTextContents()).every(
          (t) => t === "MacBook",
        ),
      );
      await shot(page, "02-history-" + suffix + ".png", android);
      await panel.locator(".relay-history-list").evaluate((e) => {
        e.scrollTop = e.scrollHeight;
      });
      await page.waitForTimeout(700);
      assert.ok((await panel.locator(".relay-history-row").count()) < 30);
      await panel.getByLabel("搜索浏览记录").fill("空境视觉");
      await page.waitForTimeout(600);
      assert.equal(await panel.locator(".relay-history-row").count(), 1);
      await panel.locator(".relay-history-row").hover();
      await panel
        .getByRole("button", { name: "删除浏览记录 空境视觉规范", exact: true })
        .click();
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      assert.equal(await panel.locator(".relay-history-row").count(), 1);
      await panel.getByLabel("搜索浏览记录").fill("");
      await page.waitForTimeout(600);
      await panel
        .getByRole("button", { name: "清除浏览记录…", exact: true })
        .click();
      const clear = page.getByRole("dialog", {
        name: "清除浏览记录",
        exact: true,
      });
      await clear.waitFor();
      await clear
        .getByRole("heading", { name: "清除浏览记录", exact: true })
        .waitFor();
      assert.ok(
        await clear
          .getByText("不会改动其他电脑浏览器自身的历史记录", { exact: true })
          .isVisible(),
      );
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        assert.equal(
          await clear.evaluate((e) => e.contains(document.activeElement)),
          true,
        );
      }
      await shot(page, "03-clear-" + suffix + ".png", android);
      await page.keyboard.press("Escape");
      await clear.waitFor({ state: "hidden" });
      await panel
        .getByRole("button", { name: "关闭接力", exact: true })
        .click();
      await panel.waitFor({ state: "hidden" });
      if (android) {
        await bridgeCall(page, "openSettings", { section: "pairing" });
      } else
        await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.locator("#settings-sharing").scrollIntoViewIfNeeded();
      await shot(page, "06-sharing-" + suffix + ".png", android);
      await page.getByRole("switch", { name: "浏览记录", exact: true }).click();
      const permission = page.getByRole("dialog", {
        name: "共享浏览记录？",
        exact: true,
      });
      await permission.waitFor();
      await permission
        .getByRole("heading", { name: "共享浏览记录？", exact: true })
        .waitFor();
      await shot(page, "07-history-permission-" + suffix + ".png", android);
      await permission
        .getByRole("button", { name: "取消", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("switch", { name: "浏览记录", exact: true })
          .getAttribute("aria-checked"),
        "false",
      );
      await page
        .getByRole("switch", { name: "打开的标签页", exact: true })
        .click();
      const tabsPermission = page.getByRole("dialog", {
        name: "共享打开的标签页？",
        exact: true,
      });
      await tabsPermission.waitFor();
      await shot(page, "08-tabs-permission-" + suffix + ".png", android);
      await tabsPermission
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      if (android) {
        const devices = await bridgeCall(page, "getDevices");
        assert.equal(devices.data.length, 2);
        await command(page, "option", { key: "history", value: true });
        assert.equal(
          (
            await bridgeCall(page, "recordVisits", {
              visits: [
                { u: "https://native.example.com/", ti: "原生记录", at: now },
              ],
            })
          ).ok,
          true,
        );
        await command(page, "option", { key: "tabs", value: true });
        assert.equal(
          (
            await bridgeCall(page, "setOpenTabs", {
              tabs: [
                {
                  u: "https://native.example.com/",
                  ti: "原生标签",
                  active: true,
                },
              ],
              last: {
                u: "https://native.example.com/",
                ti: "原生标签",
                at: now,
              },
            })
          ).ok,
          true,
        );
        const search = await bridgeCall(page, "searchHistory", {
          query: "空境视觉",
          limit: 3,
        });
        assert.equal(search.data[0].dev, "b");
        assert.ok(search.data[0].devName);
        assert.equal(
          (
            await bridgeCall(page, "sendToDevice", {
              deviceId: "b",
              url: "https://native.example.com/",
              title: "发送测试",
            })
          ).ok,
          true,
        );
        assert.equal(
          (await bridgeCall(page, "pendingIncoming")).data.length,
          1,
        );
        assert.equal(
          (
            await bridgeCall(page, "markIncomingRead", {
              ids: ["incoming-1", "incoming-1"],
            })
          ).ok,
          true,
        );
        assert.equal(
          (await bridgeCall(page, "pendingIncoming")).data.length,
          0,
        );
        await bridgeCall(page, "openRelay", { tab: "history" });
        await page.locator(".relay-history-row").first().waitFor();
        assert.equal(
          await page.evaluate(() =>
            window.__nativeCalls.some((c) => c.method === "incoming"),
          ),
          true,
        );
        await command(page, "option", { key: "incoming", value: true });
        assert.equal(
          await page.evaluate(() =>
            window.__nativeCalls.some(
              (c) => c.method === "requestNotificationPermission",
            ),
          ),
          true,
        );
      }
      checks.push(
        suffix +
          ": panel/virtual/search/undo/focus/Esc/consent" +
          (android
            ? "/8 bridge methods/2 native callbacks/Chrome87 environment"
            : ""),
      );
      const video = page.video();
      await context.close();
      if (video) {
        await video.saveAs(
          out + "/motion-relay-" + (android ? "mobile" : "desktop") + ".webm",
        );
        await video.delete();
      }
      if (!android) {
        const popup = await scene(
          false,
          theme,
          desktop.base.replace("index.html", "popup.html"),
        );
        await popup.page.setViewportSize({ width: 360, height: 560 });
        await popup.page.locator(".relay-send-row").waitFor();
        await assertPills(popup.page);
        await shot(
          popup.page,
          "05-send-pills-desktop-" + theme + ".png",
          false,
          true,
        );
        await popup.page.locator(".relay-send-pill").first().click();
        await popup.page
          .getByText("已发送到 MacBook · Chrome", { exact: true })
          .waitFor();
        assert.ok(
          await popup.page
            .getByText("已发送到 MacBook · Chrome", { exact: true })
            .isVisible(),
        );
        checks.push("popup send " + theme);
        await popup.context.close();
      }
    }
  for (const theme of ["light", "dark"]) {
    const { context, page } = await scene(true, theme, undefined, true);
    await page.evaluate(() => window.kjTest.showSendPreview());
    await page
      .getByRole("dialog", { name: "发送到设备", exact: true })
      .waitFor();
    await assertPills(page);
    await shot(page, "05-send-pills-mobile-" + theme + ".png", true);
    await page.keyboard.press("Escape");
    await context.close();
    checks.push("412px mobile shared SendRow drawer fixture " + theme);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    pillsOnly
      ? "tests/continuity-pills-result.json"
      : "tests/continuity-ui-result.json",
    JSON.stringify({ checks, errors, images }, null, 2),
  );
  console.log(
    JSON.stringify({ passed: true, checks, images: images.length }, null, 2),
  );
} finally {
  await browser.close();
  await desktop.close();
  await mobile.close();
}
