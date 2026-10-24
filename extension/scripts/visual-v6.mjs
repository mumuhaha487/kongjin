import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";
import { homeServer } from "./android-server.mjs";
import { fixture, setup } from "./fixtures.mjs";
const out = "../docs/v6/screenshots";
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
  for (const android of [false])
    for (const theme of ["light", "dark"]) {
      const images = {}, geometries = {};
      for (const version of ["2.1.6", "2.2.0"]) {
        const server = await homeServer(
          version === "2.1.6"
            ? ".v6-baseline/" + (android ? "android" : "desktop")
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
          await p.waitForTimeout(1800);
          await freeze(p);
          const file = `${out}/v6-visual-${android ? "android" : "desktop"}-${theme}-${name}-${version}.png`;
          await p.screenshot({ path: file });
          images[version] ??= {};
          images[version][name] = file;
          geometries[version] ??= {};
          geometries[version][name] = await p.locator(".settings-panel,.modal,.menu").evaluateAll(nodes => nodes.filter(e=>getComputedStyle(e).visibility==="visible" && e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute("aria-label")||e.className, x:r.x,y:r.y,width:r.width,height:r.height}}));
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
      for (const name of Object.keys(images["2.1.6"])) {
        const ga=geometries["2.1.6"][name],gb=geometries["2.2.0"][name];
        assert.equal(ga.length,gb.length,name+" visible surfaces");
        const maxGeometryDelta=Math.max(0,...ga.flatMap((r,i)=>["x","y","width","height"].map(k=>Math.abs(r[k]-gb[i][k]))));
        assert.ok(maxGeometryDelta<=0.5,JSON.stringify({android,theme,name,maxGeometryDelta,ga,gb}));
        const previous = await sharp(images["2.1.6"][name])
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true }),
          current = await sharp(images["2.2.0"][name])
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
            { input: images["2.1.6"][name], left: 0, top: 0 },
            { input: images["2.2.0"][name], left: meta.width, top: 0 },
          ])
          .png()
          .toFile(
            `${out}/v6-compare-${android ? "android" : "desktop"}-${theme}-${name}.png`,
          );
        await sharp(diff, {
          raw: { width: meta.width, height: meta.height, channels: 3 },
        })
          .png()
          .toFile(
            `${out}/v6-difference-${android ? "android" : "desktop"}-${theme}-${name}.png`,
          );
        results.push({
          platform: android ? "android" : "desktop",
          theme,
          name,
          meanChannelDelta: sum / current.length,
          maxGeometryDelta,
          geometryBefore:ga,geometryAfter:gb,
          channelsOver8Percent: (100 * count) / current.length,
        });
      }
    }
} finally {
  await b.close();
  await writeFile(
    "../docs/v6/v6-visual-results.json",
    JSON.stringify(results, null, 2),
  );
}
console.log(results);
