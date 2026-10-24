import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative, sep } from "node:path";
import sharp from "sharp";
import crx3 from "crx3";
import { check, checkStoreArchive } from "./check.mjs";
import { createManifest, storeVersion } from "./manifest.mjs";
import { zipSync } from "fflate";
const store = true;
const root = fileURLToPath(new URL("../..", import.meta.url)),
  extension = resolve(root, "extension"),
  out = resolve(root, "release"),
  keyPath = resolve(root, "keys/shiguang.pem");
const manifest = await createManifest(true);
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
  await mkdir(out, { recursive: true });
  await check([dist], true);
  const entries = Object.fromEntries(
    await Promise.all(
      (await files(dist)).map(async (f) => [
        relative(dist, f).split(sep).join("/"),
        new Uint8Array(await readFile(f)),
      ]),
    ),
  );
  const zip = resolve(out, "kongjing.zip");
  await writeFile(zip, zipSync(entries));
  await checkStoreArchive(root);
  const signingKey = process.env.KONGJING_CRX_KEY_PATH || keyPath;
  if (existsSync(signingKey)) {
    await crx3(createReadStream(zip), {
      keyPath: signingKey,
      crxPath: resolve(out, "kongjing.crx"),
    });
  } else {
    // An open-source build must not invent a replacement signing identity.
    await unlink(resolve(out, "kongjing.crx")).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    console.log("Set KONGJING_CRX_KEY_PATH to your existing key to also sign a CRX.");
  }
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
async function files(dir) {
  const entries = [];
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    const path = resolve(dir,entry.name);
    if (entry.isDirectory()) entries.push(...await files(path));
    else entries.push(path);
  }
  return entries;
}
