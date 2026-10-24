import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { unzipSync } from "fflate";
import { version, storeVersion } from "./manifest.mjs";
import { checkWorker } from "./worker-safety.mjs";
async function walk(dir) {
  const a = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) a.push(...(await walk(p)));
    else a.push(p);
  }
  return a;
}
const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ADMIN_KEY/,
  /edgeone_API_Token/i,
  /Bearer\s+[A-Za-z0-9_-]{32,}/,
  /["'](?:token|password|secret)["']\s*:\s*["'][A-Za-z0-9_+/=-]{32,}["']/,
];
let secretCache;
async function sensitiveValues() {
  if (secretCache) return secretCache;
  const dir = fileURLToPath(new URL("../../.secrets", import.meta.url));
  let entries;
  try {
    entries = await walk(dir);
  } catch {
    return (secretCache = []);
  }
  const values = [];
  for (const path of entries) {
    const content = await readFile(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.+)\s*$/.exec(
        line,
      );
      if (
        match &&
        !new Set(["CF_ZONE_NAME", "KONGJING_DOMAIN"]).has(match[1])
      ) {
        const value = match[2].trim().replace(/^["']|["']$/g, "");
        if (value) values.push(value);
      }
    }
  }
  return (secretCache = values);
}
export async function check(dirs, store = false) {
  for (const dir of dirs) {
    await checkWorker(dir);
    const manifest = JSON.parse(
      await readFile(resolve(dir, "manifest.json"), "utf8"),
    );
    for (const field of [
      "name",
      "short_name",
      "version",
      "description",
      "permissions",
      "host_permissions",
      "icons",
      "chrome_url_overrides",
      "content_security_policy",
    ])
      assert.ok(manifest[field], field);
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, store ? storeVersion : version);
    if (store) {
      for (const field of [
        "key",
        "content_scripts",
      ])
        assert.equal(field in manifest, false, field);
      assert.equal(manifest.commands["toggle-bar"].suggested_key.default, "Alt+J");
      assert.deepEqual(manifest.optional_permissions, ["scripting"]);
      assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "http://*/*"]);
    } else {
      assert.ok(manifest.key);
      assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
      assert.deepEqual(manifest.optional_permissions, [
        "history",
        "tabs",
        "notifications",
      ]);
    }
    assert.equal(manifest.chrome_url_overrides.newtab, "index.html");
    for (const page of ["index.html", "popup.html", ...(!store ? ["offscreen.html"] : [])]) {
      const html = await readFile(resolve(dir, page), "utf8");
      for (const tag of html.matchAll(
        /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
      )) {
        assert.match(tag[1], /\bsrc=["'][^"']+["']/);
        assert.equal(tag[2].trim(), "");
        assert.doesNotMatch(tag[1], /src=["'](?:https?:)?\/\//);
      }
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    }
    assert.deepEqual(
      manifest.permissions,
      store
        ? [
            "storage",
            "favicon",
            "activeTab",
            "contextMenus",
            "alarms",
            "search",
          ]
        : [
            "storage",
            "favicon",
            "activeTab",
            "contextMenus",
            "scripting",
            "alarms",
            "search",
            "offscreen",
          ],
    );
    assert.deepEqual(manifest.host_permissions, ["https://kongjing.inc.re/*"]);
    assert.equal(manifest.background.type, "module");
    assert.equal(manifest.action.default_popup, "popup.html");
    assert.equal(
      manifest.commands["_execute_action"].suggested_key.default,
      "Alt+K",
    );
    {
      assert.equal(
        manifest.commands["toggle-bar"].suggested_key.default,
        "Alt+J",
      );
      const bar = await readFile(resolve(dir, "bar.js"));
      assert.ok(bar.length <= 40 * 1024);
      assert.doesNotMatch(
        bar.toString(),
        /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/,
      );
    }
    for (const f of await walk(dir)) {
      assert.doesNotMatch(f, /\.(?:pem|map)$/);
      const text = (await readFile(f)).toString("utf8");
      for (const pattern of forbidden) assert.doesNotMatch(text, pattern, f);
      for (const secret of await sensitiveValues())
        if (text.includes(secret))
          throw Error("Sensitive value detected in generated artifact");
      if (/\.(?:js|html|json)$/.test(f))
        assert.doesNotMatch(text, /auth-endpoint|kj:mock/);
      if (store) {
        assert.doesNotMatch(f, /[\\/]offscreen(?:\.html|[\\/])/);
        if (/\.(?:js|html|json|css)$/.test(f))
          assert.doesNotMatch(
            text,
            /<all_urls>|chrome\.history|recordVisits|setOpenTabs|kj-send-device|relay-panel|relay-resume/i,
          );
        if (/\.(?:js|html)$/.test(f)) assert.doesNotMatch(text, /RTCPeerConnection|\.offscreen\./);
      }
      assert.doesNotMatch(text, /importScripts\(["']https?:/);
    }
  }
}
function protoFields(buf) {
  const fields = [];
  let offset = 0;
  const varint = () => {
    let n = 0,
      shift = 0,
      b;
    do {
      b = buf[offset++];
      n += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return n;
  };
  while (offset < buf.length) {
    const tag = varint(),
      wire = tag & 7,
      field = tag >> 3;
    assert.equal(wire, 2);
    const n = varint();
    fields.push([field, buf.subarray(offset, offset + n)]);
    offset += n;
  }
  return fields;
}
export async function checkArchives(root) {
  const unpacked = JSON.parse(
      await readFile(resolve(root, "release/unpacked/manifest.json"), "utf8"),
    ),
    publicKey = Buffer.from(unpacked.key, "base64");
  const crx = await readFile(resolve(root, `release/kongjing-${version}.crx`));
  assert.equal(crx.subarray(0, 4).toString(), "Cr24");
  assert.equal(crx.readUInt32LE(4), 3);
  const n = crx.readUInt32LE(8),
    header = protoFields(crx.subarray(12, 12 + n)),
    signed = header.find(([f]) => f === 10000)[1],
    proof = protoFields(header.find(([f]) => f === 2)[1]),
    key = proof.find(([f]) => f === 1)[1],
    signature = proof.find(([f]) => f === 2)[1];
  assert.deepEqual(key, publicKey);
  assert.deepEqual(
    protoFields(signed)[0][1],
    createHash("sha256").update(publicKey).digest().subarray(0, 16),
  );
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signed.length);
  assert.ok(
    verify(
      "sha256",
      Buffer.concat([
        Buffer.from("CRX3 SignedData\0"),
        size,
        signed,
        crx.subarray(12 + n),
      ]),
      createPublicKey({ key, format: "der", type: "spki" }),
      signature,
    ),
  );
  for (const archive of [
    await readFile(resolve(root, `release/kongjing-${version}.zip`)),
    crx.subarray(12 + n),
  ]) {
    const entries = unzipSync(archive);
    assert.equal(
      JSON.parse(Buffer.from(entries["manifest.json"]).toString()).key,
      unpacked.key,
    );
    for (const [name, bytes] of Object.entries(entries)) {
      for (const secret of await sensitiveValues())
        if (Buffer.from(bytes).includes(Buffer.from(secret)))
          throw Error("Sensitive value detected in archive");
      assert.doesNotMatch(name, /\.pem$/);
      for (const pattern of forbidden)
        assert.doesNotMatch(Buffer.from(bytes).toString(), pattern);
    }
  }
}
export async function checkStoreArchive(root) {
  const dist = resolve(root, "extension/dist-store");
  await check([dist], true);
  const entries = unzipSync(
    await readFile(
      resolve(root, `release/store/kongjing-${storeVersion}-store.zip`),
    ),
  );
  const paths = await walk(dist);
  assert.equal(Object.keys(entries).length, paths.length);
  for (const [name, bytes] of Object.entries(entries)) {
    assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
    assert.deepEqual(
      Buffer.from(bytes),
      await readFile(resolve(dist, name)),
      name,
    );
    assert.doesNotMatch(name, /\.pem$/);
    for (const secret of await sensitiveValues())
      if (Buffer.from(bytes).includes(Buffer.from(secret)))
        throw Error("Sensitive value detected in store archive");
    for (const pattern of forbidden)
      assert.doesNotMatch(Buffer.from(bytes).toString(), pattern);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  if (process.env.KJ_STORE === "1") {
    if (process.argv.includes("--build-only")) {
      await check([resolve(root, "extension/dist-store")], true);
      console.log(
        "PASS: 当前商店构建权限、CSP与敏感值检查（未改动 release，不比较既有ZIP字节）",
      );
      process.exit(0);
    }
    await checkStoreArchive(root);
    console.log("PASS: 商店ZIP基础/可选权限、无key/静态注入、CSP与敏感值检查");
    process.exit(0);
  }
  await check([
    resolve(root, "extension/dist"),
    resolve(root, "release/unpacked"),
  ]);
  await checkArchives(root);
  console.log(
    "PASS: CSP、字段、敏感内容、ZIP、CRX3 签名和三种产物公钥/ID 一致",
  );
}
