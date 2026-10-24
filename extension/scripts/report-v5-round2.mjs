import { readFile, appendFile } from "node:fs/promises";
const root = "../docs/v5-perf/";
const read = async (name) => JSON.parse(await readFile(root + name, "utf8"));
const before = await read("round2-before-input-metrics.json");
const after = await read("round2-216-final-metrics.json");
const desktop = await read("round2-216-desktop-metrics.json");
const artifacts = await read("round2-artifacts.json");
const overflow = await read("round2-overflow-results.json");
const profiler = await read("round2-profiler.json");
const visual = await read("round2-visual-results.json");
const tasks = await read("round2-long-tasks.json");
if (overflow.results.length !== 1056 || overflow.errors.length)
  throw Error("Incomplete overflow matrix");
if (profiler.results.some((row) => row.homepageCommits.length))
  throw Error("Homepage commit regression");
const names = { settings: "设置", relay: "接力", bookmark: "添加书签", me: "我的" };
const metrics = Object.entries(names).map(([key, title]) => {
  const a = before.results.find((r) => r.name === "android-" + key);
  const b = after.results.find((r) => r.name === "android-" + key);
  const pass = b.busyPercent <= 25 && b.droppedPercent <= 15 && b.over25msPercent <= 1;
  return `| ${title} | ${a.busyPercent}% → ${b.busyPercent}% | ${a.droppedPercent}% → ${b.droppedPercent}% | ${a.over25msPercent}% → ${b.over25msPercent}% | ${pass ? "三项达标" : "未达标（详见下文）"} |`;
});
const paint = Object.entries(names).map(([key, title]) => {
  const a = before.results.find((r) => r.name === "android-" + key);
  const b = after.results.find((r) => r.name === "android-" + key);
  return `| ${title} | ${a.paintMs} → ${b.paintMs} | ${a.layerTreeMs} → ${b.layerTreeMs} | ${a.compositeMs} → ${b.compositeMs} | ${b.frameP95Ms} |`;
});
const idle = after.results.find((r) => r.name === "android-idle");
const d = desktop.results[0];
const appBefore = tasks.applicationTopFive;
const appAfter = tasks.afterApplicationTopFive;
const rawAfter = tasks.afterAllTraceTopFive.map((t) => {
  const application = t.sampled.some((s) => s.stack.some((f) => f.url?.includes("/assets/")));
  return `| ${t.scene.replace("android-", "")} | ${t.durationMs.toFixed(3)} | ${t.events.slice(0, 3).map((e) => e.name).join(" → ")} | ${application ? "产品采样栈，见下表及JSON" : "浏览器mojo任务，无产品JS采样栈；诊断操作开销单列"} |`;
});
const missingArchives = artifacts.missingPreviousArchives || [];
const archiveNote = missingArchives.length
  ? `现存${artifacts.previousArchivesUnchanged}个旧ZIP/CRX的SHA-256与开工快照相同；但快照中的另${missingArchives.length}个旧自用包（2.0.0、2.0.1、2.1.0—2.1.4的ZIP/CRX）当前已不存在，无法完成历史产物保留复核，preservationPassed=false。没有把缺失项当作通过，也没有重新生成或替换它们。逐项路径与预期哈希保存在[round2-artifacts.json](round2-artifacts.json)。当前2.1.6／2.0.6包的功能、自检、签名检查独立通过，不等于历史保留审计通过。`
  : `${artifacts.previousArchivesUnchanged}个旧ZIP/CRX的SHA-256与开工快照相同。`;
