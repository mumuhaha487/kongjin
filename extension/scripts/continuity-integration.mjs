import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { launchExtension } from "./browser.mjs";
const id = "agijcmabomapmbobdgblmckibkpobdij",
  relayUrl = "http://127.0.0.1:8790";
const dir = await mkdtemp(resolve("tests/.continuity-local-"));
const result = {
  passed: false,
  relay: relayUrl,
  online: false,
  checks: [],
  errors: [],
  timings: {},
  permissionTest:
    "Test-only manifest pregrants optional history/tabs/notifications; all source JS byte-identical to production.",
};
const server = spawn(
  process.execPath,
  [
    "../relay/local/server.mjs",
    "--port",
    "8790",
    "--data",
    resolve(dir, "relay"),
    "--pow",
    "0",
  ],
  { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (b) => {
  serverLog += b.toString();
});
server.stderr.on("data", (b) => {
  serverLog += b.toString();
});
const contexts = [],
  pages = [];
async function poll(fn, predicate, label, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (predicate(value)) return value;
    if (value?.pair?.view === "failure")
      throw Error(label + ": " + value.pair.error);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(label + " timed out");
}
const rpc = (page, type, action, args = {}) =>
  page.evaluate(
    ({ type, action, args }) =>
      chrome.runtime.sendMessage({ type, action, args }),
    { type, action, args },
  );
const pair = (page, action, args) => rpc(page, "kj:pair", action, args);
const cont = async (page, action, args) => {
  const value = await rpc(page, "kj:continuity", action, args);
  assert.ok(!value?.error, `${action}: ${value?.error}`);
  return value;
};
async function visit(context, path, title) {
  const page = await context.newPage();
  await page.route("https://*.continuity.example/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>${title}</title><h1>${title}</h1>`,
    }),
  );
  await page.goto(path);
  await page.bringToFront();
  return page;
}
async function files(path) {
  const all = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const p = resolve(path, entry.name);
    all.push(...(entry.isDirectory() ? await files(p) : [p]));
  }
  return all;
}
try {
  await poll(
    async () => {
      try {
        return await fetch(relayUrl + "/v1/health").then((r) => r.ok);
      } catch {
        return false;
      }
    },
    Boolean,
    "local relay startup",
    15000,
  );
  const testExt = resolve(dir, "extension");
  await cp("dist", testExt, { recursive: true });
  const manifest = JSON.parse(
    await readFile(resolve(testExt, "manifest.json"), "utf8"),
  );
  manifest.permissions.push(...manifest.optional_permissions);
  delete manifest.optional_permissions;
  await writeFile(resolve(testExt, "manifest.json"), JSON.stringify(manifest));
  for (let i = 0; i < 2; i++) {
    const c = await launchExtension(resolve(dir, "profile-" + i), testExt);
    contexts.push(c);
    const worker =
      c.serviceWorkers()[0] || (await c.waitForEvent("serviceworker"));
    await worker.evaluate(() => {
      self.__testErrors = [];
      const original = console.error;
      console.error = (...args) => {
        self.__testErrors.push(args.map((x) => x?.stack || String(x)));
        original(...args);
      };
    });
    const page = await c.newPage();
    pages.push(page);
    page.on("pageerror", (e) => result.errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") result.errors.push(m.text());
    });
    await page.goto(`chrome-extension://${id}/index.html`);
    await page.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
    const changed = await pair(page, "relay", { url: relayUrl });
    if (changed?.error) {
      console.log(
        "Background diagnostics:",
        await worker.evaluate(() => self.__testErrors),
      );
      const modules = (await readdir("dist/assets")).filter((f) =>
        /^(service|desktop)-.*\.js$/.test(f),
      );
      for (const file of modules)
        console.log(
          file,
          await worker.evaluate(async (f) => {
            try {
              await import(chrome.runtime.getURL("assets/" + f));
              return "loaded";
            } catch (e) {
              return e.stack;
            }
          }, file),
        );
    }
    assert.ok(
      !changed?.error,
      "background initialization: " + JSON.stringify(changed),
    );
    // This test exercises history, not icon downloads. Use deterministic local
    // icons so unrelated background enrichment cannot create snapshot traffic.
    await page.evaluate(async () => {
      const { data } = await chrome.storage.local.get("data");
      data.bookmarks.forEach((bookmark) => { bookmark.icon = { mode: "letter" }; });
      await chrome.storage.local.set({ data });
    });
  }
  const [a, b] = pages;
  await a.waitForTimeout(1000);
  await pair(a, "create", { name: "接力电脑 A" });
  const invite = await poll(
    () => pair(a, "status"),
    (r) => r.pair.view === "invite",
    "invite",
  );
  await pair(b, "join", { name: "接力电脑 B", code: invite.pair.code });
  const sasA = await poll(
    () => pair(a, "status"),
    (r) => r.pair.view === "sas",
    "SAS A",
  );
  const sasB = await poll(
    () => pair(b, "status"),
    (r) => r.pair.view === "sas",
    "SAS B",
  );
  assert.equal(sasA.pair.sas, sasB.pair.sas);
  assert.equal(sasB.pair.peerName, "接力电脑 A");
  await Promise.all([pair(a, "confirm"), pair(b, "confirm")]);
  await poll(
    () => pair(a, "status"),
    (r) => r.status.devices.length === 2 && r.status.connection === "online",
    "paired A",
  );
  await poll(
    () => pair(b, "status"),
    (r) => r.status.devices.length === 2 && r.status.connection === "online",
    "paired B",
  );
  const selfA = (await cont(a, "state")).status.devices.find(
    (d) => d.self,
  ).deviceId;
  const selfB = (await cont(b, "state")).status.devices.find(
    (d) => d.self,
  ).deviceId;
  result.checks.push(
    "Two production-JS extension profiles paired via real local protocol; authenticated inviter name and equal SAS",
  );
  await cont(a, "option", { key: "history", value: true });
  // Keep B's history visible while the real onVisited/title lookup is running.
  await b.bringToFront();
  await b.getByRole("button", { name: "接力", exact: true }).click();
  await b.getByRole("button", { name: "历史", exact: true }).click();
  const urls = [1, 2, 3].map((i) => `https://a.continuity.example/visit-${i}`);
  const titles = ["接力测试网页", "接力历史样本 1", "接力历史样本 2"];
  const startHistory = Date.now();
  await visit(contexts[0], urls[0], titles[0]);
  await b.bringToFront();
  const titleRow = b
    .locator(".relay-history-row a")
    .filter({ hasText: titles[0] });
  await titleRow.waitFor({
    state: "visible",
    timeout: Math.max(1, 15000 - (Date.now() - startHistory)),
  });
  assert.equal(await titleRow.textContent(), titles[0]);
  result.timings.historyMs = Date.now() - startHistory;
  assert.ok(
    result.timings.historyMs < 15000,
    "B history UI must display the real title within 15 seconds",
  );
  for (let i = 1; i < urls.length; i++)
    await visit(contexts[0], urls[i], titles[i]);
  await poll(
    () => cont(b, "history", { dev: selfA }),
    (r) =>
      urls.every(
        (u, i) =>
          r.items.filter((v) => v.u === u).length === 1 &&
          r.items.some((v) => v.u === u && v.ti === titles[i]),
      ),
    "history title propagation",
    15000,
  );
  await b.bringToFront();
  const screenshot =
    "../docs/v4-continuity/screenshots/history-title-fix-b.png";
  await mkdir(resolve(screenshot, ".."), { recursive: true });
  await b
    .locator(".relay-panel")
    .evaluate((el) => el.focus({ preventScroll: true }));
  await b.waitForTimeout(500);
  await b.screenshot({ path: screenshot });
  const metadata = await sharp(screenshot).metadata();
  assert.equal(metadata.width, 2880);
  assert.equal(metadata.height, 1800);
  result.screenshot = {
    path: screenshot,
    width: metadata.width,
    height: metadata.height,
  };
  await b.getByRole("button", { name: "关闭接力", exact: true }).click();
  result.checks.push(
    "Real chrome.history.onVisited + delayed Chrome history lookup: three public webpages arrive once at B with exact titles; B history UI displays 接力测试网页 within 15s (screenshot captured)",
  );
  await cont(b, "option", { key: "tabs", value: true });
  const tabUrls = [
    "https://b.continuity.example/one",
    "https://b.continuity.example/two",
  ];
  for (let i = 0; i < tabUrls.length; i++)
    await visit(contexts[1], tabUrls[i], "远端打开标签 " + i);
  await poll(
    () => cont(a, "state"),
    (r) =>
      tabUrls.every((u) =>
        r.slots
          .find((s) => s.dev === selfB)
          ?.payload.windows.some((w) => w.tabs.some((t) => t.u === u)),
      ),
    "tabs propagation",
    15000,
  );
  await a.locator(".relay-resume").waitFor();
  result.checks.push(
    "Real tabs/windows event collection, three-second debounce, both B tabs and resume pill visible at A",
  );
  await cont(a, "option", { key: "incoming", value: true });
  const incoming = await cont(b, "sendToDevice", {
    deviceId: selfA,
    url: tabUrls[1],
    title: "发送到设备集成样本",
  });
  await poll(
    () => cont(a, "pendingIncoming"),
    (r) => r.some((i) => i.id === incoming.id),
    "incoming",
  );
  await poll(
    () => a.evaluate(() => chrome.action.getBadgeText({})),
    (badge) => badge === "1",
    "unread badge",
  );
  await poll(
    () => a.evaluate(() => chrome.notifications.getAll()),
    (all) => !!all["kj-incoming:" + incoming.id],
    "system notification",
  );
  await a.evaluate(
    (url) =>
      chrome.runtime.sendMessage({
        type: "kj:collect",
        url,
        title: "徽标优先级测试",
      }),
    tabUrls[1],
  );
  await a.waitForTimeout(1700);
  assert.equal(
    await a.evaluate(() => chrome.action.getBadgeText({})),
    "1",
    "Quick-collect feedback must preserve unread count",
  );
  await cont(a, "read", { id: incoming.id });
  await poll(
    () => cont(a, "pendingIncoming"),
    (r) => r.length === 0,
    "read acknowledgement",
  );
  await a.evaluate(
    (other) =>
      chrome.contextMenus.update("kj-send-device:" + other, { enabled: true }),
    selfB,
  );
  result.checks.push(
    "sendTo/onIncoming → real notification + blue unread badge; ack clears unread; device context submenu exists",
  );
  const row = (await cont(a, "history", { dev: selfA })).items.find(
    (v) => v.u === urls[0],
  );
  await cont(a, "delete", { ids: [row.id], scope: "all" });
  await poll(
    () => cont(b, "history", {}),
    (r) => !r.items.some((v) => v.id === row.id),
    "cross-device deletion",
  );
  await a.evaluate((u) => chrome.history.deleteUrl({ url: u }), urls[1]);
  await poll(
    () => cont(b, "history", {}),
    (r) => !r.items.some((v) => v.u === urls[1]),
    "native history deletion",
  );
  result.checks.push(
    "All-device hd deletion and real onVisitRemoved self deletion propagate to B",
  );
  const image = await sharp({
    create: { width: 32, height: 20, channels: 3, background: "#A8BBD0" },
  })
    .webp()
    .toBuffer();
  const imageStart = Date.now();
  const reference = await cont(a, "background", {
    base64: image.toString("base64"),
    mime: "image/webp",
    w: 32,
    h: 20,
  });
  await poll(
    () =>
      b.evaluate(() =>
        chrome.storage.local.get(["data", "background-revision"]),
      ),
    (r) =>
      r.data.settings.backgroundImage?.blobId === reference.blobId &&
      r["background-revision"] === reference.blobId,
    "background propagation",
    30000,
  );
  const cached = await b.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("shiguang-images", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            get = db
              .transaction("images")
              .objectStore("images")
              .get("background");
          get.onsuccess = async () => {
            resolve(Array.from(new Uint8Array(await get.result.arrayBuffer())));
            db.close();
          };
        };
      }),
  );
  assert.deepEqual(Buffer.from(cached), image);
  result.timings.backgroundMs = Date.now() - imageStart;
  result.checks.push(
    "Encrypted background blob + settings.background.image wire reference reaches B, IndexedDB bytes equal source within 30s",
  );
  const relayFiles = await files(resolve(dir, "relay"));
  for (const path of relayFiles) {
    const bytes = await readFile(path);
    for (const secret of [
      ...urls,
      ...tabUrls,
      "接力历史样本",
      "接力测试网页",
      "发送到设备集成样本",
    ])
      assert.ok(!bytes.includes(Buffer.from(secret)), "Relay plaintext leak");
    assert.ok(!bytes.includes(image), "Relay stored plaintext image");
  }
  result.checks.push(
    "Local relay persisted journals/slots/blobs audit: no test URL/title or plaintext image bytes",
  );
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (e) {
  result.failure = String(e);
  result.diagnostics = await Promise.all(
    pages.map(async (page) => ({
      stored: await page
        .evaluate(() =>
          chrome.storage.local.get(["data", "background-revision"]),
        )
        .catch(() => null),
      state: await cont(page, "state").catch((error) => String(error)),
      history: await cont(page, "history").catch((error) => String(error)),
      browserHistory: await page
        .evaluate(() =>
          chrome.history.search({
            text: "continuity.example",
            maxResults: 10,
            startTime: 0,
          }),
        )
        .catch((error) => String(error)),
      panel: await page
        .locator(".relay-panel")
        .innerText({ timeout: 1000 })
        .catch(() => null),
      workerErrors: await page
        .context()
        .serviceWorkers()[0]
        ?.evaluate(() => self.__testErrors)
        .catch(() => null),
    })),
  );
  throw e;
} finally {
  for (const page of pages.toReversed()) {
    try {
      await pair(page, "leave");
    } catch {
      /* preserve original test failure */
    }
  }
  for (const c of contexts) await c.close();
  server.kill();
  await writeFile(resolve(dir, "relay.log"), serverLog);
  await writeFile(
    "tests/continuity-integration-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
