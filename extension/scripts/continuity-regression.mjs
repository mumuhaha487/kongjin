import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homeServer } from "./android-server.mjs";
const npm =
  process.env.npm_execpath ||
  resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const results = process.argv.includes("--resume")
    ? JSON.parse(await readFile("tests/round1-regression-result.json", "utf8"))
    : [],
  servers = [];
const rerun = new Set(
  (process.argv.find((a) => a.startsWith("--rerun=")) || "")
    .slice(8)
    .split(","),
);
async function run(label, args, env = {}) {
  if (
    results.findLast((r) => r.label === label)?.code === 0 &&
    !rerun.has(label)
  )
    return;
  const start = Date.now(),
    file = "tests/round1-" + label + ".log";
  const log = createWriteStream(file);
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      KJ_SMOKE_CAPTURE: "0",
      KJ_STORE_OFFLINE_ONLY: "1",
        KJ_BLOCK_ONLINE_RELAY: "1",
      ...env,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise((ok, reject) => {
    child.on("error", reject);
    child.on("exit", ok);
  });
  log.end();
  const previous = results.findIndex((r) => r.label === label);
  const entry = { label, code, ms: Date.now() - start, file };
  if (previous >= 0) results[previous] = entry;
  else results.push(entry);
  await writeFile(
    "tests/round1-regression-result.json",
    JSON.stringify(results, null, 2),
  );
  console.log(label + ": " + code + " (" + (Date.now() - start) + "ms)");
  if (code !== 0) throw Error(label + " failed; see " + file);
}
const command = (label, name, env) => run(label, [npm, "run", name], env);
try {
  for (const [label, name] of [
    ["lint", "lint"],
    ["test", "test"],
    ["lint-store", "lint:store"],
    ["test-store", "test:store"],
  ])
    await command(label, name);
  await run("lint-android", ["scripts/android.mjs", "lint"]);
  await run("test-android", ["scripts/android.mjs", "test"]);
  for (const [label, name] of [
    ["build", "build"],
    ["build-qa", "build:qa"],
    ["build-store-qa", "build:store:qa"],
    ["build-android-qa", "build:android:qa"],
    ["build-android", "build:android"],
  ])
    await command(label, name);
  servers.push(
    await homeServer("dist-qa", 4174),
    await homeServer("dist-store-qa", 4176),
  );
  await command("ui", "test:ui");
  await command("a11y", "test:a11y");
  await command("ui-store", "test:ui:store");
  await command("a11y-store", "test:a11y:store");
  await command("ui-android", "test:ui:android");
  await run("search-fix-ui", ["--import", "tsx", "scripts/search-fix-ui.mjs"]);
  await run("continuity-ui", [
    "--import",
    "tsx",
    "scripts/continuity-ui.mjs",
    "--screenshots",
    "--affected",
  ]);
  await command("check-android", "check:android");
  await command("legacy-android", "smoke:legacy:android");
  await command("pack", "pack");
  await command("check", "check");
  await command("smoke", "smoke");
  await command("pack-store", "pack:store");
  await command("check-store", "check:store");
  await command("smoke-store", "smoke:store");
} finally {
  for (const server of servers) await server.close();
}
