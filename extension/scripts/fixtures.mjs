import { defaults } from "../src/lib/model.ts";
import { readFile } from "node:fs/promises";
export const base =
  process.env.KJ_QA_URL ||
  (process.env.KJ_STORE === "1"
    ? "http://127.0.0.1:4176"
    : "http://127.0.0.1:4174");
export const github =
  "data:image/webp;base64," +
  (await readFile("tests/fixtures/github.webp")).toString("base64");
export function fixture(theme = "light") {
  const data = defaults();
  data.profile = { nickname: "Alex", updatedAt: 1 };
  data.settings.theme = theme;
  data.bookmarks.forEach(
    (b) => (b.icon = { mode: "auto", failedAt: Date.now() }),
  );
  data.bookmarks[0].icon = {
    mode: "auto",
    dataUrl: github,
    tone: "dark",
    fetchedAt: Date.now(),
  };
  return data;
}
export async function setup(context, data = fixture(), extra = {}) {
  await context.addInitScript(
    ({ data, extra }) => {
      if (localStorage.getItem("kj:seeded")) return;
      localStorage.setItem("kj:seeded", "1");
      localStorage.setItem("kongjing:mirror", JSON.stringify(data));
      localStorage.setItem("shiguang:data", JSON.stringify(data));
      for (const [key, value] of Object.entries(extra))
        localStorage.setItem(key, JSON.stringify(value));
    },
    { data, extra },
  );
  await context.route(/^https:\/\/(?:kongjing\.inc\.re|sync\.example\.com)\/v[12]\/icon\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/webp",
      body: Buffer.from(github.split(",")[1], "base64"),
    }),
  );
}
export async function ready(page) {
  await page.goto(base);
  await page.waitForFunction(() => !!window.kjTest);
  await page.locator(".bookmark-link").first().waitFor();
  await page.waitForTimeout(1000);
}
export async function openSettings(page, section = "") {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  if (section)
    await page.evaluate((section) => {
      window.kjTest.setState({ settingsSection: section });
    }, section);
  await page.waitForTimeout(700);
}
export async function waitMotion(page) {
  await page.waitForTimeout(800);
}
