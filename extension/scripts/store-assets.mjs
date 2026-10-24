import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { preview } from "vite";
import sharp from "sharp";
import {
  siGithub,
  siBilibili,
  siZhihu,
  siYoutube,
  siGmail,
} from "simple-icons";
import { launchChrome } from "./browser.mjs";
import { fixture, setup } from "./fixtures.mjs";
import { assertPairingSection } from "./pairing-section-check.mjs";
const out = resolve("../release/store/assets");
await mkdir(out, { recursive: true });
const server = await preview({
  configFile: false,
  build: { outDir: "dist-store-qa" },
  preview: { host: "127.0.0.1", port: 4180, strictPort: true },
});
const base = "http://127.0.0.1:4180";
const browser = await launchChrome(),
  errors = [],
  checks = [];
const icons = [siGithub, siBilibili, siZhihu, siYoutube, siGmail];
const logoSvg = await readFile("../docs/brand/kongjing-logo.svg");
const brandIcon =
  "data:image/webp;base64," +
  (
    await sharp(logoSvg).resize(64, 64).webp({ quality: 90 }).toBuffer()
  ).toString("base64");
const iconUrls = await Promise.all(
  icons.map(
    async (i) =>
      "data:image/webp;base64," +
      (
        await sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${i.path}" fill="#${i.hex}"/></svg>`,
          ),
        )
          .resize(64, 64)
          .webp({ quality: 90 })
          .toBuffer()
      ).toString("base64"),
  ),
);
let background, styles;
async function scene(theme = "light", extra = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Singapore",
  });
  const data = fixture(theme);
  data.bookmarks.forEach((b, i) => {
    if (iconUrls[i])
      b.icon = {
        mode: "custom",
        dataUrl: iconUrls[i],
        tone: i === 0 ? "dark" : "normal",
      };
  });
  await setup(context, data, {
    "kj:popup": {
      id: 1,
      url: "https://kongjing.inc.re/",
      title: "空境 — 安静的新标签页",
      favIconUrl: brandIcon,
    },
    ...extra,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.setFixedTime(new Date("2026-10-21T12:51:00+08:00"));
  await page.goto(base);
  await page.waitForFunction(() => !!window.kjTest);
  await page.locator(".bookmark-link").first().waitFor();
  await page.waitForTimeout(1000);
  assert.equal(
    await page.locator(".search-placeholder").innerText(),
    "搜索",
  );
  assert.equal(
    await page.locator(".engine-wheel svg").getAttribute("width"),
    "20",
  );
  return { context, page };
}
async function save(page, name, width, height) {
  await page.evaluate(() => document.fonts.ready);
  if (await page.locator(".modal").count()) {
    await page.waitForTimeout(2000);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".modal,.modal-layer")].every(
        (el) => Number(getComputedStyle(el).opacity) >= 0.999,
      ),
    );
  }
  await page.waitForTimeout(800);
  const image = await sharp(await page.screenshot())
    .flatten({ background: "#F4F6FA" })
    .removeAlpha()
    .png()
    .toBuffer();
  const meta = await sharp(image).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.equal(meta.channels, 3);
  assert.equal(meta.hasAlpha, false);
  await writeFile(resolve(out, name), image);
  checks.push({
    name,
    width,
    height,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha,
    sha256: createHash("sha256").update(image).digest("hex"),
  });
  console.log("ASSET " + name);
}
try {
  for (const [number, theme] of [
    [1, "light"],
    [2, "dark"],
  ]) {
    const { context, page } = await scene(theme);
    if (number === 1) {
      background = await page
        .locator(".kongjing-background")
        .evaluate((el) => el.outerHTML);
      styles = await page
        .locator('link[rel="stylesheet"]')
        .evaluateAll((els) =>
          els.map((e) => `<link rel="stylesheet" href="${e.href}">`).join(""),
        );
    }
    await save(page, `screenshot-${number}.png`, 1280, 800);
    await context.close();
  }
  {
    const { context, page } = await scene();
    await page.setContent(
      `<html data-theme="light" data-accent="sky"><head>${styles}<style>html,body{width:1280px;height:800px;margin:0;overflow:hidden}.popup-stage{position:fixed;inset:0;display:grid;place-items:center}.popup-preview{width:360px;border:0;transform:scale(1.5);border-radius:0;box-shadow:var(--shadow-float)}*{animation-play-state:paused!important}</style></head><body>${background}<div class="popup-stage"><iframe class="popup-preview" title="快速收藏" src="${base}/popup.html"></iframe></div></body></html>`,
    );
    const frame = page.frameLocator("iframe");
    await frame
      .getByRole("button", { name: "收藏到空境", exact: true })
      .waitFor();
    await frame
      .locator(".current-title:not(:has(.icon-fetching)) img")
      .waitFor();
    assert.equal(
      await frame.getByLabel("网页标题").inputValue(),
      "空境 — 安静的新标签页",
    );
    assert.equal(
      await frame.locator(".current-title p").innerText(),
      "kongjing.inc.re",
    );
    const iconSource = await frame
      .locator(".current-title img")
      .getAttribute("src");
    assert.ok(iconSource?.startsWith("data:image/webp;base64,"));
    // Compare the actual icon pixels with the original Logo, allowing the
    // documented WebP re-encoding. The fixture route otherwise returns GitHub.
    const shown = await sharp(Buffer.from(iconSource.split(",")[1], "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const expected = await sharp(Buffer.from(brandIcon.split(",")[1], "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.equal(shown.length, expected.length);
    const iconMeanDifference =
      shown.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0) /
      shown.length;
    assert.ok(
      iconMeanDifference < 8,
      "popup must show the Kongjing Logo, not another site's icon",
    );
    const height = await frame
      .locator(".popup-app")
      .evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
    await page
      .locator("iframe")
      .evaluate((el, h) => (el.style.height = h + "px"), height);
    assert.ok(height * 1.5 <= 800);
    assert.equal(
      await frame.getByRole("switch", { name: "空境栏", exact: true }).count(),
      0,
    );
    await save(page, "screenshot-3.png", 1280, 800);
    await context.close();
  }
  {
    const { context, page } = await scene("light", {
      "kj:mock": { paired: true, scenario: "sas" },
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.evaluate(() =>
      window.kjTest.setState({ settingsSection: "pairing" }),
    );
    await assertPairingSection(page, { paired: true, devices: 3 });
    await page.getByRole("button", { name: "添加设备", exact: true }).click();
    await page
      .getByRole("heading", { name: "核对安全码", exact: true })
      .waitFor();
    await assertPairingSection(page, { paired: true, devices: 3 });
    await page
      .locator("#settings-pairing")
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    const listBounds = await page.locator(".device-list").boundingBox();
    const modalBounds = await page.locator(".modal").boundingBox();
    const panelBounds = await page.locator(".settings-panel").boundingBox();
    assert.ok(listBounds.y >= 76 && listBounds.y + listBounds.height < 788);
    assert.ok(
      modalBounds.x < panelBounds.x &&
        modalBounds.x + modalBounds.width <= panelBounds.x + 12,
    );
    await save(page, "screenshot-4.png", 1280, 800);
    await context.close();
  }
  {
    const { context, page } = await scene();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.evaluate(() =>
      window.kjTest.setState({ settingsSection: "appearance" }),
    );
    await page.waitForTimeout(700);
    await page.evaluate(() =>
      window.kjTest.getState().open({ type: "bookmark" }),
    );
    await page.getByLabel("网址", { exact: true }).fill("https://github.com");
    await page.getByLabel("名称", { exact: true }).fill("GitHub");
    await page.getByRole("button", { name: "自定义", exact: true }).click();
    await page
      .locator('input[type="file"]')
      .last()
      .setInputFiles("tests/fixtures/github.webp");
    await save(page, "screenshot-5.png", 1280, 800);
    await context.close();
  }
  const logo = logoSvg.toString("utf8");
  for (const [width, height, small] of [
    [440, 280, true],
    [1400, 560, false],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const home =
      "data:image/png;base64," +
      (await readFile(resolve(out, "screenshot-1.png"))).toString("base64");
    await page.setContent(
      `<html data-theme="light" data-accent="sky"><head>${styles}<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}*{animation:none!important;transition:none!important}.glow-layer,.stars-layer,.orbit-glint,.grain-layer,.wave-2{display:none}.brand{position:absolute;left:40px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:32px}.brand>svg{width:${small ? 96 : 180}px;height:${small ? 96 : 180}px;flex:none}.copy{color:#121826}.copy h1{font-family:var(--font);font-size:${small ? 36 : 80}px;font-weight:600;letter-spacing:.24em;line-height:1.2;margin:0}.copy p{font-family:var(--font);font-size:${small ? 14 : 28}px;font-weight:400;color:rgba(18,24,38,.6);margin:16px 0 0;line-height:1.5;white-space:nowrap}.thumb{position:absolute;width:calc(40% - 48px);right:24px;top:50%;transform:translateY(-50%) rotate(-6deg);border-radius:16px;box-shadow:var(--shadow-float)}.brand{z-index:1}</style></head><body>${background}<div class="brand">${logo}<div class="copy"><h1>空境</h1><p>${small ? "安静的新标签页" : "安静的新标签页 · 书签 · 端到端加密同步"}</p></div></div>${small ? "" : `<img class="thumb" alt="" src="${home}">`}</body></html>`,
    );
    assert.equal(await page.locator(".brand>svg").count(), 1);
    await save(
      page,
      small ? "promo-small-440x280.png" : "promo-marquee-1400x560.png",
      width,
      height,
    );
    await context.close();
  }
  const icon = await sharp(await readFile("../docs/brand/kongjing-logo.svg"), {
    density: 384,
  })
    .resize(96, 96)
    .ensureAlpha()
    .extend({
      top: 16,
      bottom: 16,
      left: 16,
      right: 16,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  await writeFile(resolve(out, "icon-128.png"), icon);
  const meta = await sharp(icon).metadata();
  assert.equal(meta.width, 128);
  assert.equal(meta.height, 128);
  assert.equal(meta.channels, 4);
  assert.equal(meta.hasAlpha, true);
  const pixels = await sharp(icon).ensureAlpha().raw().toBuffer();
  const cornerAlphas = [0, 127, 127 * 128, 128 * 128 - 1].map(
    (i) => pixels[i * 4 + 3],
  );
  assert.deepEqual(cornerAlphas, [0, 0, 0, 0]);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++)
      if (x < 16 || x >= 112 || y < 16 || y >= 112)
        assert.equal(pixels[(y * 128 + x) * 4 + 3], 0);
  assert.ok(pixels.some((v, i) => i % 4 === 3 && v > 0));
  checks.push({
    name: "icon-128.png",
    width: 128,
    height: 128,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha,
    cornerAlphas,
    transparentPadding: 16,
    logoCanvas: { width: 96, height: 96 },
    sha256: createHash("sha256").update(icon).digest("hex"),
  });
  assert.deepEqual(errors, []);
  await writeFile(
    "tests/store-assets-result.json",
    JSON.stringify(
      {
        checks,
        errors,
        basis:
          "STORE §D + PM store round1; 1280×800 DPR1 RGB screenshots, RGB promotions; RGBA icon with 96px Logo and 16px transparent padding; paired three-device settings beside SAS",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.httpServer.close((e) => (e ? reject(e) : resolve())),
  );
}
