import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { homeServer } from "./android-server.mjs";
import { fixture, setup } from "./fixtures.mjs";
import { nativeMock, longPress } from "./android-fixtures.mjs";
const output = "../docs/v6",
  now = Date.parse("2026-10-23T12:51:00+08:00");
await mkdir(output + "/screenshots", { recursive: true });
const server = await homeServer("dist-android-qa", 4196);
const browser = await chromium.launch({
  executablePath: "tests/.browser/chrome-win/chrome.exe",
  args: ["--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND"],
});
const results = [],
  errors = [];
async function state(page, value) {
  await page.evaluate((v) => window.kjTest.setState(v), value);
}
async function home(page) {
  await page.keyboard.press("Escape");
  await state(page, {
    overlay: null,
    settingsOpen: false,
    focused: false,
    toasts: [],
    continuityConsent: false,
  });
  await page.evaluate(() => {
    window.kjTest.relayState.setState({ open: false });
    document.activeElement?.blur();
  });
  await page.waitForTimeout(180);
  await page.waitForFunction(() => [...document.querySelectorAll('.modal-layer,.settings-layer')].every((node) => node.dataset.settled === 'closed'));
  // The pairing dialog's unmount cleanup emits cancel/status. Drain that
  // cleanup before installing the next synthetic screenshot-only status.
  await page.waitForTimeout(50);
}
async function settings(page) {
  await home(page);
  await state(page, { settingsOpen: true });
  await page.waitForTimeout(180);
}
async function pair(page, view) {
  await home(page);
  await state(page, {
    overlay: { type: "pairing" },
    pair: {
      view,
      code: "0123456789",
      expiresAt: now + 590000,
      sas: "123456",
      peerName: "Windows · Chrome",
      error: "NETWORK",
    },
  });
}
async function audit(page, name, config) {
  await page.evaluate((scale) => {
    window.__baseFonts ??= new WeakMap();
    const elements = [...document.querySelectorAll("body *")].filter(
      (el) =>
        el instanceof HTMLElement &&
        !el.closest('.background,[aria-hidden="true"],.theme-snapshot'),
    );
    // Capture all original values BEFORE changing inherited styles; retain them
    // across scenes so browser text autosizing cannot compound the test scale.
    const fresh = elements.filter((el) => !window.__baseFonts.has(el));
    const sizes = fresh.map((el) => parseFloat(getComputedStyle(el).fontSize));
    fresh.forEach((el, i) => window.__baseFonts.set(el, sizes[i]));
    for (const el of elements)
      if (
        el.matches("input,textarea") ||
        [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
        )
      )
        el.style.fontSize = window.__baseFonts.get(el) * scale + "px";
  }, config.font / 100);
  await page.waitForTimeout(185);
  const issues = await page.evaluate(() => {
    const bad = [],
      width = innerWidth;
    if (document.documentElement.scrollWidth > width)
      bad.push({
        kind: "document",
        actual: document.documentElement.scrollWidth,
      });
    for(const parked of document.querySelectorAll('.persistent-sheet[data-settled=closed]')) if(getComputedStyle(parked).opacity !== '0') bad.push({kind:'parked-display-list'});
    const visible = [];
    for (const el of document.querySelectorAll("body *")) {
      if (
        !(el instanceof HTMLElement) ||
        el.closest('[aria-hidden="true"],[inert],.background,.theme-snapshot')
      )
        continue;
      const css = getComputedStyle(el),
        r = el.getBoundingClientRect();
      if (
        css.visibility === "hidden" ||
        css.display === "none" ||
        +css.opacity === 0 ||
        !r.width ||
        !r.height
      )
        continue;
      let clipped = false,
        scrollRail = false;
      for (
        let p = el.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        const s = getComputedStyle(p),
          b = p.getBoundingClientRect();
        if (+s.opacity === 0) {
          clipped = true;
          break;
        }
        if (
          p.matches(
            ".groups,.relay-device-filters,.device-pills,.relay-clear-form .segments",
          ) &&
          /auto|scroll/.test(s.overflowX) &&
          p.scrollWidth > p.clientWidth + 1
        )
          scrollRail = true;
      }
      if (clipped) continue;
      const label =
        el.tagName.toLowerCase() +
        "." +
        el.className +
        " " +
        (el.textContent || "").slice(0, 60);
      if (!scrollRail && (r.left < -0.5 || r.right > width + 0.5))
        bad.push({ kind: "bounds", label, left: r.left, right: r.right });
      // Editable controls intentionally scroll their value; textareas wrap codes.
      if (
        !/INPUT|TEXTAREA/.test(el.tagName) &&
        !scrollRail &&
        el.childElementCount === 0 &&
        el.textContent?.trim() &&
        el.scrollWidth > el.clientWidth + 1 &&
        css.textOverflow !== "ellipsis"
      )
        bad.push({
          kind: "text",
          label,
          scroll: el.scrollWidth,
          client: el.clientWidth,
        });
      if (el.matches('button,a[role="button"]')) visible.push({ el, r, label });
    }
    for (let i = 0; i < visible.length; i++)
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i],
          b = visible[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (a.el.parentElement !== b.el.parentElement) continue;
        if (
          Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left) > 0.5 &&
          Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top) > 0.5
        )
          bad.push({ kind: "overlap", label: a.label, other: b.label });
      }
    return bad;
  });
  const row = { name, ...config, issues };
  results.push(row);
  if (issues.length)
    console.log(
      "FAIL",
      name,
      JSON.stringify(config),
      JSON.stringify(issues.slice(0, 4)),
    );
  if (
    (config.width === 360 &&
      config.height === 640 &&
      config.font === 130 &&
      config.theme === "dark") ||
    (config.width === 412 && config.font === 100 && config.theme === "light")
  ) {
    await page.screenshot({
      path:
        output +
        "/screenshots/overflow-" +
        name +
        "-" +
        config.width +
        "-" +
        config.font +
        "-" +
        config.theme +
        ".png",
    });
  }
}
try {
  const configs = [];
  for (const [width, height] of process.env.KJ_AUDIT_QUICK === "1"
    ? [[360, 640]]
    : [
        [360, 640],
        [360, 800],
        [390, 844],
        [412, 915],
      ])
    for (const font of process.env.KJ_AUDIT_QUICK === "1"
      ? [130]
      : [100, 115, 130])
      for (const theme of ["light", "dark"]) configs.push({width,height,font,theme});
  async function runConfig({width,height,font,theme}) {
        const config = { width, height, font, theme },
          context = await browser.newContext({
            viewport: { width, height },
            deviceScaleFactor: 2.625,
            isMobile: true,
            hasTouch: true,
            reducedMotion: "reduce",
            locale: "zh-CN",
          });
        await nativeMock(context);
        const data = fixture(theme);
        data.profile.nickname = "非常长的中文昵称测试";
        await setup(context, data, {
          "kj:mock": { paired: true, selfName: "Xiaomi 14 · 空境" },
          "kj:continuity-fixture": {
            slots: [
              {
                dev: "b",
                at: now,
                payload: {
                  windows: [
                    {
                      focused: true,
                      tabs: [
                        {
                          u: "https://developer.chrome.com/docs",
                          ti: "长标题：继续浏览与已同步设备的网页测试",
                          active: true,
                        },
                      ],
                    },
                  ],
                  last: {
                    u: "https://developer.chrome.com/docs",
                    ti: "长标题：继续浏览与已同步设备的网页测试",
                    at: now - 60000,
                  },
                },
              },
            ],
            records: [
              {
                id: "audit-history",
                seq: 1,
                dev: "b",
                at: now,
                t: "hv",
                v: [
                  {
                    u: "https://developer.chrome.com/docs",
                    ti: "中文历史记录标题很长也应该可以正常阅读",
                    at: now,
                  },
                ],
              },
            ],
            inbox: [
              {
                id: "audit-inbox",
                from: "b",
                at: now,
                k: "url",
                u: "https://developer.chrome.com/docs",
                ti: "收到的网页标题：这里有一段较长的测试文字",
              },
            ],
          },
        });
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        await page.clock.setFixedTime(now);
        await page.goto(server.base);
        await page.waitForFunction(
          () => window.kjTest?.relayState?.getState().status.paired,
        );
        await page.locator(".relay-resume").waitFor();
        await page.waitForTimeout(300);
        await audit(page, "home", config);
        await page.locator(".engine-trigger").click();
        await audit(page, "engine-menu", config);
        await home(page);
        await state(page, {
          history: ["这是很长的中文搜索历史记录测试", "空境浏览器"],
          focused: true,
        });
        await page.getByRole("textbox", { name: "搜索", exact: true }).focus();
        await audit(page, "search-history", config);
        await home(page);
        await page.locator(".bookmark-link").first().scrollIntoViewIfNeeded();
        await longPress(page, page.locator(".bookmark-link").first());
        await page
          .getByRole("dialog", { name: "书签菜单", exact: true })
          .waitFor();
        await audit(page, "bookmark-actions", config);
        await home(page);
        await state(page, {
          overlay: { type: "bookmark", id: "default-common" },
        });
        await audit(page, "bookmark-add", config);
        await page.getByRole("button", { name: "自定义", exact: true }).click();
        await audit(page, "bookmark-custom", config);
        await home(page);
        await state(page, {
          overlay: { type: "bookmark", id: "default-github" },
        });
        await audit(page, "bookmark-edit", config);
        await home(page);
        await state(page, { overlay: { type: "avatar" } });
        await audit(page, "avatar", config);
        await page
          .getByRole("button", { name: "使用链接", exact: true })
          .click();
        await audit(page, "avatar-link", config);
        await home(page);
        await page.getByRole("button", { name: "我的", exact: true }).click();
        await audit(page, "me", config);
        await home(page);
        await settings(page);
        for (const heading of [
          "我的",
          "配对与同步",
          "外观",
          "时钟与问候",
          "搜索",
          "书签",
          "浏览器",
          "数据",
          "关于",
        ]) {
          const h = page
            .locator(".settings-content h3")
            .filter({ hasText: new RegExp("^" + heading + "$") });
          await h.evaluate((el) => el.scrollIntoView({ block: "start" }));
          await audit(
            page,
            "settings-" +
              {
                我的: "profile",
                配对与同步: "pairing",
                外观: "appearance",
                时钟与问候: "clock",
                搜索: "search",
                书签: "bookmarks",
                浏览器: "browser",
                数据: "data",
                关于: "about",
              }[heading],
            config,
          );
        }
        await page.locator("#settings-browser").scrollIntoViewIfNeeded();
        for(const [name,patch] of [["browser-default",{isDefault:true}],["browser-dark-unsupported",{darkSupported:false}],["browser-text-150",{isDefault:false,darkSupported:true,textZoom:150}]]) {
          await page.evaluate(async (patch)=>{Object.assign(window.__browserPrefs,patch);await window.kongjing.call("audit","browserPrefsChanged","{}");},patch);
          await audit(page,name,config);
        }
        await page.locator("#settings-sharing").scrollIntoViewIfNeeded();
        await audit(page, "settings-sharing", config);
        for (const [label, name] of [
          ["浏览记录", "history-consent"],
          ["打开的标签页", "tabs-consent"],
        ]) {
          await page.getByRole("switch", { name: label, exact: true }).click();
          await audit(page, name, config);
          await page.keyboard.press("Escape");
        }
        await page.getByText("高级", { exact: true }).click();
        await page
          .getByLabel("中转服务器", { exact: true })
          .scrollIntoViewIfNeeded();
        await audit(page, "settings-advanced", config);
        const section = page.locator("#settings-data");
        await section.scrollIntoViewIfNeeded();
        await section
          .getByRole("button", { name: "文本码", exact: true })
          .first()
          .click();
        await section
          .getByRole("button", { name: "生成导入码", exact: true })
          .click();
        await page.getByLabel("生成的导入码", { exact: true }).waitFor();
        await audit(page, "data-export-code", config);
        await section
          .getByRole("button", { name: "文本码", exact: true })
          .last()
          .click();
        await page
          .getByLabel("粘贴导入码", { exact: true })
          .fill(
            await page.getByLabel("生成的导入码", { exact: true }).inputValue(),
          );
        await section
          .getByRole("button", { name: "解析", exact: true })
          .click();
        await page.locator(".preview-card").waitFor();
        await page.locator(".preview-card").scrollIntoViewIfNeeded();
        await audit(page, "data-import-preview", config);
        await home(page);
        for (const view of [
          "intro",
          "preparing",
          "invite",
          "join",
          "sas",
          "success",
          "failure",
        ]) {
          await pair(page, view);
          await audit(page, "pair-" + view, config);
        }
        await home(page);
        const saved = await page.evaluate(
          () => window.kjTest.getState().status,
        );
        await state(page, {
          settingsOpen: true,
          status: {
            ...saved,
            paired: false,
            devices: [],
            removedNotice: { at: now },
          },
        });
        await page.locator(".removed-notice").scrollIntoViewIfNeeded();
        await audit(page, "removed-notice", config);
        await state(page, { status: saved });
        await home(page);
        await page.evaluate(() => window.kjTest.openRelay("devices"));
        await page.locator(".relay-device-card").first().waitFor();
        await audit(page, "relay-devices", config);
        await page.getByRole("button", { name: "历史", exact: true }).click();
        await page.locator(".relay-history-row").first().waitFor();
        await audit(page, "relay-history", config);
        await page
          .getByRole("button", { name: "清除浏览记录…", exact: true })
          .click();
        await audit(page, "clear-history", config);
        await home(page);
        for (const type of [
          "reset",
          "leave",
          "remove-device",
          "replace",
          "clear-browser",
          "permission",
          "welcome",
        ]) {
          await state(page, {
            overlay: { type, id: "b", name: "MacBook · Chrome", data },
          });
          await audit(page, "confirm-" + type, config);
          await home(page);
        }
        await state(page, {
          toasts: [
            { id: 100, text: "本设备已被移出配对组", type: "removed" },
            { id: 101, text: "已删除书签", label: "撤销", action: undefined },
          ],
        });
        await audit(page, "toast", config);
        await context.close();
        console.log("COMPLETED", JSON.stringify(config));
      }
  const concurrency=Number(process.env.KJ_AUDIT_CONCURRENCY || 4);
  for(let i=0;i<configs.length;i+=concurrency) {
    const batch=await Promise.allSettled(configs.slice(i,i+concurrency).map(runConfig));
    const failed=batch.find(r=>r.status==="rejected");
    if(failed)throw failed.reason;
  }
} finally {
  await browser.close();
  await server.close();
  await writeFile(
    output + "/overflow-results.json",
    JSON.stringify(
      {
        method:
          "Text-only enlargement: each HTMLElement computed font-size × scale; physical viewport unchanged (WebView textZoom approximation). Background/aria-hidden/inert elements excluded; all laid-out vertical scroll content included; designated horizontal scroll rails allowed intentionally. Assert document width, bounds ±0.5px, leaf text clipping, sibling button overlap.",
        results,
        errors,
      },
      null,
      2,
    ),
  );
}
assert.deepEqual(errors, []);
assert.equal(
  results.filter((r) => r.issues.length).length,
  0,
  "Overflow combinations must all pass",
);
console.log(
  "PASS",
  results.length,
  "scene × viewport × text scale × theme combinations",
);
