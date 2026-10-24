import { spawn } from "node:child_process";
import { writeFile, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const npm = resolve(
  dirname(process.execPath),
  "node_modules/npm/bin/npm-cli.js",
);
const servers = [];
process.env.KJ_BLOCK_ONLINE_RELAY = "1";
process.env.KJ_STORE_OFFLINE_ONLY = "1";
process.env.KJ_SMOKE_CAPTURE = "0";
async function run(name, args, env = {}) {
  if(process.env.KJ_ROUND) name += '-round-' + process.env.KJ_ROUND;
  console.log("RUN " + name);
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  const code = await new Promise((r, j) => {
    child.on("error", j);
    child.on("close", r);
  });
  await writeFile("tests/" + name + ".log", out);
  if (code !== 0) throw Error(name + " failed:\n" + out.slice(-9000));
  console.log(
    "PASS " + name + "\n" + out.trim().split("\n").slice(-3).join("\n"),
  );
}
async function preview(outDir, port) {
  const handle = await open("tests/preview-" + port + "-230.log", "w");
  const server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--outDir",
      outDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { windowsHide: true, stdio: ["ignore", handle.fd, handle.fd] },
  );
  servers.push(server);
  await handle.close();
  for (let i = 0; i < 60; i++) {
    if (
      await fetch("http://127.0.0.1:" + port)
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("preview timeout");
}
try {
  await preview("dist-qa", 4174);
  await preview("dist-store-qa", 4176);
  await run("ui-230", [npm, "run", "test:ui"]);
  await run("a11y-230", [npm, "run", "test:a11y"]);
  await run("ui-store-207-v3-check", [npm, "run", "test:ui:store"]);
  await run("a11y-store-207-v3-check", [npm, "run", "test:a11y:store"]);
  await run("ui-android-230", [npm, "run", "test:ui:android"]);
  if(process.env.KJ_UI_ONLY !== '1') {
    await run("check-android-230", [npm, "run", "check:android"]);
    await run("legacy-android-230", [npm, "run", "smoke:legacy:android"]);
  }
} finally {
  for (const s of servers) s.kill();
}
