import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { launchChrome } from "./browser.mjs";
import { fixture, setup, ready, openSettings, base } from "./fixtures.mjs";
const out = resolve("../docs/v2/screenshots");
await mkdir(out, { recursive: true });
const browser = await launchChrome(),
  checks = [],
  errors = [];
async function scene({
  theme = "light",
  paired = false,
  popup = false,
  video = false,
} = {}) {
  const data = fixture(theme);
  const c = await browser.newContext({
    viewport: popup
      ? { width: 360, height: 560 }
      : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "zh-CN",
    timezoneId: "Asia/Singapore",
    ...(video
      ? {
          recordVideo: {
            dir: out,
            size: popup
              ? { width: 360, height: 560 }
              : { width: 1440, height: 900 },
          },
        }
      : {}),
  });
  await setup(c, data, {
    "kj:mock": { paired },
    "kj:popup": {
      id: 1,
      url: "https://example.com/article",
      title: "示例文章",
    },
  });
  const p = await c.newPage();
  await p.clock.setFixedTime(new Date("2026-10-21T12:51:00+08:00"));
  p.on("pageerror", (e) => errors.push(e.message));
  if (popup) {
    await p.goto(base + "/popup.html");
    await p.getByRole("button", { name: "收藏到空境", exact: true }).waitFor();
  } else await ready(p);
  return { c, p };
}
async function shot(name, options = {}, prepare = async () => {}) {
  const { c, p } = await scene(options);
  try {
    await prepare(p);
    await p.waitForTimeout(800);
    if (options.popup) {
      const h = Math.ceil(
        await p.locator(".popup-app").evaluate((el) => el.scrollHeight),
      );
      await p.setViewportSize({ width: 360, height: Math.min(560, h) });
    }
    await p.screenshot({ path: resolve(out, name) });
    checks.push({
      name,
      viewport: p.viewportSize(),
      dialogs: await p.getByRole("dialog").evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return {
            width: r.width,
            height: r.height,
            inside:
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= innerHeight,
          };
        }),
      ),
      overflow: await p.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    });
    console.log("SHOT " + name);
  } finally {
    await c.close();
  }
}
const openPair = (p) =>
  p.evaluate(() => window.kjTest.getState().open({ type: "pairing" }));
