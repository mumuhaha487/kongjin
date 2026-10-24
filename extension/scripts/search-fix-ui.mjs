import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchChrome } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import { fixture, setup } from "./fixtures.mjs";
import { mobileOptions, nativeMock } from "./android-fixtures.mjs";
const browser = await launchChrome({ args: [] }),
  servers = [],
  checks = [],
  errors = [];
const input = "baidu.com是什么网站";
const expected = "https://www.bing.com/search?q=" + encodeURIComponent(input);
try {
  for (const platform of ["self", "store", "android"]) {
    const android = platform === "android",
      store = platform === "store";
    const server = await homeServer(
      android ? "dist-android-qa" : store ? "dist-store-qa" : "dist-qa",
      4198 + servers.length,
    );
    servers.push(server);
    const context = await browser.newContext(
      android
        ? mobileOptions
        : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
    );
    if (android) await nativeMock(context);
    await setup(context, fixture("light"));
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.base);
    await page.waitForFunction(() => !!window.kjTest);
    await page.waitForTimeout(1500);
    assert.equal(
      await page.locator(".search-placeholder").innerText(),
      android ? "在必应中搜索" : "搜索",
    );
    if (platform !== "store" && !android) {
      await page.getByRole("button", { name: "选择搜索引擎" }).click();
      await page.getByRole("menuitem", { name: "必应", exact: true }).click();
    }
    if (store)
      await page.evaluate(() => {
        window.__searchCalls = [];
        window.chrome = {
          runtime: { id: "qa-search" },
          search: { query: async (args) => window.__searchCalls.push(args) },
        };
      });
    const field = page.getByRole("textbox", { name: "搜索", exact: true });
    await field.fill(input);
    assert.equal(await page.locator(".address-hint").count(), 0);
    assert.equal(await page.locator(".search-hint").innerText(), "");
    if (!android && !store)
      await page.route("https://www.bing.com/search?**", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Search result</title>",
        }),
      );
    await field.press("Enter");
    if (android) {
      await page.waitForFunction(() =>
        window.__nativeCalls.some((c) => c.method === "open"),
      );
      assert.equal(
        (
          await page.evaluate(() =>
            window.__nativeCalls.filter((c) => c.method === "open").at(-1),
          )
        ).args[0],
        expected,
      );
    } else if (store) {
      await page.waitForFunction(() => window.__searchCalls.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__searchCalls), [
        { text: input, disposition: "CURRENT_TAB" },
      ]);
    } else {
      await page.waitForURL(expected);
      assert.equal(page.url(), expected);
    }
    checks.push(platform + ": 原文搜索、无网址提示、实际目标/接口参数正确");
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    "tests/search-fix-ui-result.json",
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser.close();
  for (const server of servers) await server.close();
}
