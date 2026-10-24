import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { unzipSync } from "fflate";
const root = resolve(".."),
  android = resolve("dist-android");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(dir) {
  const rows = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, e.name);
    if (e.isDirectory()) rows.push(...(await files(path)));
    else if (e.name !== "SHA256SUMS.txt") rows.push(path);
  }
  return rows.sort();
}
const checksums = [];
for (const path of await files(android))
  checksums.push(
    hash(await readFile(path)) +
      "  " +
      relative(android, path).replaceAll("\\", "/"),
  );
await writeFile(
  resolve(android, "SHA256SUMS.txt"),
  checksums.join("\n") + "\n",
);
const paths = [
  "release/kongjing-2.1.5.zip",
  "release/kongjing-2.1.5.crx",
  "release/store/kongjing-2.0.5-store.zip",
  "extension/dist-android/SHA256SUMS.txt",
];
const artifacts = [];
for (const path of paths)
  artifacts.push({ path, sha256: hash(await readFile(resolve(root, path))) });
const old = JSON.parse(
  (
    await readFile(
      resolve(root, "docs/v5-perf/previous-artifacts.json"),
      "utf8",
    )
  ).replace(/^\uFEFF/, ""),
);
for (const row of old)
  assert.equal(
    hash(await readFile(row.path)),
    row.sha256,
    "Old archive changed: " + row.path,
  );
const manifest = async (path) =>
  JSON.parse(
    Buffer.from(
      unzipSync(await readFile(resolve(root, path)))["manifest.json"],
    ).toString(),
  );
const a = await manifest("release/store/kongjing-2.0.1-store.zip"),
  b = await manifest("release/store/kongjing-2.0.5-store.zip");
for (const field of ["permissions", "host_permissions"])
  assert.deepEqual(b[field], a[field]);
assert.equal(b.key, undefined);
assert.equal(b.optional_permissions, undefined);
assert.equal(b.optional_host_permissions, undefined);
const ready = await readFile(resolve(android, "READY.md"), "utf8");
const result = {
  artifacts,
  androidBuildTime: ready.match(/构建时间：(.*)/)[1],
  androidFingerprint:
    "SHA-256 of the sorted per-file SHA256SUMS.txt, including READY.md",
  previousArchivesUnchanged: old.length,
  storePermissions: b.permissions,
  storeHosts: b.host_permissions,
};
await writeFile(
  resolve(root, "docs/v5-perf/artifacts.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
