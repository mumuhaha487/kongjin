import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchExtension } from "./browser.mjs";
const context = await launchExtension(
  await mkdtemp(resolve("tests/.continuity-perf-")),
  resolve("../release/unpacked"),
);
const errors = [],
  independent = [],
  immediateReopen = [];
const p95 = (values) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
let page;
try {
  await context.route("https://kongjing.inc.re/**", (route) => route.abort());
  for (const [name, samples] of [
    ["independent", independent],
    ["immediateReopen", immediateReopen],
  ]) {
    for (let i = 0; i < 20; i++) {
      if (page) await page.close();
      page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        window.__continuityOpens = [];
        const original = indexedDB.open.bind(indexedDB);
        indexedDB.open = function (name, ...args) {
          if (name.includes("continuity"))
            window.__continuityOpens.push(performance.now());
          return original(name, ...args);
        };
      });
      await page.goto("chrome://newtab", { waitUntil: "commit" });
      await page.waitForFunction(
        () => performance.getEntriesByName("kongjing-interactive").length > 0,
      );
      const entry = await page.evaluate(() => ({
        interactive: performance.getEntriesByName("kongjing-interactive")[0]
          .startTime,
        inputReady: !!document.querySelector('input[aria-label="搜索"]'),
      }));
      assert.equal(entry.inputReady, true);
      samples.push(entry);
      if (name === "independent") {
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("kongjing-continuity-ready").length >
            0,
        );
        const sequence = await page.evaluate(() => ({
          frame: performance.getEntriesByName("kongjing-first-frame")[0]
            .startTime,
          paint: performance
            .getEntriesByType("paint")
            .find((e) => e.name === "first-contentful-paint")?.startTime,
          hydrate: performance.getEntriesByName("kongjing-hydration-start")[0]
            .startTime,
          opens: window.__continuityOpens,
        }));
        assert.ok(
          (sequence.paint ?? sequence.frame) < sequence.hydrate,
          JSON.stringify(sequence),
        );
        assert.ok(sequence.opens.every((t) => t >= sequence.hydrate));
        entry.sequence = sequence;
        await page.waitForTimeout(700);
      }
    }
  }
  await page.waitForFunction(
    () => performance.getEntriesByName("kongjing-continuity-ready").length > 0,
  );
  const frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const values = [];
        let last;
        const tick = (t) => {
          if (last !== undefined) values.push(t - last);
          last = t;
          if (values.length === 120) resolve(values);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  frames.sort((a, b) => a - b);
  const result = {
    passed:
      errors.length === 0 &&
      p95(independent.map((s) => s.interactive)) < 300 &&
      p95(immediateReopen.map((s) => s.interactive)) < 300,
    browser: context.browser()?.version(),
    independent,
    immediateReopen,
    independentP95: p95(independent.map((s) => s.interactive)),
    immediateReopenP95: p95(immediateReopen.map((s) => s.interactive)),
    frameMedian: frames[60],
    frameP95: frames[114],
    errors,
    method:
      "Production unpacked Chromium, 20 independent new-tab navigations (prior hydration complete +700ms) and 20 immediate close/reopen after interactive mark, no pause. Navigation start to React effect mark with search input mounted. Nearest-rank P95 (19th sorted sample). Observed first-contentful-paint precedes idle hydration, with double-rAF boundary fallback when PaintTiming is unavailable; page continuity DB opens tracked. 120 idle-home rAF intervals; no CPU/network throttle; all relay requests blocked.",
  };
  await writeFile(
    "tests/continuity-performance-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.passed, true);
} finally {
  await context.close();
}
