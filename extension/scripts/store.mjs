import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
const npm =
  process.env.npm_execpath ||
  resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const result = spawnSync(
  process.execPath,
  [
    npm,
    "run",
    process.argv[2],
    ...(process.argv[2] === "test" ? ["--", "--exclude", "tests/continuity*.test.ts"] : []),
    ...(process.argv.length > 3 ? ["--", ...process.argv.slice(3)] : []),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, KJ_STORE: "1" },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