await shot("01-home-light.png");
await shot("02-home-dark.png", { theme: "dark" });
await shot("03-topbar-hover-avatar.png", {}, async (p) => {
  await p.getByRole("button", { name: "我的", exact: true }).hover();
  await p.waitForTimeout(500);
});
await shot("04-group-add.png", {}, async (p) => {
  await p.getByRole("button", { name: "新建分组" }).click();
  await p.waitForTimeout(600);
  const r = await p.getByLabel("新分组名称").evaluate((el) => {
    const a = el.getBoundingClientRect(),
      b = el.closest(".groups").getBoundingClientRect();
    return {
      w: a.width,
      h: a.height,
      inside:
        a.left >= b.left &&
        a.right <= b.right &&
        a.top >= b.top &&
        a.bottom <= b.bottom,
    };
  });
  assert.equal(r.inside, true);
  assert.equal(r.w, 120);
});
await shot("05-bookmark-dialog-empty.png", {}, async (p) => {
  await p.getByRole("button", { name: "添加书签", exact: true }).click();
  assert.equal(await p.locator(".bookmark-preview").innerText(), "未命名");
});
await shot("06-bookmark-dialog-custom-icon.png", {}, async (p) => {
  await p.getByRole("button", { name: "添加书签", exact: true }).click();
  await p.getByLabel("网址", { exact: true }).fill("https://github.com");
  await p.getByLabel("名称", { exact: true }).fill("GitHub");
  await p.getByRole("button", { name: "自定义", exact: true }).click();
  await p
    .locator("input[type=file]")
    .setInputFiles("tests/fixtures/github.webp");
});
await shot("07-me-popover.png", { paired: true }, async (p) => {
  await p.getByRole("button", { name: "我的", exact: true }).click();
});
await shot("08-avatar-dialog.png", {}, async (p) => {
  await p.evaluate(() => window.kjTest.getState().open({ type: "avatar" }));
  await p
    .locator("input[type=file]")
    .setInputFiles("tests/fixtures/github.webp");
  await p.getByText(/已压缩为/).waitFor();
});
await shot("09-settings-pairing-unpaired.png", {}, (p) =>
  openSettings(p, "pairing"),
);
await shot("10-pair-invite.png", {}, async (p) => {
  await openPair(p);
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "创建配对组", exact: true })
    .click();
  await p.getByRole("heading", { name: "添加设备", exact: true }).waitFor();
  await p.waitForFunction(
    () =>
      document.querySelector(".pair-code")?.textContent === "KJ-8F3QZ-T7M2C",
  );
});
const join = async (p) => {
  await openPair(p);
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "加入已有配对组", exact: true })
    .click();
  await p.getByLabel("配对码", { exact: true }).fill("8F3QZT7M2C");
  await p.getByRole("button", { name: "连接", exact: true }).click();
  await p.getByRole("heading", { name: "核对安全码" }).waitFor();
};
await shot("11-pair-sas.png", {}, join);
await shot("12-settings-pairing-paired.png", { paired: true }, (p) =>
  openSettings(p, "pairing"),
);
await shot("13-settings-data-export-text.png", {}, async (p) => {
  await openSettings(p, "data");
  await p
    .locator("#settings-data")
    .getByRole("button", { name: "文本码", exact: true })
    .first()
    .click();
  await p.getByRole("button", { name: "生成导入码" }).click();
  await p.getByLabel("生成的导入码").waitFor();
});
await shot("14-import-preview.png", {}, async (p) => {
  await openSettings(p, "data");
  const code = await p.evaluate(() =>
    window.kjTest.encodeBackup(window.kjTest.getState().data),
  );
  await p
    .locator("#settings-data")
    .getByRole("button", { name: "文本码", exact: true })
    .last()
    .click();
  await p.getByLabel("粘贴导入码").fill(code);
  await p.getByRole("button", { name: "解析", exact: true }).click();
  await p.locator(".preview-card").waitFor();
  await p.locator(".preview-card").scrollIntoViewIfNeeded();
});
await shot("15-popup.png", { popup: true });
await shot(
  "16-popup-dark-saved.png",
  { popup: true, theme: "dark" },
  async (p) => {
    await p.getByRole("button", { name: "收藏到空境", exact: true }).click();
    await p.reload();
    await p.getByRole("button", { name: "更新", exact: true }).waitFor();
  },
);
await shot("19-welcome-v2.png", {}, (p) =>
  p.evaluate(() => window.kjTest.getState().open({ type: "welcome" })),
);
for (const name of ["background", "topbar", "pair-success", "popup-success"]) {
  const { c, p } = await scene({
    theme: name === "background" ? "dark" : "light",
    popup: name === "popup-success",
    video: true,
  });
  const v = p.video();
  try {
    if (name === "background") await p.waitForTimeout(20000);
    if (name === "topbar") {
      for (let i = 0; i < 6; i++) {
        for (const label of ["我的", "设置", "切换主题"]) {
          await p.getByRole("button", { name: label, exact: true }).hover();
          await p.waitForTimeout(180);
        }
      }
    }
    if (name === "pair-success") {
      await join(p);
      await p.waitForTimeout(800);
      await p.getByRole("button", { name: "一致", exact: true }).click();
      await p.waitForTimeout(2600);
    }
    if (name === "popup-success") {
      await p.getByRole("button", { name: "收藏到空境", exact: true }).click();
      await p.waitForTimeout(1600);
    }
  } finally {
    await c.close();
    await v.saveAs(resolve(out, "motion-" + name + ".webm"));
    await v.delete();
  }
}
let landing;
for (const proxy of [undefined, { server: "http://127.0.0.1:10808" }]) {
  let b;
  try {
    b = await launchChrome(proxy ? { proxy } : {});
    const c = await b.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const p = await c.newPage();
    await p.goto("https://kongjing.inc.re/", {
      timeout: 20000,
      waitUntil: "networkidle",
    });
    await p.screenshot({ path: resolve(out, "20-relay-landing.png") });
    landing = { captured: true, proxy: !!proxy, title: await p.title() };
    await b.close();
    break;
  } catch (e) {
    landing = { captured: false, error: String(e) };
    if (b) await b.close();
  }
}
await writeFile(
  resolve(out, "verification.json"),
  JSON.stringify(
    {
      checks,
      errors,
      landing,
      note: "17/18 and motion-dock generated by npm run smoke; pairing screenshot mock restricted to QA build",
    },
    null,
    2,
  ),
);
await browser.close();
assert.deepEqual(errors, []);
assert.ok(checks.every((c) => !c.overflow && c.dialogs.every((d) => d.inside)));
console.log(
  "PASS screenshots " + checks.length + ", landing " + landing.captured,
);
