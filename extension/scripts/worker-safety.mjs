import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function checkWorker(dir) {
  const code = await readFile(resolve(dir, "background.js"), "utf8");
  assert.doesNotMatch(
    code,
    /\bimport\s*(?:\(|["'{*])/,
    "MV3 background must be a single bundle without imports",
  );
  assert.doesNotMatch(
    code,
    /\b(?:window|document)\b/,
    "MV3 background must not depend on DOM globals",
  );
  assert.doesNotMatch(code, /\bRTCPeerConnection\b|\.createOffer\(|\.setLocalDescription\(/, "WebRTC must live in the offscreen host, never the MV3 worker");
}

export async function checkAndroidEngine(dir) {
  const files = (await readdir(resolve(dir, "assets"))).filter((f) =>
    /^protocol-engine-.*\.js$/.test(f),
  );
  assert.equal(files.length, 1, "Expected isolated production protocol engine");
  const code = await readFile(resolve(dir, "assets", files[0]), "utf8");
  assert.doesNotMatch(
    code,
    /\bimport\s*\(/,
    "Sync engine must only use statically linked modules",
  );
  assert.doesNotMatch(
    code,
    /\bwindow\b|\bdocument\s*[.[]/,
    "Protocol engine must not require page globals",
  );
}
