import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { homeServer } from "./android-server.mjs";
import {
  mobileOptions,
  nativeMock,
  bridgeCall,
  longPress,
} from "./android-fixtures.mjs";
import { fixture, setup } from "./fixtures.mjs";
const s = await homeServer("dist-android-qa", 4198),
  b = await chromium.launch({
    executablePath: "tests/.browser/chrome-win/chrome.exe",
  }),
  c = await b.newContext(mobileOptions),
  checks = [];
try {
  await nativeMock(c);
  await setup(c, fixture("dark"), { "kj:mock": { paired: true } });
  const p = await c.newPage(),
    errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(s.base);
  await p.waitForFunction(() => window.kongjing?.call);
  await p.waitForTimeout(1000);
  assert.equal(await p.locator(".cloud-wave").count(), 3);
  assert.equal(await p.locator(".twinkle-layer .star-twinkle").count(), 4);
  assert.equal(await p.locator(".orbit-glint-sprite").count(), 0);
  assert.ok(
    await p.locator(".static-sky").evaluate((e) => e.width / innerWidth <= 1.5),
  );
  checks.push(
    "3 periodic cloud canvases / 4 independent twinkles / no Android glint / DPR≤1.5",
  );
  assert.deepEqual(await bridgeCall(p, "setVisible", { visible: "false" }), {
    ok: false,
    error: "INVALID_ARGS",
  });
  const devices = (await bridgeCall(p, "getDevices")).data;
  await bridgeCall(p, "setVisible", { visible: false });
  assert.ok(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("page-hidden")),
  );
  // WAAPI pause commits on the next timeline frame. Sample only after that
  // commit, then require that no hidden animation timeline advances.
  await p.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.ready),
    );
    if (
      document
        .getAnimations()
        .some((animation) => animation.playState === "running")
    )
      throw Error("Hidden animation still running");
  });
  const before = await p.evaluate(() =>
    document.getAnimations().map((a) => a.currentTime),
  );
  await p.waitForTimeout(500);
  assert.deepEqual(
    await p.evaluate(() => document.getAnimations().map((a) => a.currentTime)),
    before,
  );
  assert.deepEqual((await bridgeCall(p, "getDevices")).data, devices);
  await bridgeCall(p, "setVisible", { visible: true });
  await p.waitForTimeout(100);
  assert.equal(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("page-hidden")),
    false,
  );
  checks.push(
    "setVisible validates boolean; pauses all animation timelines; sync host stays available; resumes",
  );
  await p.evaluate(() => document.dispatchEvent(new Event("touchstart")));
  assert.ok(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("background-paused")),
  );
  await p.evaluate(() => document.dispatchEvent(new Event("touchend")));
  await p.waitForTimeout(300);
  assert.ok(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("background-paused")),
  );
  await p.waitForTimeout(400);
  assert.equal(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("background-paused")),
    false,
  );
  checks.push("touch pauses; resumes 600ms after touch end");
  await longPress(p, p.locator(".bookmark-link").first());
  await p.getByRole("dialog", { name: "书签菜单", exact: true }).waitFor();
  await p.waitForTimeout(700);
  assert.ok(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("background-paused")),
  );
  assert.equal(
    await p.getByRole("dialog", { name: "编辑书签", exact: true }).count(),
    0,
  );
  await p.keyboard.press("Escape");
  await p.waitForTimeout(700);
  assert.equal(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("background-paused")),
    false,
  );
  checks.push(
    "portalled long-press action sheet pauses scenery; releasing original finger does not select edit",
  );
  await bridgeCall(p, "openSettings", {});
  await p.waitForTimeout(250);
  assert.ok(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("background-paused")),
  );
  assert.equal(
    await p
      .locator(".settings-panel")
      .evaluate((e) => getComputedStyle(e).backdropFilter),
    "none",
  );
  assert.equal(
    await p.locator("#stage").evaluate((e) => getComputedStyle(e).filter),
    "none",
  );
  assert.equal(
    await p
      .getByRole("switch", { name: "流畅优先", exact: true })
      .getAttribute("aria-checked"),
    "false",
  );
  await p.getByRole("switch", { name: "流畅优先", exact: true }).click();
  assert.ok(
    await p
      .locator("html")
      .evaluate((e) => e.classList.contains("background-static")),
  );
  await p.getByRole("button", { name: "关闭设置", exact: true }).click();
  await p.waitForTimeout(500);
  assert.equal(
    await p
      .locator(".cloud-wave")
      .first()
      .evaluate((e) => e.getAnimations().length),
    0,
  );
  checks.push(
    "drawer pauses scenery; no backdrop or stage filter; smooth-first default off, on stops all background animation",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    "../docs/v5-perf/behavior-results.json",
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(checks);
} finally {
  await b.close();
  await s.close();
}
