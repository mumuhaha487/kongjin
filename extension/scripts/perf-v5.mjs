import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { homeServer } from "./android-server.mjs";
import { fixture, setup } from "./fixtures.mjs";

const phase = process.argv[2] || "baseline";
const root = resolve("../docs/v5-perf");
await mkdir(root + "/traces", { recursive: true });
const browser = await chromium.launch({
  executablePath: resolve("tests/.browser/chrome-win/chrome.exe"),
  headless: true,
  args: ["--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND"],
});
const results = [];
async function settings(page) {
  const direct = page.getByRole("button", { name: "设置", exact: true });
  if (await direct.count()) await direct.click();
  else {
    await page.getByRole("button", { name: "我的", exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  }
}
async function capture(page, cdp, name, action) {
  await cdp.send("Tracing.start", {
    categories:
      "toplevel,devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing",
    transferMode: "ReturnAsStream",
  });
  const start = performance.now();
  await action();
  const elapsed = performance.now() - start;
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  const { stream } = await done;
  let raw = "";
  for (;;) {
    const v = await cdp.send("IO.read", { handle: stream });
    raw += v.data;
    if (v.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  const trace = JSON.parse(raw);
  await writeFile(
    root + "/traces/" + phase + "-" + name + ".json.gz",
    gzipSync(raw),
  );
  const main = trace.traceEvents.find(
    (e) => e.name === "thread_name" && e.args?.name === "CrRendererMain",
  );
  const events = trace.traceEvents.filter(
    (e) => e.pid === main?.pid && e.tid === main?.tid && e.ph === "X",
  );
  const tasks = events
    .filter(
      (e) => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask",
    )
    .map((e) => [e.ts, e.ts + e.dur])
    .sort((a, b) => a[0] - b[0]);
  let busy = 0,
    end = 0;
  for (const [s, t] of tasks) {
    busy += Math.max(0, t - Math.max(s, end));
    end = Math.max(end, t);
  }
  const sum = (name) =>
    events
      .filter((e) => e.name === name)
      .reduce((s, e) => s + (e.dur || 0) / 1000, 0);
  // Sample compositor presentation events: a JS rAF sampler itself wakes the
  // main thread and forces lifecycle updates, invalidating idle measurements.
  const draws = trace.traceEvents
    .filter((e) => e.name === "DrawFrame" && e.pid === main?.pid)
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const frames = draws.slice(1).map((at, i) => (at - draws[i]) / 1000);
  const metric = {
    phase,
    name,
    elapsedMs: +elapsed.toFixed(2),
    busyPercent: +((busy / 1000 / elapsed) * 100).toFixed(2),
    paintMs: +sum("Paint").toFixed(2),
    compositeMs: +sum("CompositeLayers").toFixed(2),
    layerTreeMs: +sum("Layerize").toFixed(2),
    frames: frames.length,
    droppedPercent: +(
      (100 * frames.filter((n) => n > 16.7).length) /
      frames.length
    ).toFixed(2),
    over25msPercent: +(
      (100 * frames.filter((n) => n > 25).length) /
      frames.length
    ).toFixed(2),
    frameP95Ms: +frames
      .sort((a, b) => a - b)
      [Math.floor(frames.length * 0.95)].toFixed(2),
  };
  results.push(metric);
  console.log(JSON.stringify(metric));
}
try {
  for (const platform of ["android", "desktop"]) {
    const dir =
      phase === "baseline"
        ? ".v5-baseline/" + platform
        : platform === "android"
          ? "dist-android"
          : "dist";
    const server = await homeServer(dir, platform === "android" ? 4193 : 4194);
    try {
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport:
            platform === "android"
              ? { width: 412, height: 915 }
              : { width: 1440, height: 900 },
          deviceScaleFactor: platform === "android" ? 2.625 : 2,
          isMobile: platform === "android",
          hasTouch: platform === "android",
          locale: "zh-CN",
        });
        await setup(context, fixture(theme));
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", {
          rate: platform === "android" ? 6 : 4,
        });
        await page.goto(server.base);
        await page.locator(".bookmark-link").first().waitFor();
        await page.waitForTimeout(2500);
        // Visual comparisons use a repeatable background phase. Performance runs remain animated.
        await page.screenshot({
          path:
            root +
            "/screenshots/" +
            phase +
            "-" +
            platform +
            "-" +
            theme +
            "-home.png",
        });
        if (theme === "dark") {
          await capture(page, cdp, platform + "-idle", () =>
            page.waitForTimeout(5000),
          );
          await capture(page, cdp, platform + "-drawer", async () => {
            for (let i = 0; i < 3; i++) {
              await settings(page);
              await page.waitForTimeout(850);
              await page.keyboard.press("Escape");
              await page.waitForTimeout(850);
            }
          });
        }
        await settings(page);
        await page.waitForTimeout(1000);
        await page.screenshot({
          path:
            root +
            "/screenshots/" +
            phase +
            "-" +
            platform +
            "-" +
            theme +
            "-settings.png",
        });
        await context.close();
      }
    } finally {
      await server.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(
    root + "/" + phase + "-metrics.json",
    JSON.stringify(
      {
        method:
          "Chromium CDP CPU throttle; main renderer RunTask union wall duration; Paint/CompositeLayers event sums; compositor DrawFrame intervals >16.7ms (no injected rAF); 5s idle and 3 settings open/close cycles, 850ms each transition wait",
        results,
      },
      null,
      2,
    ),
  );
}
