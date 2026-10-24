import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, relative, sep } from "node:path";
import sharp from "sharp";
import crx3 from "crx3";
import { check, checkArchives, checkStoreArchive } from "./check.mjs";
import { createManifest, version, storeVersion } from "./manifest.mjs";
import { zipSync } from "fflate";
const store = process.env.KJ_STORE === "1";
const root = fileURLToPath(new URL("../..", import.meta.url)),
  extension = resolve(root, "extension"),
  out = resolve(root, "release"),
  unpacked = resolve(out, "unpacked"),
  keyPath = resolve(root, "keys/shiguang.pem");
if (!store && !(await readFile(resolve(root, "shared/protocol/READY.md"), "utf8")).includes("## v3.3.1")) throw Error("Protocol v3.3.1 is not ready");
const manifest = await createManifest(store);
const id = store
  ? undefined
  : [
      ...createHash("sha256")
        .update(Buffer.from(manifest.key, "base64"))
        .digest()
        .subarray(0, 16),
    ]
      .flatMap((b) => [b >> 4, b & 15])
      .map((n) => String.fromCharCode(97 + n))
      .join("");
if (!store && id !== "agijcmabomapmbobdgblmckibkpobdij")
  throw Error("Existing extension identity mismatch");
const dist = resolve(extension, store ? "dist-store" : "dist");
await mkdir(resolve(extension, "public/icons"), { recursive: true });
for (const size of [16, 32, 48, 128])
  await sharp(
    await readFile(
      resolve(
        root,
        "docs/brand/kongjing-logo" + (size <= 48 ? "-small" : "") + ".svg",
      ),
    ),
    { density: 384 },
  )
    .resize(size, size)
    .png()
    .toFile(resolve(extension, "public/icons/" + size + ".png"));