const taskRow = (t) => {
  const frames = t.sampled.find((s) => s.stack.some((f) => f.url?.includes("/assets/")))?.stack || [];
  return `| ${t.scene.replace("android-", "")} | ${t.durationMs.toFixed(3)} | ${frames.filter((f) => f.functionName && !f.functionName.startsWith("(")).slice(0,8).map((f) => f.source?.name || f.functionName).reverse().join(" → ")} |`;
};
const v = visual.filter((r) => r.platform === "desktop");
const maximumDelta = Math.max(...v.map((r) => r.meanChannelDelta));
const maximumChanged = Math.max(...v.map((r) => r.channelsOver8Percent));
const report = `

## 第二轮（自用版／安卓 2.1.6，商店版 2.0.6）

### 结论与验收边界

本轮完成预挂载、分区按需渲染、合成器动画与订阅拆分；功能、无障碍、隔离、兼容性及1056组合审计通过。**四场景主线程忙碌均≤25%，但>16.7ms帧和>25ms帧均未达到规范；第二轮交互性能验收未通过。** 没有把主线程忙碌达标等同于帧指标达标。未达标项保留为待 PM 复核，不调整16.7ms/25ms阈值，也不删除慢帧。

### 实现与证据

1. 安卓设置、接力、我的、添加书签在首屏绘制后的空闲时预挂载，关闭时保留同一DOM，translateY(100%)、visibility:hidden、inert及aria-hidden；停放层额外opacity:0阻止content-visibility缓存子列表透出，已纳入全部1056组合的断言；关闭不销毁React树，重新打开不重新创建整棵树。隐藏使用visibility保留布局缓存，不使用整棵抽屉content-visibility:hidden再丢弃缓存。只在分区上使用content-visibility:auto与contain-intrinsic-size。历史保留虚拟滚动，设备页卡片按需渲染、标签页/收件箱首批数量保留。
2. SheetFrame采样既有spring.smooth（300/32/1）产生原生WAAPI transform关键帧，遮罩只动opacity，未更改设计时长/弹簧。面板、舞台仅在动画期间设置will-change，结束清除；安卓打开壳不运行layoutId/高度布局动画，桌面原共享元素保持。布局尺寸由预热和ResizeObserver缓存，正常开关不逐帧测量。动画只改transform/opacity。
3. App、主页、设置、Header及数据/配对订阅拆分，更新后结构共享未变数据分支。设置分区memo，开关/分段控件独立订阅。React profiling renderer仅用于QA独立目录：四场景Background/Clock/Search/Bookmarks均0次提交；设置“搜索历史”只提交setting:history；另有真实主页更新正向控制，证明计数器运行。证据：[round2-profiler.json](round2-profiler.json)，脚本extension/scripts/profiler-v5-round2.mjs。
4. 按下态transition-property仅transform/opacity。暂停选择器从html后代收窄至背景和时钟星点；html保留诊断状态，不让每次触摸使整页样式失效。保留native setVisible、hidden、触摸600ms恢复、同步宿主不暂停。暂停测试剔除已finished的CSSAnimation（其currentTime可随文档时间变化，但不再执行动画），仍严格断言所有未结束动画暂停且时间不变。
5. 自查截图发现配对图示固定72px撑大40px设置摘要图示，已修正为随原容器缩放，两颗独立合成器圆点沿原椭圆运行；图形、尺寸与桌面原版一致。修正预挂载书签图标请求的active变量遮蔽，隐藏时不请求图标。Esc、焦点陷阱、关闭焦点归还、下拉关闭、长按释放不误选均回归。

### 四场景性能（同一成对测量口径）

Playwright自带Chromium，412×915、DPR2.625、touch、CPU6×；保留的2.1.5原构建作为基线，不用新源码重建基线。每场景开/关3次，各等待850ms，设置从“我的”进入（额外600ms等待）；输入均为一次坐标采样后touchscreen.tap，避免role定位反复轮询的测试开销。主线程采用CrRendererMain RunTask并集/场景墙钟时间；帧为compositor DrawFrame原始间隔，>16.7ms与>25ms均原样计数；不注入rAF采样器，不按帧数倒推CPU。最终性能采集独立串行运行，期间没有审计/构建/其他测试浏览器任务。

| 场景 | 主线程忙碌（≤25%） | >16.7ms帧（≤15%） | >25ms帧（≤1%） | 三项合并判定 |
| --- | --- | --- | --- | --- |
${metrics.join("\n")}

| 场景 | Paint ms，前→后 | Layerize ms，前→后 | CompositeLayers ms，前→后 | 优化后帧P95 ms |
| --- | --- | --- | --- | --- |
${paint.join("\n")}

安卓静置主线程忙碌${idle.busyPercent}%，Paint ${idle.paintMs}ms；静置原始>16.7ms帧${idle.droppedPercent}%、>25ms帧${idle.over25msPercent}%。桌面4×降速静置主线程忙碌${d.busyPercent}%，Paint ${d.paintMs}ms，均按≤5%独立判断。主机静置时本身存在大量略超过16.7ms的原始间隔，这是测量环境的实际观测，不是免除交互帧验收的理由；交互中>25ms仍表示有真实剩余开销。没有使用“平均60fps”替代规范百分比。

数据：[基线](round2-before-input-metrics.json)、[最终](round2-216-final-metrics.json)、[桌面](round2-216-desktop-metrics.json)。原始gzip trace在traces/；中间实验和诊断分开命名，未选作最终验收结果。

### 最慢5个长任务调用栈归因

单独CPU采样诊断（不混入上述验收百分比）。全trace最慢5项以及采样栈完整保存在[round2-long-tasks.json](round2-long-tasks.json)。诊断期间的浏览器mojo任务、产品bundle采样栈及Playwright注入查询分别保留；没有把无产品JS采样的mojo任务归给业务函数。优化后的全trace前5项如下，产品调用栈另列；只列出产品任务不能代替原始全trace列表。

| 场景 | 任务ms | trace嵌套事件 | 归因 |
| --- | --- | --- | --- |
${rawAfter.join("\n")}

优化前：

| 场景 | 任务ms | 栈（外→内，截取） |
| --- | --- | --- |
${appBefore.map(taskRow).join("\n")}

主要来自React提交时motion投影节点首次mount/addListeners/measureScroll，以及measureViewportBox→getBoundingClientRect强制布局；设置首项含Layout约214ms，焦点切换亦触发布局。预挂载、安卓去投影和布局缓存针对这些路径。

优化后产品诊断（本次仅观测到${appAfter.length}条具备产品JS采样栈的>50ms任务，不补造第5条）：

| 场景 | 任务ms | 栈（外→内，截取） |
| --- | --- | --- |
${appAfter.map(taskRow).join("\n")}

剩余产品采样主要指向React提交→舞台stageAnimation/WAAPI启动，以及焦点陷阱focus/归还焦点引起的样式/布局更新。源码映射指向src/lib/compositor.ts与src/components/Common/Common.tsx，完整祖先链见JSON。未采样最终trace中的产品长任务最大99.124ms；该trace不记录JS采样栈，不能把诊断trace的调用栈当作逐事件精确对应。源映射和CPU profile仅在诊断目录，不进入生产包。诊断开销会放大任务时长，原始未采样trace同样保留，二者未混算。基线完整采样栈保存在round2-before-profiled.json；早期原始cpuprofile被无采样运行覆盖过，不能据其placeholder声称原始采样仍完整。

### 桌面视觉与溢出复查

深浅主题逐一对比2.1.5与2.1.6的主页、设置、引擎菜单、添加书签、我的（10组成对图）；安卓主页/设置4组成对图。固定12:51、无限动画固定相位、等待入场完成。浮层外框坐标/尺寸逐项断言差≤0.5CSSpx，14组实测最大差均为0；桌面最大平均通道差${maximumDelta.toFixed(6)}/255，通道差>8的比例最大${maximumChanged.toFixed(6)}%；主页/书签/我的主要差异为小于1级像素/子像素抗锯齿，设置为独立圆点的SVG/CSS栅格差，菜单文字有子像素抗锯齿差。逐张目检未发现布局、尺寸、色值或层级变化。数据：[round2-visual-results.json](round2-visual-results.json)。

![桌面浅色设置：左2.1.5／右2.1.6](screenshots/round2-compare-desktop-light-settings.png)
![桌面深色设置：左2.1.5／右2.1.6](screenshots/round2-compare-desktop-dark-settings.png)

重新跑44界面×4视口×3字体档×2主题=**1056/1056通过**，无横向溢出、非省略文本裁切或相邻按钮重叠。独立BrowserContext按4组并发执行，全部场景与断言保持相同；没有放宽±0.5px断言；隐藏/inert节点不属于可见元素，规定的横向滚动轨道及竖向抽屉滚动内容按原规则检查。证据：[round2-overflow-results.json](round2-overflow-results.json)，88张关键图screenshots/round2-overflow-*.png及12张逐张复查联系表round2-review-*.png。本轮没有新增视觉取值或放宽溢出规则。

### 最终回归与构建

| 检查 | 自用2.1.6 | 商店2.0.6 | 安卓2.1.6 |
| --- | --- | --- | --- |
| lint / strict TypeScript / build | 通过 | 通过 | 通过 |
| Vitest | 149通过，1既有跳过 | 100通过，1既有跳过 | 144通过，6既有平台跳过 |
| UI／无障碍 | 通过 | 通过 | 触摸、长按、拖拽、焦点、Esc、安全区、缺原生降级通过 |
| 自检／隔离 | CSP、敏感值、静态worker、签名和ID通过 | 无接力、无key/宽泛权限/内容脚本、ZIP逐字节通过 | 相对资源、PoW、同步静态包与Chrome87通过 |
| 冒烟 | 真实MV3扩展离线通过，无控制台/CSP错误 | 离线真实MV3扩展通过，线上次数0 | 两种旧API缺失模式、KJ2/KJ2E互通、inert和焦点通过 |

Chrome87审计：94源码文件（含shared）、11JS、3CSS；协议源码未修改，sync.ts SHA-256仍f26c3c2f05c798ef7dc485ce85cbc4af8816ee26c04dfbf96c3384b723991ca4。日志extension/tests/{test,lint,build}-*-216.log、*-206.log、verify-216.log、profiler-216.log、behavior-216.log、overflow-216-final.log、check-216.log、check-store-206.log、smoke-216.log、smoke-store-206.log。所有命令检测退出码，失败不会沿用旧构建继续验收。

商店权限与2.0.1逐项相同：${artifacts.storePermissions.map((p) => "`" + p + "`").join(" / ")}；host_permissions为${artifacts.storeHosts.join(", ")}，无key、optional_permissions、optional_host_permissions。私钥未覆盖，自用ID仍agijcmabomapmbobdgblmckibkpobdij。

历史产物复核：${archiveNote}

| 产物 | SHA-256 |
| --- | --- |
${artifacts.artifacts.map((a) => `| [${a.path}](../../${a.path}) | \`${a.sha256}\` |`).join("\n")}

