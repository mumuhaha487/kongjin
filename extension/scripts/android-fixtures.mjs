import { fixture, setup, github } from "./fixtures.mjs";
import { legacyEnvironment } from "./android-legacy-env.mjs";
export const mobileOptions = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
  timezoneId: "Asia/Singapore",
};
export async function nativeMock(context) {
  await context.addInitScript((icon) => {
    window.__nativeCalls = [];
    window.__browserPrefs = { isDefault: false, darkMode: "follow", darkSupported: true, textZoom: 100 };
    const record = (method, args) =>
      window.__nativeCalls.push({ method, args });
    window.KongjingNative = {
      open: (...args) => record("open", args),
      favicon: (...args) => {
        record("favicon", args);
        return String(args[0]).includes("native-icon.example") ? icon : "";
      },
      deviceName: () => {
        record("deviceName", []);
        return "Pixel 7 · 空境";
      },
      appVersion: () => "1.0.1",
      getBrowserPrefs: () => JSON.stringify(window.__browserPrefs),
      setWebDarkMode: (mode) => { record("setWebDarkMode", [mode]); window.__browserPrefs.darkMode = mode; },
      setTextZoom: (value) => { record("setTextZoom", [value]); window.__browserPrefs.textZoom = value; },
      requestDefaultBrowser: () => record("requestDefaultBrowser", []),
      scanQr: () => record("scanQr", []),
      haptic: (...args) => record("haptic", args),
      setTheme: (...args) => record("setTheme", args),
      setSearchTemplate: (...args) => record("setSearchTemplate", args),
      clearBrowsingData: (...args) => record("clearBrowsingData", args),
      ready: () => record("ready", []),
      reply: (...args) => record("reply", args),
      incoming: (...args) => record("incoming", args),
      requestNotificationPermission: () => {
        record("requestNotificationPermission", []);
        return "granted";
      },
    };
    window.__testIcon = icon;
  }, github);
}
export async function mobileScene(
  browser,
  base,
  { theme = "light", paired = false } = {},
) {
  const context = await browser.newContext(mobileOptions);
  await nativeMock(context);
  if (process.env.KJ_LEGACY === "1") await legacyEnvironment(context);
  await setup(context, fixture(theme), {
    "kj:mock": { paired, selfName: "Pixel 7 · 空境" },
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-10-22T12:51:00+08:00"));
  await page.goto(base);
  await page.waitForFunction(
    () =>
      !!window.kongjing &&
      window.__nativeCalls.some((c) => c.method === "ready"),
  );
  await page.waitForTimeout(1100);
  return { context, page };
}
export const bridgeCall = (page, method, args = {}) =>
  page.evaluate(
    ({ method, args }) =>
      window.kongjing.call("test-" + method, method, JSON.stringify(args)),
    { method, args },
  );
export async function longPress(page, locator, move) {
  const box = await locator.boundingBox(),
    session = await page.context().newCDPSession(page);
  const touch = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touch],
  });
  await page.waitForTimeout(650);
  if (move) {
    for (let i = 1; i <= 10; i++)
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            ...touch,
            x: touch.x + ((move.x - touch.x) * i) / 10,
            y: touch.y + ((move.y - touch.y) * i) / 10,
          },
        ],
      });
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
}
export async function swipe(page, from, to) {
  const session = await page.context().newCDPSession(page),
    touch = { ...from, id: 1 };
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touch],
  });
  for (let i = 1; i <= 10; i++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          ...touch,
          x: from.x + ((to.x - from.x) * i) / 10,
          y: from.y + ((to.y - from.y) * i) / 10,
        },
      ],
    });
    await page.waitForTimeout(20);
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
}
