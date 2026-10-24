import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchChrome } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import { mobileOptions, nativeMock, bridgeCall } from "./android-fixtures.mjs";
import { legacyEnvironment } from "./android-legacy-env.mjs";
import { decodeBackup } from "../src/lib/backup.ts";
import { version } from "./manifest.mjs";
const server = await homeServer("dist-android", 4186),
  browser = await launchChrome({ args: [] });
const result = { passed: false, modes: [], errors: [] };
try {
  for (const mode of ["missing", "raw-rejected"]) {
    const context = await browser.newContext(mobileOptions);
    await nativeMock(context);
    await legacyEnvironment(context, mode);
    await context.route(
      "https://appassets.androidplatform.net/home/**",
      async (route) => {
        const response = await fetch(
          server.base.replace(
            "index.html",
            new URL(route.request().url()).pathname.replace("/home/", ""),
          ),
        );
        await route.fulfill({
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") },
          body: Buffer.from(await response.arrayBuffer()),
        });
      },
    );
    await context.route("https://kongjing.inc.re/v1/icon?**", (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      result.errors.push({ mode, error: error.message }),
    );
    await page.goto("https://appassets.androidplatform.net/home/index.html");
    await page.waitForFunction(() =>
      window.__nativeCalls.some((c) => c.method === "ready"),
    );
    await page.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
    await page.getByRole("button", { name: "切换主题", exact: true }).tap();
    await page.waitForTimeout(700);
    assert.equal(await page.locator(".theme-snapshot").count(), 0);
    assert.ok(
      await page.evaluate(() =>
        window.__nativeCalls.some((c) => c.method === "setTheme"),
      ),
    );
    const apis = await page.evaluate(async () => {
      const uuid = crypto.randomUUID(),
        controller = AbortSignal.timeout(1);
      await new Promise((r) => setTimeout(r, 20));
      const source = { map: new Map([["x", new Uint8Array([1, 2])]]) };
      const cloned = structuredClone(source);
      const bytes = new TextEncoder().encode("兼容流".repeat(200));
      const run = async (input, stream) =>
        new Uint8Array(
          await new Response(
            new Blob([input]).stream().pipeThrough(stream),
          ).arrayBuffer(),
        );
      for (const format of ["deflate-raw", "deflate", "gzip"]) {
        const encoded = await run(bytes, new CompressionStream(format));
        const nativeDecoded = await run(
          encoded,
          new window.__legacyNativeStreams.DecompressionStream(format),
        );
        const nativeEncoded = await run(
          bytes,
          new window.__legacyNativeStreams.CompressionStream(format),
        );
        const decoded = await run(
          nativeEncoded,
          new DecompressionStream(format),
        );
        if (
          String(decoded) !== String(bytes) ||
          String(nativeDecoded) !== String(bytes)
        )
          throw Error("Stream mismatch " + format);
      }
      return {
        uuid,
        aborted: controller.aborted,
        clone:
          cloned !== source &&
          cloned.map !== source.map &&
          cloned.map.get("x")[1] === 2,
        inert: "inert" in HTMLElement.prototype,
        arrayAt: ["one", "two"].at(-1) === "two" && [1].at(3) === undefined,
        unusedNewAPIsAbsent:
          !Array.prototype.findLast &&
          !Array.prototype.toSorted &&
          !Object.hasOwn &&
          !Promise.withResolvers,
      };
    });
    assert.match(
      apis.uuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    for (const key of ["aborted", "clone", "inert", "arrayAt", "unusedNewAPIsAbsent"])
      assert.equal(apis[key], true, key);
    const url = `https://example.com/legacy-${mode}`;
    assert.equal(
      (
        await bridgeCall(page, "addBookmark", {
          url,
          title: "旧WebView收藏",
          iconDataUrl: await page.evaluate(() => window.__testIcon),
        })
      ).ok,
      true,
    );
    await bridgeCall(page, "openSettings", { section: "data" });
    assert.equal(
      await page
        .locator(".settings-panel")
        .evaluate((el) => getComputedStyle(el).backdropFilter),
      "none",
    );
    await page
      .getByText(`空境 安卓版 1.0.1 · 主页 ${version}`, { exact: true })
      .waitFor({ state: "attached" });
    assert.equal(
      await page
        .locator("#stage")
        .evaluate(
          (el) => el.inert && el.getAttribute("aria-hidden") === "true",
        ),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(
        () => !!document.activeElement.closest(".settings-panel"),
      ),
      true,
    );
    const data = page.locator("#settings-data");
    await data
      .getByRole("button", { name: "文本码", exact: true })
      .first()
      .tap();
    await page.getByRole("button", { name: "生成导入码", exact: true }).tap();
    const output = page.getByLabel("生成的导入码");
    await output.waitFor();
    const plain = await output.inputValue();
    assert.ok(
      (await decodeBackup(plain)).data.bookmarks.some((b) => b.url === url),
    );
    await page.getByLabel("导出口令").fill("legacy-passphrase");
    await page.getByRole("button", { name: "生成导入码", exact: true }).tap();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="生成的导入码"]')
        .value.startsWith("KJ2E."),
    );
    const encrypted = await output.inputValue();
    assert.ok(
      (await decodeBackup(encrypted, "legacy-passphrase")).data.bookmarks.some(
        (b) => b.url === url,
      ),
    );
    await data
      .getByRole("button", { name: "文本码", exact: true })
      .last()
      .tap();
    for (const code of [plain, encrypted]) {
      await page.getByLabel("粘贴导入码").fill(code);
      if (code.startsWith("KJ2E."))
        await page.getByLabel("导入口令").fill("legacy-passphrase");
      await page.getByRole("button", { name: "解析", exact: true }).tap();
      await page.locator(".preview-card").waitFor();
      await page
        .locator(".preview-card")
        .getByRole("button", { name: "导入", exact: true })
        .tap();
      await page.locator(".preview-card").waitFor({ state: "detached" });
    }
    assert.equal(
      (await bridgeCall(page, "findBookmark", { url })).data.found,
      true,
    );
    await page.keyboard.press("Escape");
    await page.locator(".settings-panel").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#stage").evaluate((el) => el.inert),
      false,
    );
    if (mode === "missing") {
      await bridgeCall(page, "openSettings", {});
      const about = page.getByText(`空境 安卓版 1.0.1 · 主页 ${version}`, {
        exact: true,
      });
      await about.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const box = await about.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 412);
      await page.screenshot({ path: "tests/webview87-about.png" });
      await page.keyboard.press("Escape");
      await page.locator(".settings-panel").waitFor({ state: "hidden" });
    }
    // Compare all precomputed color endpoints against the current browser's
    // original color-mix result on an actual rendered property, not text tokens.
    const colorChecks = await page.evaluate(async () => {
      const root = document.documentElement,
        probe = document.createElement("div");
      document.body.append(probe);
      const failures = [];
      for (const theme of ["dark", "light"])
        for (const accent of ["sky", "mist", "dusk", "nebula", "sakura"]) {
          root.dataset.theme = theme;
          root.dataset.accent = accent;
          await new Promise((r) => setTimeout(r, 650));
          for (const [token, space, percent] of [
            ["--accent-soft", "oklab", 16],
            ["--accent-glow", "srgb", 12],
          ]) {
            probe.style.backgroundColor = `var(${token})`;
            const adapted = getComputedStyle(probe).backgroundColor;
            probe.style.backgroundColor = `color-mix(in ${space}, var(--accent) ${percent}%, transparent)`;
            // Canvas converts either color space to the same sRGB bytes.
            const original = getComputedStyle(probe).backgroundColor;
            const canvas = document.createElement("canvas"),
              c = canvas.getContext("2d");
            // Compare composited visible pixels. Reading transparent pixels would
            // unpremultiply alpha and magnify 1-byte rounding by up to 8x.
            for (const background of ["#000", "#fff"]) {
              const render = (color) => {
                c.fillStyle = background;
                c.fillRect(0, 0, 1, 1);
                c.fillStyle = color;
                c.fillRect(0, 0, 1, 1);
                return [...c.getImageData(0, 0, 1, 1).data];
              };
              const a = render(adapted),
                b = render(original);
              if (a.some((x, i) => Math.abs(x - b[i]) > 1))
                failures.push({ theme, accent, token, background, a, b });
            }
          }
        }
      probe.remove();
      return failures;
    });
    assert.deepEqual(colorChecks, []);
    result.modes.push({
      mode,
      apis,
      checks: [
        "production home loads at appassets",
        "all three stream formats cross-decode",
        "KJ2/KJ2E export → desktop decode → UI import",
        "inert/focus/Esc",
        "native appVersion",
        "20 color token endpoints within 1/255",
      ],
    });
    await context.close();
  }
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.failure = String(error);
  throw error;
} finally {
  await writeFile(
    "tests/webview87-smoke-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  await server.close();
}
