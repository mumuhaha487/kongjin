import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchChrome } from "./browser.mjs";
import { setup, ready, openSettings } from "./fixtures.mjs";
const browser = await launchChrome(),
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
await setup(context);
const page = await context.newPage();
const passed = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const pass = (name) => {
  passed.push(name);
  console.log("PASS " + name);
};
try {
  await ready(page);
  await openSettings(page);
  assert.equal(
    await page
      .locator(".settings-panel")
      .evaluate((el) => document.activeElement === el),
    true,
  );
  for (let i = 0; i < 35; i++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .locator(".settings-panel")
        .evaluate((el) => el.contains(document.activeElement)),
      true,
    );
  }
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page
      .locator(".settings-panel")
      .evaluate((el) => el.contains(document.activeElement)),
    true,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  assert.equal(
    await page
      .getByRole("button", { name: "设置", exact: true })
      .evaluate((el) => document.activeElement === el),
    true,
  );
  pass("设置容器初始焦点、双向Tab陷阱、Esc归还");
  await page.getByRole("button", { name: "添加书签", exact: true }).click();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByRole("dialog")
        .evaluate((el) => el.contains(document.activeElement)),
      true,
    );
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  assert.equal(
    await page
      .getByRole("button", { name: "添加书签", exact: true })
      .evaluate((el) => document.activeElement === el),
    true,
  );
  pass("书签对话框焦点陷阱、Esc和触发按钮归还");
  await page.getByRole("button", { name: "我的", exact: true }).click();
  await page.waitForTimeout(250);
  await page.keyboard.press("End");
  assert.match(
    await page.evaluate(() => document.activeElement.textContent),
    /设置/,
  );
  await page.keyboard.press("Home");
  assert.match(
    await page.evaluate(() => document.activeElement.textContent),
    /编辑头像/,
  );
  await page.keyboard.press("ArrowDown");
  assert.match(
    await page.evaluate(() => document.activeElement.textContent),
    /配对与同步/,
  );
  await page.keyboard.press("Escape");
  pass("我的菜单Home/End/方向键与Esc");
  await page.keyboard.press("/");
  assert.equal(
    await page
      .getByRole("textbox", { name: "搜索" })
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await page.keyboard.press("Escape");
  pass("搜索快捷键与Esc");
  const reduce = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  await setup(reduce);
  const p = await reduce.newPage();
  await ready(p);
  assert.equal(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  assert.equal(
    await p
      .locator(".orbit-glint-sprite")
      .evaluate((el) => getComputedStyle(el).display),
    "none",
  );
  await reduce.close();
  pass("窄屏无水平溢出、reduced-motion停止背景");
  assert.deepEqual(errors, []);
  await writeFile(
    process.env.KJ_STORE === "1"
      ? "tests/accessibility-store-result.json"
      : "tests/accessibility-result.json",
    JSON.stringify({ passed, errors }, null, 2),
  );
} finally {
  await browser.close();
}
