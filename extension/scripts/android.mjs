import { spawn } from "node:child_process";
import { resolve } from "node:path";
const npm =
  process.env.npm_execpath ||
  resolve(process.execPath, "../node_modules/npm/bin/npm-cli.js");
const child = spawn(
  process.execPath,
  [npm, "run", process.argv[2] || "build"],
  {
    stdio: "inherit",
    env: { ...process.env, KJ_PLATFORM: "android", KJ_STORE: "0" },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
