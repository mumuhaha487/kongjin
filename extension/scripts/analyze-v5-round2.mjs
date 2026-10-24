import { readFile, readdir, writeFile } from "node:fs/promises";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
const root = "../docs/v5-perf/";
const read = async (name) => JSON.parse(await readFile(root + name, "utf8"));
const baseline = await read("round2-before-profiled.json");
const current = await read("round2-216-profiled-metrics.json");
function tasks(input) {
  return input.results.filter((r) => r.name !== "android-idle")
    .flatMap((r) => r.longTasks.map((t) => ({ scene: r.name, ...t })))
    .sort((a,b) => b.durationMs-a.durationMs);
}
const before = tasks(baseline), after = tasks(current);
const fromBundle = (s) => s?.stack.some((f) => f.url?.includes("/assets/") && !f.functionName.startsWith("("));
const result = {
  note: "Separate CPU-profiled diagnostics only. All-trace lists include Profiler/Playwright tasks. Application list requires built-assets CPU samples; before requires top sample, after allows native program/focus top sample with application ancestor. No sampled diagnostic percentages are acceptance metrics.",
  allTraceTopFive: before.slice(0,5),
  applicationTopFive: before.filter((t) => fromBundle(t.sampled?.[0])).slice(0,5),
  afterAllTraceTopFive: after.slice(0,5),
  afterApplicationTopFive: after.filter((t) => t.sampled?.some(fromBundle)).slice(0,5),
};
const maps = await readdir("dist-android-analysis/assets");
const cache = new Map();
for (const t of result.afterApplicationTopFive) {
  for (const sample of t.sampled) {
    for (const frame of sample.stack) {
      if (!frame.url?.includes("/assets/")) continue;
      const prefix = frame.url.split("/").at(-1).replace(/-[\w-]+\.js$/, "-");
      const name = maps.find((n) => n.startsWith(prefix) && n.endsWith(".js.map"));
      if (!name) continue;
      if (!cache.has(name)) cache.set(name, new TraceMap(JSON.parse(await readFile("dist-android-analysis/assets/"+name,"utf8"))));
      frame.source = originalPositionFor(cache.get(name), { line: frame.lineNumber+1, column:frame.columnNumber });
    }
  }
}
await writeFile(root + "round2-long-tasks.json", JSON.stringify(result,null,2));
console.log("Mapped five application long tasks; raw profiler/automation tasks retained separately");
