import { chromium } from "playwright";
import { cp, readdir, mkdir, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
export async function launchChrome(options = {}) {
  return chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "chrome",
    headless: true,
    ...options,
    args: ["--force-device-scale-factor=2", ...(process.env.KJ_BLOCK_ONLINE_RELAY === "1" || process.env.KJ_STORE_OFFLINE_ONLY === "1" ? ["--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND"] : []), ...(options.args || [])],
  });
}
export async function launchExtension(profile, extension, extra = {}) {
  const context = await launchExtensionProfile(profile, extension, extra);
  if (
    process.env.KJ_BLOCK_ONLINE_RELAY === "1" ||
    process.env.KJ_STORE_OFFLINE_ONLY === "1"
  ) {
    const icon = await readFile(resolve("tests/fixtures/github.webp"));
    await context.route(/^https:\/\/(?:kongjing\.inc\.re|sync\.example\.com)\//, (route) =>
      /^\/v[12]\/icon$/.test(new URL(route.request().url()).pathname)
        ? route.fulfill({ contentType: "image/webp", body: icon })
        : route.abort(),
    );
  }
  return context;
}
async function launchExtensionProfile(profile, extension, extra = {}) {
  const options = {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    ...extra,
    args: [
      "--disable-extensions-except=" + extension,
      "--load-extension=" + extension,
      ...(process.env.KJ_BLOCK_ONLINE_RELAY === "1" ||
      process.env.KJ_STORE_OFFLINE_ONLY === "1"
        ? ["--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND"]
        : []),
      ...(extra.args || []),
    ],
  };
  try {
    await access(resolve("tests/.browser/chrome-win/chrome.exe"));
    return await chromium.launchPersistentContext(profile, {
      ...options,
      executablePath: resolve("tests/.browser/chrome-win/chrome.exe"),
    });
  } catch (error) {
    if (!String(error).includes("ENOENT")) throw error;
  }
  try {
    return await chromium.launchPersistentContext(profile, options);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !String(error).includes("spawn UNKNOWN")
    )
      throw error;
    const source = resolve(chromium.executablePath(), ".."),
      target = resolve("tests/.browser/chrome-win");
    await cp(source, target, { recursive: true });
    const manifest = (await readdir(target)).find((n) =>
      /^\d+\.\d+\.\d+\.\d+\.manifest$/.test(n),
    );
    if (!manifest) throw error;
    const assembly = resolve(target, manifest.replace(".manifest", ""));
    await mkdir(assembly, { recursive: true });
    await cp(resolve(target, manifest), resolve(assembly, manifest));
    await cp(
      resolve(target, "chrome_elf.dll"),
      resolve(assembly, "chrome_elf.dll"),
    );
    return chromium.launchPersistentContext(profile, {
      ...options,
      executablePath: resolve(target, "chrome.exe"),
    });
  }
}
