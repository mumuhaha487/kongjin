import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { launchChrome } from "./browser.mjs";
import { verifyWaveLoops } from "./wave-loop-check.mjs";
import { assertPairingSection } from "./pairing-section-check.mjs";
import {
  fixture,
  setup,
  ready,
  openSettings,
  base,
  github,
} from "./fixtures.mjs";
const browser = await launchChrome(),
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
await setup(context);
const page = await context.newPage();
const passed = [],
  errors = [];
const store = process.env.KJ_STORE === "1";
page.on("pageerror", (e) => errors.push(e.message));
const pass = (name) => {
  passed.push(name);
  console.log("PASS " + name);
};
try {
  await ready(page);
  assert.equal(
    await page.locator(".search-placeholder").innerText(),
    "搜索",
  );
  await page.getByRole("button", { name: "选择搜索引擎" }).click();
  const engineNames = await page
    .getByRole("menu", { name: "搜索引擎", exact: true })
    .getByRole("menuitem")
    .allTextContents();
  assert.deepEqual(engineNames.slice(0, 5), [
    "默认搜索",
    "Google",
    "必应",
    "百度",
    "DuckDuckGo",
  ]);
  await page.getByRole("menuitem", { name: "Google", exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(
    await page.locator(".search-placeholder").innerText(),
    "在 Google 中搜索",
  );
  assert.equal(
    await page.evaluate(
      () => "engine" in window.kjTest.getState().data.settings,
    ),
    false,
  );
  await ready(page);
  assert.equal(
    await page.locator(".search-placeholder").innerText(),
    "搜索",
  );
  pass("默认搜索第一项、临时引擎不保存、重开恢复默认");
  await openSettings(page, "pairing");
  const pairingSections = {
    unpaired: await assertPairingSection(page, { paired: false }),
  };
  await page.getByRole("button", { name: "关闭设置" }).click();
  const pairedContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  try {
    await setup(pairedContext, fixture(), { "kj:mock": { paired: true } });
    const pairedPage = await pairedContext.newPage();
    pairedPage.on("pageerror", (e) => errors.push(e.message));
    await ready(pairedPage);
    await openSettings(pairedPage, "pairing");
    pairingSections.paired = await assertPairingSection(pairedPage, {
      paired: true,
      devices: 3,
    });
  } finally {
    await pairedContext.close();
  }
  pass("配对与同步未配对卡片/已配对三设备列表非空且有效透明度≥0.99");
  const rects = () =>
    page.locator(".header-actions>button,.avatar-anchor").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
  const before = await rects();
  for (let i = 0; i < 20; i++) {
    for (const pt of [before[2], before[0], before[1]])
      await page.mouse.move(pt.x + pt.width / 2, pt.y + pt.height / 2, {
        steps: 2,
      });
    const after = await rects();
    for (let j = 0; j < 3; j++)
      for (const k of ["x", "y", "width", "height"])
        assert.ok(Math.abs(after[j][k] - before[j][k]) < 0.5);
  }
  pass("顶栏三个按钮往返20次，位置和尺寸误差<0.5px");
  await page.getByRole("button", { name: "新建分组", exact: true }).click();
  const group = await page.getByRole("textbox", { name: "新分组名称" });
  await group.fill("工作");
  await page.waitForTimeout(500);
  const bounds = await group.evaluate((el) => {
    const a = el.getBoundingClientRect(),
      b = el.closest(".groups").getBoundingClientRect();
    return {
      inside:
        a.left >= b.left &&
        a.top >= b.top &&
        a.right <= b.right &&
        a.bottom <= b.bottom,
      width: a.width,
      height: a.height,
    };
  });
  assert.equal(bounds.inside, true);
  assert.equal(bounds.width, 120);
  await group.press("Enter");
  await page.getByRole("tab", { name: "工作", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("tab", { name: "工作", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  pass("分组输入框在容器内，120×28，创建后选中");
  await page.getByRole("button", { name: "添加书签", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(
    await page
      .getByRole("dialog")
      .evaluate((el) => document.activeElement === el),
    true,
  );
  assert.equal(await page.locator(".bookmark-preview").innerText(), "未命名");
  assert.equal(await page.locator(".empty-icon svg").count(), 1);
  await page.getByLabel("网址", { exact: true }).fill("https://example.com");
  await page.getByLabel("名称", { exact: true }).fill("示例");
  await page.getByRole("button", { name: "自定义", exact: true }).click();
  await page
    .getByLabel("图标网址", { exact: true })
    .fill("https://example.com/icon.png");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForTimeout(400);
  assert.ok(
    (await page.evaluate(() => window.kjTest.getState().data.bookmarks)).some(
      (b) => b.title === "示例" && b.icon.mode === "custom",
    ),
  );
  pass("书签空状态、自动标题与自定义图标保存");
  const iconBranchResults = [];
  await context.route("https://icon-test.example/**", (route) => {
    const u = route.request().url();
    if (u.endsWith("/site"))
      return route.fulfill({
        contentType: "text/html",
        body: '<link rel="apple-touch-icon" href="/apple.png">',
      });
    if (u.includes("fail")) return route.fulfill({ status: 204 });
    return route.fulfill({
      contentType: "image/webp",
      body: Buffer.from(github.split(",")[1], "base64"),
    });
  });
  for (const source of ["cache", "direct", "relay", "fallback"]) {
    const value = await page.evaluate(
      async ({ source }) => {
        const h = window.kjTest;
        const requests = [];
        const deps = {
          cached: async () =>
            source === "cache" ? "https://icon-test.example/cache" : null,
          permission: async () => source === "direct",
          fetch: async (input, options) => {
            requests.push(String(input));
            return fetch(
              source === "fallback"
                ? "https://icon-test.example/fail"
                : String(input).replace(
                    /https:\/\/relay\.test\/v[12]\/icon/,
                    "https://icon-test.example/relay",
                  ),
              options,
            );
          },
          normalize: async (blob) =>
            h.blobDataUrl(await h.compressImage(blob, "icon")),
        };
        const icon = await h.acquireIcon(
          "https://icon-test.example/site",
          "https://relay.test",
          undefined,
          deps,
        );
        return { source, requests, icon };
      },
      { source },
    );
    assert.equal(!!value.icon.dataUrl, source !== "fallback");
    if (store && source === "direct") {
      assert.equal(value.requests.length, 1);
      assert.ok(
        value.requests[0].startsWith("https://relay.test/v1/icon?host="),
      );
    }
    if (value.icon.dataUrl) assert.equal(value.icon.tone, "dark");
    if (value.icon.dataUrl)
      assert.ok(
        Buffer.from(value.icon.dataUrl.split(",")[1], "base64").length <= 6144,
      );
    iconBranchResults.push({ source, passed: true });
  }
  pass(
    store
      ? "商店图标缓存/中转/字母及禁止直连 route mock"
      : "图标缓存/授权直连/中转/字母四分支 route mock",
  );
  const compression = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d");
    const pixels = ctx.createImageData(256, 256);
    let seed = 7;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647;
      pixels.data[i] = seed % 256;
      pixels.data[i + 1] = (seed >> 4) % 256;
      pixels.data[i + 2] = (seed >> 8) % 256;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const results = [];
    for (const kind of ["avatar", "icon"]) {
      try {
        const out = await window.kjTest.compressImage(blob, kind);
        const bmp = await createImageBitmap(out);
        results.push({
          kind,
          bytes: out.size,
          type: out.type,
          width: bmp.width,
        });
      } catch (e) {
        results.push({ kind, error: e.message });
      }
    }
    let oversize = "";
    try {
      await window.kjTest.compressImage(
        new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]),
        "avatar",
      );
    } catch (e) {
      oversize = e.message;
    }
    return { results, oversize };
  });
  assert.equal(compression.oversize, "图片需小于 2 MB");
  for (const item of compression.results) {
    if (item.error) assert.match(item.error, /复杂|无法读取/);
    else {
      assert.ok(item.bytes <= (item.kind === "avatar" ? 8192 : 6144));
      assert.ok([32, 64, 96].includes(item.width));
    }
  }
  pass("真实 Canvas 压缩头像/图标、噪声图上限与2MB拒绝");
  await openSettings(page, "data");
  await page
    .locator("#settings-data")
    .getByRole("button", { name: "文本码", exact: true })
    .first()
    .click();
  await page.getByLabel("导出口令").fill("browser-test-pass");
  await page.getByRole("button", { name: "生成导入码", exact: true }).click();
  const output = page.getByLabel("生成的导入码");
  await output.waitFor();
  const code = await output.inputValue();
  assert.ok(code.startsWith("KJ2E."));
  await page
    .locator("#settings-data")
    .getByRole("button", { name: "文本码", exact: true })
    .last()
    .click();
  await page.getByLabel("粘贴导入码").fill(code);
  await page.getByLabel("导入口令").fill("wrong");
  await page.getByRole("button", { name: "解析", exact: true }).click();
  await page.getByText("口令不正确", { exact: true }).waitFor();
  await page.getByLabel("导入口令").fill("browser-test-pass");
  await page.getByRole("button", { name: "解析", exact: true }).click();
  await page.locator(".preview-card").waitFor();
  await page
    .locator(".preview-card")
    .getByRole("button", { name: "导入", exact: true })
    .click();
  await page.getByText("导入成功", { exact: true }).waitFor();
  pass("加密文本导出、错误口令、解析预览和合并导入");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.kjTest.getState().open({ type: "pairing" });
  });
  assert.equal(
    await page.locator(".pair-privacy").getAttribute("href"),
    store ? "https://kongjing.inc.re/privacy" : "https://sync.example.com/privacy",
  );
  await page
    .getByRole("dialog", { name: "实时配对", exact: true })
    .getByRole("button", { name: "加入已有配对组", exact: true })
    .click();
  await page.getByLabel("配对码", { exact: true }).fill("8f3qzt7m2c");
  assert.equal(
    await page.getByLabel("配对码", { exact: true }).inputValue(),
    "KJ-8F3QZ-T7M2C",
  );
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("heading", { name: "核对安全码" }).waitFor();
  assert.equal(
    (await page.locator(".sas-code").innerText()).replace(/\s/g, ""),
    "482913",
  );
  assert.equal(
    await page.locator(".pair-content .help").innerText(),
    "对方设备：MacBook · Chrome",
  );
  await page.getByRole("button", { name: "一致", exact: true }).click();
  await page.getByRole("heading", { name: "配对成功" }).waitFor();
  await page.waitForTimeout(2300);
  assert.equal(await page.getByRole("dialog").count(), 0);
  pass("配对 mock 加入、SAS显示、确认与成功自动关闭");
  const popupContext = await browser.newContext({
    viewport: { width: 360, height: 560 },
    deviceScaleFactor: 2,
  });
  const popupData = fixture();
  popupData.settings.autoClose = false;
  await setup(popupContext, popupData, {
    "kj:popup": {
      id: 1,
      url: "https://example.com/article",
      title: "示例文章",
    },
  });
  await popupContext.route("https://example.com/**", (r) =>
    r.fulfill({ status: 204 }),
  );
  const popup = await popupContext.newPage();
  await popup.goto(base + "/popup.html");
  await popup
    .getByRole("button", { name: "收藏到空境", exact: true })
    .waitFor();
  assert.equal(
    await popup
      .locator(".popup-app")
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await popup.getByLabel("网页标题").focus();
  await popup.keyboard.press("Enter");
  assert.equal(await popup.locator(".saved-success").count(), 0);
  await popup.locator(".popup-app").focus();
  await popup.keyboard.press("Enter");
  await popup.locator(".saved-success").waitFor();
  await popup.reload();
  await popup.getByRole("button", { name: "更新", exact: true }).waitFor();
  await popup.getByLabel("网页标题").fill("更新后的文章");
  await popup.getByRole("button", { name: "更新", exact: true }).click();
  // Completion is acknowledged only after the shared write queue commits.
  await popup.locator(".saved-success").waitFor();
  await popup.reload();
  assert.equal(await popup.getByLabel("网页标题").inputValue(), "更新后的文章");
  await popup.getByRole("button", { name: "移除", exact: true }).click();
  await popup
    .getByRole("button", { name: "收藏到空境", exact: true })
    .waitFor();
  await popupContext.close();
  pass("popup 收藏/更新/移除（持久化回读）");
  await openSettings(page, "data");
  const section = page.locator("#settings-data");
  await section
    .getByRole("button", { name: "文件", exact: true })
    .first()
    .click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出文件", exact: true }).click(),
  ]);
  const exported = await readFile(await download.path());
  assert.equal(JSON.parse(exported).format, "kongjing-backup");
  await page.evaluate(() =>
    window.kjTest.getState().update((d) =>
      d.bookmarks.push({
        ...d.bookmarks[0],
        id: "replace-marker",
        title: "替换应移除",
        updatedAt: Date.now(),
      }),
    ),
  );
  await section
    .getByRole("button", { name: "文件", exact: true })
    .last()
    .click();
  await section.locator("input[type=file]").setInputFiles({
    name: "kongjing-backup.json",
    mimeType: "application/json",
    buffer: exported,
  });
  await page.locator(".preview-card").waitFor();
  await page.getByRole("radio", { name: "替换当前数据", exact: true }).check();
  await page
    .locator(".preview-card")
    .getByRole("button", { name: "导入", exact: true })
    .click();
  await page.getByRole("button", { name: "替换", exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(
    await page.evaluate(() =>
      window.kjTest
        .getState()
        .data.bookmarks.some((b) => b.id === "replace-marker"),
    ),
    false,
  );
  pass("JSON文件导出/导入、预览、替换二次确认和真实数据替换");
  assert.equal(await page.locator("select").count(), 0);
  await page
    .getByRole("button", { name: "快速收藏默认分组", exact: true })
    .click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  assert.equal(
    await page.evaluate(
      () => window.kjTest.getState().data.settings.quickGroup,
    ),
    "default-common",
  );
  await page
    .getByRole("menu", { name: "快速收藏默认分组", exact: true })
    .waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "快速收藏默认分组", exact: true })
    .click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".settings-panel").count(), 1);
  assert.equal(
    await page
      .getByRole("button", { name: "默认搜索引擎", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.locator("#settings-about a").getAttribute("href"),
    store ? "https://kongjing.inc.re/privacy" : "https://sync.example.com/privacy",
  );
  if (store) {
    assert.equal(
      await page.getByRole("switch", { name: "空境栏", exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "允许读取网站图标", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.locator("#settings-bar h3").innerText(),
      "快速收藏",
    );
  }
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.evaluate(() => window.kjTest.getState().setting("theme", "dark"));
  await page.getByRole("tab", { name: "常用", exact: true }).click();
  await page.waitForTimeout(350);
  const toneFilter = await page
    .locator('.bookmark-link img[data-tone="dark"]')
    .first()
    .evaluate((el) => getComputedStyle(el).filter);
  assert.match(toneFilter, /invert\(1\)/);
  pass("v2.1单色图标反色、鼠标初始焦点、popup Enter规则、自绘下拉与Esc");
  await page.evaluate(() => window.kjTest.getState().setting("theme", "light"));
  await page.waitForTimeout(800);
  await openSettings(page, "data");
  assert.equal(
    await page
      .getByRole("switch", { name: "收藏后自动关闭弹窗", exact: true })
      .getAttribute("aria-checked"),
    "true",
  );
  await page
    .locator("#settings-data")
    .getByRole("button", { name: "文件", exact: true })
    .last()
    .click();
  const resetGap = await page
    .locator("#settings-data .reset-row")
    .evaluate(
      (el) =>
        el.getBoundingClientRect().top -
        el.previousElementSibling.getBoundingClientRect().bottom,
    );
  assert.equal(resetGap, 16);
  pass("默认自动关闭开启，选择文件与恢复默认行相距16px");
  await page.getByRole("button", { name: "关闭设置" }).click();
  const syncStates = [];
  for (const state of [
    {
      phase: "online",
      connection: "online",
      syncing: false,
      token: "--success",
      text: "已连接 · 刚刚同步",
    },
    {
      phase: "syncing",
      connection: "online",
      syncing: true,
      token: "--accent",
      text: "正在同步…",
    },
    {
      phase: "offline",
      connection: "offline",
      syncing: false,
      token: "--text-3",
      text: "离线 · 恢复网络后自动同步",
    },
    {
      phase: "error",
      connection: "online",
      syncing: false,
      error: "NETWORK",
      token: "--danger",
      text: "同步出错 · 点击重试",
    },
  ]) {
    await page.evaluate(
      (state) =>
        window.kjTest.setState({
          status: {
            ...window.kjTest.getState().status,
            paired: true,
            connection: state.connection,
            syncing: state.syncing,
            error: state.error,
            lastSyncAt: Date.now(),
          },
        }),
      state,
    );
    const status = page.locator(".sync-status");
    assert.equal(await status.innerText(), state.text);
    assert.equal(
      await status.getAttribute("class"),
      "sync-status " + state.phase,
    );
    const visual = await status.locator("span").evaluate((dot, token) => {
      const sample = document.createElement("span");
      sample.style.backgroundColor = `var(${token})`;
      dot.parentElement.append(sample);
      const expected = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return {
        actual: getComputedStyle(dot).backgroundColor,
        expected,
        animation: getComputedStyle(dot).animationName,
      };
    }, state.token);
    assert.equal(visual.actual, visual.expected);
    assert.equal(visual.animation !== "none", state.phase === "syncing");
    await status.click();
    assert.equal(
      await page.locator(".status-line").getAttribute("class"),
      "status-line " + state.phase,
    );
    await page.getByRole("button", { name: "关闭设置" }).click();
    syncStates.push({ phase: state.phase, text: state.text, ...visual });
  }
  pass("同步在线/同步中/离线/错误的圆点颜色、呼吸、文字与设置状态一致");
  const wavePage = await context.newPage();
  await ready(wavePage);
  const waveLoops = await verifyWaveLoops(wavePage);
  await wavePage.close();
  pass("两主题三层云海0%与100%整周期像素完全一致");
  await writeFile(
    store ? "tests/ui-store-result.json" : "tests/ui-result.json",
    JSON.stringify(
      {
        passed,
        errors,
        pairingSections,
        bounds,
        iconBranchResults,
        compression,
        resetGap,
        syncStates,
        waveLoops,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