Android READY构建时间：**${artifacts.androidBuildTime}**；版本2.1.6，setVisible、markIncomingRead及既有桥接方法保留，入口https://appassets.androidplatform.net/home/index.html。Android目录指纹为排序逐文件清单SHA256SUMS.txt的SHA-256（含READY，排除清单自身）。

### 复现

工作目录extension/；测试前设置KJ_BLOCK_ONLINE_RELAY=1、KJ_STORE_OFFLINE_ONLY=1、KJ_SMOKE_CAPTURE=0。没有调用ADB/模拟器或线上中转，没有修改shared/relay/android/server。

三端lint/test及build沿用第一轮命令；本轮脚本：node scripts/verify-v5-round2.mjs；KJ_PROFILE=1 npm run build:android:qa后npx tsx scripts/profiler-v5-round2.mjs；npx tsx scripts/overflow-v5-round2.mjs；node scripts/review-v5-round2.mjs；npx tsx scripts/visual-v5-round2.mjs。性能单独运行npx tsx scripts/perf-v5-round2.mjs round2-216-final；桌面设KJ_PERF_PLATFORM=desktop后同脚本round2-216-desktop。CPU栈诊断另设KJ_PERF_STACKS=1，KJ_PERF_MAP=1仅产生独立源码映射目录。正常生产构建不带Profiler/源码映射。

最后npm run pack → npm run build:android → npm run pack:store；npm run check / check:store / check:android / check:compat:android；npm run smoke / smoke:store；node scripts/artifact-v5-round2.mjs；node scripts/report-v5-round2.mjs。不要重跑一次性报告追加器产生重复小节。

### 待 PM 复核

- 四场景帧阈值的未达标项按上表保留，不能据主线程降幅宣称第二轮全部通过。静置原始帧间隔噪声及交互真实长帧同时记录，未以“环境因素”豁免规范。
- 历史产物保留审计：${archiveNote}
- 不更改视觉、动画时长/弹簧和DPR来换取分数。下一步应结合安卓工程师的真实WebView/gfxinfo指标判断剩余交互光栅化开销；本轮没有代测设备。
- 原生WAAPI曲线按原弹簧参数逐帧预采样（60Hz），单独合成器执行；分区独立订阅和缓存不改变文案/样式。正常构建使用普通React renderer，计数只在QA profiling构建生效。
`;
const existing = await readFile(root + "REPORT-web.md", "utf8");
if (existing.includes("## 第二轮（自用版／安卓 2.1.6")) throw Error("Round two already appended");
await appendFile(root + "REPORT-web.md", report);
console.log("Appended verified round-two report");
