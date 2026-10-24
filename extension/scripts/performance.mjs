import { launchChrome } from "./browser.mjs";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
const b = await launchChrome(),
  samples = [],
  frames = [];
for (let i = 0; i < 20; i++) {
  const c = await b.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const p = await c.newPage();
  await p.goto("http://127.0.0.1:4175");
  await p.waitForFunction(
    () => performance.getEntriesByName("kongjing-interactive").length,
  );
  samples.push(
    await p.evaluate(
      () => performance.getEntriesByName("kongjing-interactive")[0].startTime,
    ),
  );
  await c.close();
}
for (const action of ["background", "settings", "bookmark"]) {
  const c = await b.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const p = await c.newPage();
  await p.goto("http://127.0.0.1:4175");
  await p.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    window.framePromise = new Promise((r) => {
      let last, start;
      const values = [];
      const step = (t) => {
        start ??= t;
        if (last) values.push(t - last);
        last = t;
        if (t - start < 2000) requestAnimationFrame(step);
        else r(values);
      };
      requestAnimationFrame(step);
    });
  });
  if (action === "settings")
    await p.getByRole("button", { name: "设置", exact: true }).click();
  if (action === "bookmark")
    await p.getByRole("button", { name: "添加书签", exact: true }).click();
  const v = await p.evaluate(() => window.framePromise),
    s = v.toSorted((a, b) => a - b);
  frames.push({
    action,
    n: v.length,
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.floor(s.length * 0.95)],
    max: Math.max(...v),
    over34: v.filter((v) => v > 34).length,
  });
  await c.close();
}
const sorted = samples.toSorted((a, b) => a - b);
const result = {
  browser: b.version(),
  environment: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    platform: platform(),
    os: release(),
  },
  method:
    "Production vite preview; 20 cold contexts; navigationStart to React effect installs handlers; no CPU/network throttling. DPR2 1440x900. rAF intervals over2s each.",
  interactiveMs: {
    samples,
    min: sorted[0],
    median: (sorted[9] + sorted[10]) / 2,
    p95: sorted[18],
    max: sorted[19],
  },
  frames,
};
await writeFile(
  "tests/performance-result.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
await b.close();
