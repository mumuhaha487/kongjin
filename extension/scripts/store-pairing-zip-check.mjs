import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { launchExtension } from "./browser.mjs";
import { assertPairingSection } from "./pairing-section-check.mjs";

const archive = resolve("../release/store/kongjing-2.0.1-store.zip");
const bytes = await readFile(archive);
const temp = await mkdtemp(resolve("tests/.store-pairing-zip-"));
const unpacked = resolve(temp, "unpacked");
for (const [name, data] of Object.entries(unzipSync(bytes))) {
  const target = resolve(unpacked, name);
  assert.ok(
    target.startsWith(unpacked + sep),
    "ZIP entry outside test directory",
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}
const context = await launchExtension(resolve(temp, "profile"), unpacked);
const errors = [];
const result = {
  archive,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  checks: [],
  errors,
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  result.loadedId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("chrome://newtab");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  result.unpaired = await assertPairingSection(page, { paired: false });
  result.checks.push(
    "实际商店ZIP解压加载：未配对卡片、文字及两个按钮非空且有效透明度≥0.99",
  );
  await page.screenshot({ path: "tests/store-pairing-zip-unpaired.png" });
  await page
    .locator("#settings-pairing")
    .getByRole("button", { name: "加入已有配对组", exact: true })
    .click();
  await page.getByRole("dialog", { name: "加入配对组", exact: true }).waitFor();
  await page.waitForTimeout(1800);
  result.sharedSourceDuringDialog = await page
    .locator(".pair-summary-card")
    .evaluate((el) => ({
      opacity: getComputedStyle(el).opacity,
      visibility: getComputedStyle(el).visibility,
      inlineStyle: el.getAttribute("style"),
      text: el.textContent,
    }));
  await page.screenshot({ path: "tests/store-pairing-zip-dialog.png" });
  result.checks.push("记录共享元素对话框打开时原卡片的渲染状态");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  result.restored = await assertPairingSection(page, { paired: false });
  result.checks.push("关闭对话框后卡片恢复可见，无永久空白");
  assert.deepEqual(errors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = String(error);
  throw error;
} finally {
  await writeFile(
    "tests/store-pairing-zip-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  await context.close();
}
console.log(JSON.stringify(result, null, 2));
