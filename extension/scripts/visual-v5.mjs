import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";
import { homeServer } from "./android-server.mjs";
import { fixture, setup } from "./fixtures.mjs";
const out = "../docs/v5-perf/screenshots";
await mkdir(out, { recursive: true });
const b = await chromium.launch({
    executablePath: "tests/.browser/chrome-win/chrome.exe",
  }),
  results = [];
async function freeze(p) {
  await p.evaluate(() => {
    for (const a of document.getAnimations())
      if (a.effect.getTiming().iterations === Infinity) {
        a.pause();
        a.currentTime = 0;
      }
  });
  await p.waitForTimeout(100);
}
async function settings(p, android) {
  if (android) {
    await p.getByRole("button", { name: "我的", exact: true }).click();
    await p.getByRole("menuitem", { name: "设置", exact: true }).click();
  } else await p.getByRole("button", { name: "设置", exact: true }).click();
}
try {
  for (const android of [false, true])
    for (const theme of ["light", "dark"]) {
      const images = {};
      for (const version of ["2.1.4", "2.1.5"]) {
        const server = await homeServer(
          version === "2.1.4"
            ? ".v5-baseline/" + (android ? "android" : "desktop")
            : android
              ? "dist-android"
              : "dist",
          4199,
        );
        const c = await b.newContext({
          viewport: android
            ? { width: 412, height: 915 }
            : { width: 1440, height: 900 },
          deviceScaleFactor: android ? 2.625 : 2,
          isMobile: android,
          hasTouch: android,
          locale: "zh-CN",
        });
        await setup(c, fixture(theme));
        const p = await c.newPage();
        await p.clock.setFixedTime(Date.parse("2026-10-23T12:51:00+08:00"));
        await p.goto(server.base);
        await p.locator(".bookmark-link").first().waitFor();
        await p.waitForTimeout(1800);
        const capture = async (name) => {
          await p.waitForTimeout(900);
          await freeze(p);
          const file = `${out}/visual-${android ? "android" : "desktop"}-${theme}-${name}-${version}.png`;
          await p.screenshot({ path: file });
          images[version] ??= {};
          images[version][name] = file;
        };
        await capture("home");
        await settings(p, android);
        await capture("settings");
        await p.keyboard.press("Escape");
        await p.waitForTimeout(400);
        if (!android) {
          await p.locator(".engine-trigger").click();
          await capture("engines");
          await p.keyboard.press("Escape");
          await p
            .getByRole("button", { name: "添加书签", exact: true })
            .click();
          await capture("bookmark");
          await p.keyboard.press("Escape");
          await p.waitForTimeout(400);
          await p.getByRole("button", { name: "我的", exact: true }).click();
          await capture("me");
        }
        await c.close();
        await server.close();
      }
      for (const name of Object.keys(images["2.1.4"])) {
        const previous = await sharp(images["2.1.4"][name])
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true }),
          current = await sharp(images["2.1.5"][name])
            .removeAlpha()
            .raw()
            .toBuffer();
        let sum = 0,
          count = 0;
        const diff = Buffer.alloc(current.length);
        for (let i = 0; i < current.length; i++) {
          const delta = Math.abs(current[i] - previous.data[i]);
          sum += delta;
          if (delta > 8) count++;
          diff[i] = Math.min(255, delta * 6);
        }
        const meta = previous.info;
        await sharp({
          create: {
            width: meta.width * 2,
            height: meta.height,
            channels: 3,
            background: "#fff",
          },
        })
          .composite([
            { input: images["2.1.4"][name], left: 0, top: 0 },
            { input: images["2.1.5"][name], left: meta.width, top: 0 },
          ])
          .png()
          .toFile(
            `${out}/compare-${android ? "android" : "desktop"}-${theme}-${name}.png`,
          );
        await sharp(diff, {
          raw: { width: meta.width, height: meta.height, channels: 3 },
        })
          .png()
          .toFile(
            `${out}/difference-${android ? "android" : "desktop"}-${theme}-${name}.png`,
          );
        results.push({
          platform: android ? "android" : "desktop",
          theme,
          name,
          meanChannelDelta: sum / current.length,
          channelsOver8Percent: (100 * count) / current.length,
        });
      }
    }
} finally {
  await b.close();
  await writeFile(
    "../docs/v5-perf/visual-results.json",
    JSON.stringify(results, null, 2),
  );
}
console.log(results);
