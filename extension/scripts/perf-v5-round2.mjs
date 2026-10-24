import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { homeServer } from "./android-server.mjs";
import { fixture, setup } from "./fixtures.mjs";

const phase = process.argv[2] || "round2-before";
const root = resolve("../docs/v5-perf");
await mkdir(root + "/traces", { recursive: true });
const browser = await chromium.launch({
  executablePath: resolve("tests/.browser/chrome-win/chrome.exe"),
  headless: true,
  args: ["--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND"],
});
const results = [];
async function click(page,selector){
  const point=await page.evaluate(selector=>{const e=document.querySelector(selector);const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}},selector);
  if(process.env.KJ_PERF_PLATFORM === "desktop") await page.mouse.click(point.x,point.y); else await page.touchscreen.tap(point.x,point.y);
}
async function settings(page) {
  if(process.env.KJ_PERF_PLATFORM === "desktop") return click(page,"[aria-label=设置]");
  await click(page,".avatar-trigger");
  await page.waitForTimeout(600);
  await click(page,".mobile-action-sheet [role=menuitem]:last-child");
}
async function capture(page, cdp, name, action) {
  await cdp.send("Tracing.start", {
    categories:
      "toplevel,devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing",
    transferMode: "ReturnAsStream",
  });
  if(process.env.KJ_PERF_STACKS) await cdp.send("Profiler.enable");
  if(process.env.KJ_PERF_STACKS) await cdp.send("Profiler.setSamplingInterval", {interval:1000});
  if(process.env.KJ_PERF_STACKS) await cdp.send("Profiler.start");
  const start = performance.now();
  await action();
  const elapsed = performance.now() - start;
  const {profile} = process.env.KJ_PERF_STACKS ? await cdp.send("Profiler.stop") : {profile:{startTime:0,nodes:[]}};
  await writeFile(root+"/traces/"+phase+"-"+name+".cpuprofile", JSON.stringify(profile));
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  const { stream } = await done;
  let raw = "";
  for (;;) {
    const v = await cdp.send("IO.read", { handle: stream });
    raw += v.data;
    if (v.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  const trace = JSON.parse(raw);
  await writeFile(
    root + "/traces/" + phase + "-" + name + ".json.gz",
    gzipSync(raw),
  );
  const main = trace.traceEvents.find(
    (e) => e.name === "thread_name" && e.args?.name === "CrRendererMain",
  );
  const events = trace.traceEvents.filter(
    (e) => e.pid === main?.pid && e.tid === main?.tid && e.ph === "X",
  );
  const tasks = events
    .filter(
      (e) => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask",
    )
    .map((e) => [e.ts, e.ts + e.dur])
    .sort((a, b) => a[0] - b[0]);
  let busy = 0,
    end = 0;
  for (const [s, t] of tasks) {
    busy += Math.max(0, t - Math.max(s, end));
    end = Math.max(end, t);
  }
  const sum = (name) =>
    events
      .filter((e) => e.name === name)
      .reduce((s, e) => s + (e.dur || 0) / 1000, 0);
  // Sample compositor presentation events: a JS rAF sampler itself wakes the
  // main thread and forces lifecycle updates, invalidating idle measurements.
  const draws = trace.traceEvents
    .filter((e) => e.name === "DrawFrame" && e.pid === main?.pid)
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const frames = draws.slice(1).map((at, i) => (at - draws[i]) / 1000);
  const metric = {
    phase,
    name,
    elapsedMs: +elapsed.toFixed(2),
    busyPercent: +((busy / 1000 / elapsed) * 100).toFixed(2),
    paintMs: +sum("Paint").toFixed(2),
    compositeMs: +sum("CompositeLayers").toFixed(2),
    layerTreeMs: +sum("Layerize").toFixed(2),
    frames: frames.length,
    droppedPercent: +(
      (100 * frames.filter((n) => n > 16.7).length) /
      frames.length
    ).toFixed(2),
    over25msPercent: +(
      (100 * frames.filter((n) => n > 25).length) /
      frames.length
    ).toFixed(2),
    frameP95Ms: +frames
      .sort((a, b) => a - b)
      [Math.floor(frames.length * 0.95)].toFixed(2),
  };
  const longTasks = tasks.filter(([s,t]) => t-s>50000).sort((a,b)=>(b[1]-b[0])-(a[1]-a[0])).slice(0,5).map(([s,t]) => {
    const nested=events.filter(e=>e.ts>=s&&e.ts<t).sort((a,b)=>(b.dur||0)-(a.dur||0));
    let at=profile.startTime; const counts=new Map();
    profile.samples?.forEach((id,i)=>{at+=profile.timeDeltas[i];if(at>=s&&at<t)counts.set(id,(counts.get(id)||0)+1)});
    const sampled=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id,count])=>{
      let node=profile.nodes.find(n=>n.id===id);const stack=[];
      while(node){stack.push(node.callFrame);node=profile.nodes.find(n=>n.children?.includes(node.id))} return {count,stack};
    });return {durationMs:(t-s)/1000, events:nested.slice(0,15).map(e=>({name:e.name,ms:e.dur/1000})),sampled};
  }); metric.longTasks=longTasks;
  results.push(metric);
  console.log(JSON.stringify({...metric,longTasks:metric.longTasks.map(t=>({durationMs:t.durationMs,events:t.events.slice(0,4)}))}));
}
try {
  for (const platform of [process.env.KJ_PERF_PLATFORM || "android"]) {
    const dir =
      phase.startsWith("round2-before")
        ? ".v5-round2-baseline/" + platform
        : platform === "android"
          ? "dist-android"
          : "dist";
    const server = await homeServer(process.env.KJ_PERF_DIR || dir, platform === "android" ? 4193 : 4194);
    try {
      for (const theme of ["dark"]) {
        const context = await browser.newContext({
          viewport:
            platform === "android"
              ? { width: 412, height: 915 }
              : { width: 1440, height: 900 },
          deviceScaleFactor: platform === "android" ? 2.625 : 2,
          isMobile: platform === "android",
          hasTouch: platform === "android",
          locale: "zh-CN",
        });
        await setup(context, fixture(theme));
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", {
          rate: platform === "android" ? 6 : 4,
        });
        await page.goto(server.base);
        await page.locator(".bookmark-link").first().waitFor();
        await page.waitForTimeout(4000);
        // Visual comparisons use a repeatable background phase. Performance runs remain animated.
        await page.screenshot({
          path:
            root +
            "/screenshots/" +
            phase +
            "-" +
            platform +
            "-" +
            theme +
            "-home.png",
        });
        if (theme === "dark") {
          await capture(page, cdp, platform + "-idle", () =>
            page.waitForTimeout(5000),
          );
          for(const scene of (platform === "desktop" ? [] : process.env.KJ_PERF_SCENE ? [process.env.KJ_PERF_SCENE] : ["settings","relay","bookmark","me"])){
            await capture(page,cdp,platform+"-"+scene,async()=>{
              for(let i=0;i<3;i++){
                if(scene==="settings") await settings(page);
                if(scene==="relay") await click(page,".relay-trigger");
                if(scene==="bookmark") await click(page,"[aria-label=添加书签]");
                if(scene==="me") await click(page,".avatar-trigger");
                await page.waitForTimeout(850);await page.keyboard.press("Escape");await page.waitForTimeout(850);
              }
            });
          }
        }
        await settings(page);
        await page.waitForTimeout(1000);
        await page.screenshot({
          path:
            root +
            "/screenshots/" +
            phase +
            "-" +
            platform +
            "-" +
            theme +
            "-settings.png",
        });
        await context.close();
      }
    } finally {
      await server.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(
    root + "/" + phase + "-metrics.json",
    JSON.stringify(
      {
        method:
          "Chromium CDP CPU throttle; main renderer RunTask union wall duration; Paint/CompositeLayers event sums; compositor DrawFrame intervals >16.7ms (no injected rAF); 5s idle and 3 settings open/close cycles, 850ms each transition wait",
        results,
      },
      null,
      2,
    ),
  );
}