await cp(
  resolve(root, "docs/brand/kongjing-logo.svg"),
  resolve(extension, "public/icons/kongjing.svg"),
);
await cp(
  resolve(root, "docs/brand/kongjing-logo-small.svg"),
  resolve(extension, "public/icons/kongjing-small.svg"),
);
if (!store)
  await writeFile(
    resolve(extension, "public/manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
await cp(resolve(extension, "public/icons"), resolve(dist, "icons"), {
  recursive: true,
});
await writeFile(
  resolve(dist, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await cp(
  resolve(extension, "node_modules/@fontsource-variable/inter/LICENSE"),
  resolve(dist, "FONT-LICENSE.txt"),
);
if (store) {
  await mkdir(resolve(out, "store"), { recursive: true });
  await check([dist], true);
  const entries = Object.fromEntries(
    await Promise.all(
      (await files(dist)).map(async (f) => [
        relative(dist, f).split(sep).join("/"),
        new Uint8Array(await readFile(f)),
      ]),
    ),
  );
  const zip = resolve(out, "store/kongjing-" + storeVersion + "-store.zip");
  await writeFile(zip, zipSync(entries));
  await checkStoreArchive(root);
  await writeFile(
    resolve(extension, "tests/pack-store-result.json"),
    JSON.stringify(
      { version: storeVersion, store: true, files: Object.keys(entries), zip },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ store: true, output: zip }));
  process.exit(0);
}
await mkdir(out, { recursive: true });
if (unpacked !== resolve(root, "release/unpacked"))
  throw Error("Unsafe output path");
await rm(unpacked, { recursive: true, force: true });
await cp(resolve(extension, "dist"), unpacked, { recursive: true });
await cp(
  resolve(extension, "node_modules/@fontsource-variable/inter/LICENSE"),
  resolve(unpacked, "FONT-LICENSE.txt"),
);
async function files(dir) {
  const a = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) a.push(...(await files(p)));
    else a.push(p);
  }
  return a;
}
await check([dist, unpacked]);
await crx3(await files(unpacked), {
  keyPath,
  crxPath: resolve(out, `kongjing-${version}.crx`),
  zipPath: resolve(out, `kongjing-${version}.zip`),
});
for (const name of ["shiguang-1.0.0.zip", "shiguang-1.0.0.crx"])
  await unlink(resolve(out, name)).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
await writeFile(
  resolve(out, "安装说明.md"),
  `# 空境 · 安装说明\n\n版本 ${version} · 扩展 ID：` +
    id +
    `\n\nChrome 推荐：打开 chrome://extensions → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 unpacked 文件夹。Chrome 正式版限制商店外的自签名 CRX 安装，无法直接拖入 CRX 安装，请使用已解压方式。\n\nEdge：edge://extensions → 开启「开发人员模式」→「加载解压缩的扩展」→ 选择 unpacked；策略允许时也可拖入 kongjing-${version}.crx。\n\n启动时打开空境：浏览器「设置 → 启动时 → 打开新标签页」。\n\n搜索：主页搜索框的任何输入都执行搜索，包括看起来像网址的内容；可用书签或浏览器地址栏直接打开网址。默认使用浏览器设置中的搜索引擎；自用版左侧切换其他引擎仅对当前页面有效，下次打开新标签页恢复默认搜索。商店版始终交由浏览器默认搜索。旧版保存的默认引擎设置会移除，自定义引擎保留。\n\n2.1.0 接力：顶栏「接力」查看其他设备的标签页和浏览记录。设置 → 配对与同步 → 同步内容，按需开启浏览记录与标签页共享；授权为可选，关闭时归还权限。快速收藏和右键菜单可将网页发送到已配对设备，未读网页显示工具栏徽标。无痕、内网与含敏感参数的网址不会采集。\n\n快速收藏：固定工具栏空境图标，点击图标或 Alt+K；可以收藏、更新和移除当前页，也可右键页面或链接收藏。\n\n空境栏：设置 → 空境栏与快速收藏 → 开启，确认可选网站权限。鼠标靠近网页边缘展开，Alt+J 切换；可选择顶部/左侧/右侧或按网站隐藏。\n\n配对：设置 → 配对与同步 → 创建配对组；另一台设备加入并核对两边安全码完全一致后确认。数据端到端加密。2.3.0 默认同步服务器为 https://sync.example.com（EdgeOne），优先设备间 WebRTC 直连，失败时自动中转。已有 Cloudflare 配对组升级后无需重新配对，兼容期最多双写7天，全部设备升级后提前结束。设置 → 配对与同步 → 高级可选择旧版 Cloudflare 或自定义服务器；手动更换服务器需要重新配对。开启「仅直连，不在服务器保存数据」后，离线的设备要等双方同时在线才会同步；整组所有设备都需开启才能保证服务器不留业务暂存。可填写自定义 TURN 地址、用户名及凭证，凭证仅保存在本机。\n\n导入导出：设置 → 数据，支持备份文件或文本码。文本码可设置口令；未加密的文本码持有者可读取内容。请妥善保存备份与口令。兼容拾光 1.x 备份。\n\n## 从拾光 1.x 升级\n\n如果之前是从 release/unpacked 加载的，现在只需在 chrome://extensions 中点击空境卡片上的「重新加载」按钮。扩展 ID 不变，本地书签和设置会自动迁移保留。\n`,
);
await writeFile(
  resolve(extension, "tests/pack-result.json"),
  JSON.stringify(
    {
      id,
      version,
      protocolReady: (await import("node:fs")).existsSync(
        resolve(root, "shared/protocol/READY.md"),
      ),
      files: (await files(unpacked)).map((f) =>
        relative(unpacked, f).split(sep).join("/"),
      ),
    },
    null,
    2,
  ),
);
await checkArchives(root);
console.log(
  JSON.stringify({
    id,
    outputs: [
      "release/unpacked",
      `release/kongjing-${version}.zip`,
      `release/kongjing-${version}.crx`,
    ],
  }),
);
