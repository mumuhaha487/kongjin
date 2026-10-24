import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchChrome } from "./browser.mjs";
import { homeServer } from "./android-server.mjs";
import { mobileOptions, nativeMock, bridgeCall } from "./android-fixtures.mjs";
import { checkAndroidEngine } from "./worker-safety.mjs";
await checkAndroidEngine("dist-android");
async function walk(dir) {
  const paths = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    paths.push(...(e.isDirectory() ? await walk(p) : [p]));
  }
  return paths;
}
const paths = await walk("dist-android");
for (const path of paths) {
  assert.doesNotMatch(
    path,
    /[\\/](?:manifest\.json|popup\.html|background\.js|bar\.js)$|\.(?:pem|map)$/,
  );
  if (!/\.(?:js|html|css)$/.test(path)) continue;
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(
    text,
    /\bchrome\.[a-zA-Z]+|chrome-extension:|kj:mock|window\.kjTest|<all_urls>|registerContentScripts|PRIVATE KEY|ADMIN_KEY/,
  );
  if (path.endsWith(".html"))
    for (const script of text.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script>/g,
    )) {
      assert.match(script[1], /src=["']\.\//);
      assert.equal(script[2].trim(), "");
    }
}
assert.match(
  await readFile("dist-android/READY.md", "utf8"),
  /https:\/\/appassets.androidplatform.net\/home\/index.html/,
);
const server = await homeServer("dist-android", 4184),
  browser = await launchChrome({ args: [] }),
  errors = [],
  resources = [],
  samples = [];
try {
  // Exercise the exact appassets origin and /home/ mount using only local files.
  const context = await browser.newContext(mobileOptions);
  await nativeMock(context);
  await context.route(
    "https://appassets.androidplatform.net/home/**",
    async (route) => {
      const local = server.base.replace(
        "/index.html",
        new URL(route.request().url()).pathname.replace("/home", ""),
      );
      const response = await fetch(local);
      resources.push({
        path: new URL(route.request().url()).pathname,
        status: response.status,
      });
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
  page.on("pageerror", (e) => errors.push(e.message));
  for (let i = 0; i < 5; i++) {
    await page.goto("https://appassets.androidplatform.net/home/index.html");
    await page.waitForFunction(() =>
      window.__nativeCalls.some((c) => c.method === "ready"),
    );
    samples.push(
      await page.evaluate(() => ({
        interactive: performance.getEntriesByName("kongjing-interactive")[0]
          .startTime,
        nativeReady: performance.getEntriesByName("kongjing-native-ready")[0]
          .startTime,
      })),
    );
  }
  const worker = await page.evaluate(async () => {
    const url = new URL("pow.worker.js", document.baseURI).href;
    const proof = await new Promise((resolve, reject) => {
      const w = new Worker(url, { type: "module" });
      const timer = setTimeout(() => {
        w.terminate();
        reject(Error("PoW Worker timeout"));
      }, 5000);
      w.onerror = (error) => {
        clearTimeout(timer);
        w.terminate();
        reject(error);
      };
      w.onmessage = ({ data }) => {
        clearTimeout(timer);
        w.terminate();
        data.error ? reject(Error(data.error)) : resolve(data);
      };
      w.postMessage({
        challenge: btoa("android-worker-check").replace(/=+$/, ""),
        difficulty: 4,
        expiresAt: Date.now() + 60000,
      });
    });
    if (!proof.nonce) throw Error("PoW Worker did not return a nonce");
    return { url, solved: true };
  });
  await page.evaluate(() => document.fonts.ready);
  assert.equal((await bridgeCall(page, "getGroups")).ok, true);
  const frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const values = [];
        let last = performance.now();
        const frame = (t) => {
          values.push(t - last);
          last = t;
          if (values.length === 120) resolve(values.slice(1));
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  assert.ok(resources.every((r) => r.status === 200));
  assert.ok(resources.some((r) => r.path.endsWith(".woff2")));
  assert.deepEqual(errors, []);
  const sorted = [...frames].sort((a, b) => a - b);
  const result = {
    passed: true,
    origin: "https://appassets.androidplatform.net/home/index.html",
    samples,
    frameMedian: sorted[Math.floor(sorted.length / 2)],
    frameP95: sorted[Math.floor(sorted.length * 0.95)],
    worker,
    resources,
    errors,
  };
  await writeFile(
    "tests/android-check-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        samples,
        frameMedian: result.frameMedian,
        frameP95: result.frameP95,
        localResources: resources.length,
        errors,
      },
      null,
      2,
    ),
  );
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
