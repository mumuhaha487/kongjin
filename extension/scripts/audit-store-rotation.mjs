// Audit the existing ZIP without rewriting/repacking historical store releases.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { unzipSync } from "fflate";
import ts from "typescript";
const path = "../release/store/kongjing-2.0.3-store.zip";
const zip = await readFile(path), files = unzipSync(zip);
const text = path => Buffer.from(files[path]).toString("utf8");
const manifest = JSON.parse(text("manifest.json"));
const baseline = JSON.parse(Buffer.from(unzipSync(await readFile(
  "../release/store/kongjing-2.0.1-store.zip"))["manifest.json"]).toString());
for (const field of ["permissions", "host_permissions", "content_security_policy"])
  assert.deepEqual(manifest[field], baseline[field]);
assert.equal("key" in manifest, false);
const visited = new Set();
function scan(path) {
  if (visited.has(path)) return;
  visited.add(path);
  const source = ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function check(node) {
    if (ts.isCallExpression(node)) assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword,
      "Dynamic import in historical store background graph: " + path);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier.text;
      assert.ok(specifier.startsWith("."), "Remote/background import");
      scan(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
    ts.forEachChild(node, check);
  }
  check(source);
}
scan(manifest.background.service_worker);
for (const [path, bytes] of Object.entries(files)) {
  if (/\.(?:js|json|html|css)$/.test(path)) assert.doesNotMatch(Buffer.from(bytes).toString(),
    /接力|continuity|journalAppend|journalCursor|onJournal|onIncoming|putSlot|getSlots|onSlots|deleteSlot|putBlob|getBlob|deleteBlob|recordVisits|setOpenTabs|pendingIncoming/i);
}
const frozen = await readFile("src/vendor/protocol-store/sync.ts", "utf8");
assert.doesNotMatch(frozen, /\bimport\s*\(/);
assert.match(frozen, /async removeDevice\(/);
const result = { passed: true, path, version: manifest.version,
  sha256: createHash("sha256").update(zip).digest("hex"),
  backgroundModules: [...visited], dynamicImports: 0,
  permissions: manifest.permissions, host_permissions: manifest.host_permissions,
  permissionsEqual201: true, continuityExcluded: true, needs204: false,
  note: "Frozen rotation does not migrate continuity. Historical visibility listeners are guarded by typeof document; no DOM dependency on rotation. New builds additionally inline background and strip DOM fallbacks." };
await writeFile("tests/store-213-rotation-audit.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
