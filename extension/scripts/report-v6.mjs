import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const artifacts=await json('../docs/v6/artifacts.json'),ambient=await json('../docs/v6/ambient-results.json'),matrix=await json('../docs/v6/overflow-results.json'),extra=await json('../docs/v6/overflow-extra-results.json'),visual=await json('../docs/v6/v6-visual-results.json'),ui=await json('../docs/v6/ui-results.json');
assert.equal(matrix.errors.length,0);assert.ok(matrix.results.every(r=>!r.issues.length));assert.ok(extra.results.every(r=>!r.issues.length));assert.equal(ui.errors.length,0);
const active=ambient.results[0],idle=ambient.results[1],hidden=ambient.results[2];assert.equal(idle.drawFrames,0);assert.equal(ambient.frozenImageChangedChannels,0);
const rows=artifacts.artifacts.map(a=>'| ['+a.path+'](../../'+a.path+') | `'+a.sha256+'` |').join('\n');
const text=`# 空境 2.2.0／商店版 2.0.7 · 主页报告

## 结果与范围

完成性能第三轮及 BROWSER-FEATURES A1/A2/A4/A6/A7/A13 的主页侧。三端构建、单元、UI、无障碍、自检、旧 WebView 模拟、真实 MV3 离线冒烟通过；安卓完整矩阵 ${matrix.results.length}/${matrix.results.length}，桌面／商店新增界面补充矩阵 ${extra.results.length}/${extra.results.length}。已逐张查看新增截图和 12 张溢出联系表。仅写 extension/、docs/v6/ 本轮证据与报告、release/ 本轮包；没有操作 ADB、模拟器或线上中转，也没有修改 shared/relay/android/server。原生实现与设备测量仍由安卓工程师负责。

## 第三轮环境动画

- 安卓使用一个 AmbientClock setTimeout 调度器，节拍1000/30+1ms，避免计时器整数截断后超过30Hz；注册上限6个元素，只写transform/opacity，无逐帧布局读取。3层云海、闪烁星父层、时钟四角星、冒号共6个注册；实测最高${ambient.maxCallbacksPerSecond}批/秒，单批实际属性变化最多${ambient.maxElementsPerTick}元素。桌面仍使用原CSS／WAAPI，不使用该环境计时器。
- 最后一次触摸／按键／滚动后20秒开始减速，1200ms线性降低速度，按速度积分推进虚拟相位；总位移等价20600ms匀速运动。停后无环境计时器，恢复不重置位置；触摸立即唤醒，滚动与抽屉暂停策略保留。hidden或原生setVisible(false)立即停止；流畅优先、reduced-motion完全禁用环境调度。
- 抽屉、按下态、弹簧仍走原60Hz合成器路径，没有接入限帧器或改弹簧参数。时钟按分钟对齐刷新保留；测试固定Date以免分钟变化的正常交互帧污染环境帧计数。

Playwright Chromium，412×915，DPR2.625，touch，CPU6×；生产dist-android，本地预览，所有性能采集独立串行进行，期间不跑构建／矩阵／其他浏览器测试。主线程忙碌=CrRendererMain顶层RunTask并集/墙钟窗口，含GC；不注入rAF采样器。一次明确touchstart作为t=0，30秒后开始固定15秒静置窗口；保留完整压缩trace。

| 阶段 | 窗口 | 主线程忙碌 | DrawFrame | Paint | GC耗时 |
| --- | --- | --- | --- | --- | --- |
| 活动期 | ${active.elapsedMs}ms | ${active.busyPercent}% | ${active.drawFrames} | ${active.paintMs}ms | ${active.gcMs}ms |
| 最后活动30秒后 | ${idle.elapsedMs}ms | **${idle.busyPercent}%** | **${idle.drawFrames}** | **${idle.paintMs}ms** | ${idle.gcMs}ms |
| 原生setVisible(false) | ${hidden.elapsedMs}ms | ${hidden.busyPercent}% | ${hidden.drawFrames} | ${hidden.paintMs}ms | ${hidden.gcMs}ms |

定格后间隔1.2秒的两张截图：变化通道${ambient.frozenImageChangedChannels}、最大差${ambient.maxDelta}/255，6个元素inline style完全一致，running动画列表为空；唤醒后云海位置继续推进。单元注入时钟验证20s+1.2s减速、每步位移连续、末步小于1ms等价位移、冻结后零调用，以及恢复时相位不跳变。

证据：[ambient-results.json](ambient-results.json)、[定格图1](screenshots/ambient-frozen-start.png)、[定格图2](screenshots/ambient-frozen-after.png)、traces/ambient-*.json.gz。早期5秒诊断窗口曾测到2.983%（DrawFrame仍0），其中存在V8内存回收长任务；该原始证据保留为ambient-results-diagnostic-5s.json及traces/ambient-frozen-diagnostic-5s.json.gz。最终采用预先固定15秒窗口，**没有扣除GC或删除慢任务**；不能把本轮接近零的空闲数字解释为活动期CPU也接近零。

## 新功能与证据

| 需求 | 实现 | 验证 |
| --- | --- | --- |
| A4 配对二维码 | 三端添加设备界面，配对码下160px黑白SVG，12px白卡圆角；M纠错、4模块quiet zone；内容kongjing://pair?code=KJ-XXXXX-XXXXX；失效隐藏 | jsQR独立解码单元测试，三端UI精确内容、尺寸与黑白断言；screenshots/pair-qr-{desktop,store,android}.png |
| A4 pairWithCode | 接受完整码或deeplink，校验后打开设置配对加入并填码；不自动连接 | Android UI检查填码、BAD_CODE、无SAS／自动提交；pair-prefilled-android.png |
| A13 稍后阅读 | 安卓addReadLater及自用／商店popup BookOpen次按钮；不存在创建末尾分组；同组规范化URL去重并返回已有id；仍为普通书签同步 | 单元验证去重／末尾／已有其他组／危险URL；桥接持久化回读；两版popup写入回读；read-later-popup-*.png及*-saved.png |
| A1 scrollToTop | window和主页各滚动容器平滑回顶 | UI建立64书签的真实可滚动主页，先断言scrollY>0，再调用并等到scrollY=0 |
| A2 默认浏览器 | native偏好组的设为默认按钮；isDefault禁用并显示已是默认浏览器 | 原生调用记录、browserPrefsChanged更新断言 |
| A6 网页深色 | 跟随主题／始终／关闭，darkSupported=false隐藏 | 三选项和setWebDarkMode参数、动态隐藏验证 |
| A7 文字大小 | 80–150%，step10；12px基础示例文字按比例实时显示；只调用原生，不写同步设置 | 150%预览18px、setTextZoom调用及步长单元；browser-prefs-android-light.png |
| BRIDGE §7 降级 | browserPrefsChanged重读；没有getBrowserPrefs或JSON失效时隐藏新原生偏好组 | 缺原生／缺方法／不支持深色测试；已有浏览器搜索与清除设置保留 |

二维码库qrcode-generator 2.0.4随包本地编译，附QRCODE-LICENSE.txt，不加载远程脚本。jsQR仅为dev测试依赖。原生偏好不进AppData，因此不跨设备同步。没有改变原生浏览器工具栏或相机行为。

## 视觉、溢出与复查

安卓47界面×4视口(360×640／360×800／390×844／412×915)×3字体(100／115／130%)×深浅=${matrix.results.length}，全部通过。包括原44界面、新默认浏览器态／不支持深色态／150%文字预览；加入二维码也在原invite场景内。另对桌面与商店的二维码和稍后阅读按钮检查4视口×3字体×深浅，共${extra.results.length}组通过。补充审计发现窄屏大字体的配对码裁切，已仅在≤480px时允许换行；没有缩小字号或裁剪文字。其余新界面没有新增溢出修复。

审计断言保留document宽度、元素横向边界±0.5px、非省略叶文本裁切、同级按钮相交；允许规范指定的横向轨道、竖向抽屉滚动。字体按原computed字号独立倍增，避免继承倍增。证据：[overflow-results.json](overflow-results.json)、[补充结果](overflow-extra-results.json)，screenshots/overflow-*.png共94张、review-{dark,light}-*.png共12张；目检配对码／二维码、默认态、深色支持隐藏、150%示例、收藏按钮与书签、抽屉可滚动内容。

桌面2.1.6保留产物与2.2.0在深浅下的主页／设置／引擎菜单／添加书签／我的10组对比，固定时间和环境动画相位；最大几何差${Math.max(...visual.map(r=>r.maxGeometryDelta))}px，最大平均通道差${Math.max(...visual.map(r=>r.meanChannelDelta)).toFixed(6)}/255，>8通道差比例最大${Math.max(...visual.map(r=>r.channelsOver8Percent)).toFixed(6)}%。逐张复查无布局变化，少量文字光栅化差异保留原始结果：[v6-visual-results.json](v6-visual-results.json)。

![桌面浅色设置，左2.1.6／右2.2.0](screenshots/v6-compare-desktop-light-settings.png)
![桌面深色设置，左2.1.6／右2.2.0](screenshots/v6-compare-desktop-dark-settings.png)

## 回归与兼容性

| 检查 | 自用2.2.0 | 商店2.0.7 | 安卓2.2.0 |
| --- | --- | --- | --- |
| lint／strict TS／build | 通过 | 通过 | 通过 |
| Vitest | 155通过，1既有skip | 106通过，1既有skip | 150通过，6既有平台skip |
| UI与a11y | 搜索／菜单／导入导出／焦点／Esc通过 | 同左，chrome.search.query原文参数通过 | 触摸／长按／拖拽／焦点／Esc／安全区／桥接降级通过 |
| 自检 | CSP、敏感扫描、单文件worker、ZIP/CRX签名和ID通过 | 隔离、无key/内容脚本/宽泛权限、ZIP逐字节通过 | 相对资源、无chrome依赖、PoW/静态同步包、appassets本地资源检查通过 |
| 冒烟 | 真实MV3 Chromium离线通过 | 真实MV3 Chromium离线通过，线上attempts=0 | 缺API与拒绝raw两模式，三压缩格式互通／KJ2与KJ2E／inert通过 |

Chrome87审计扫描当前102源码文件（含shared）、11个JS、3个CSS；构建target chrome87，motion同样转译；其余既有JS/CSS降级保留。最终构建时并行协议新增sync-edge.ts使用Array.at，补充安卓专用core-js/actual/array/at，审计明确记录该polyfill而非放宽规则；旧环境先删除Array.at再加载主页，验证at(-1)与越界行为。桌面／商店不导入安卓polyfill。

最终打包的真实协议源码sync.ts SHA-256：**${artifacts.protocolHash}**。开工时是f26c3c2f05c798ef7dc485ce85cbc4af8816ee26c04dfbf96c3384b723991ca4；并行协议工程后来更新了该文件，READY目前仍标记v2.2.3。本任务没有编辑shared，也没有接入新EdgeOne API或改变默认中转。最后对该哈希重跑三端单元测试，并对打包前后哈希相同做断言，证据extension/tests/v6-verified-protocol.json、v6-pack-protocol.json。安卓READY记录实际源码哈希。

日志：extension/tests/v6-build-test-final.log、v6-current-protocol-unit.log、v6-verify-final.log、v6-ui.log、v6-overflow-final.log、v6-overflow-extra.log、v6-perf.log、v6-final.log及各分项日志；每个runner验证退出码。没有因早期失败沿用旧包声称通过。

商店权限与2.0.1逐项相同：storage／favicon／activeTab／contextMenus／alarms／search；host_permissions=https://kongjing.inc.re/*。无key、optional_permissions、optional_host_permissions，不含接力代码；仍用冻结的商店协议副本。私钥未覆盖，自用ID：**${artifacts.id}**。开工快照中${artifacts.previousArchivesUnchanged}个现存旧ZIP/CRX哈希全部保持一致。

## 产物

| 路径 | SHA-256 |
| --- | --- |
${rows}

Android目录整体就绪；清单指纹是排序逐文件SHA256SUMS.txt自身的SHA-256，含READY，排除清单自身。构建时间 **${artifacts.androidBuildTime}**；入口https://appassets.androidplatform.net/home/index.html，READY明确2.2.0与BRIDGE §7。

## 复现命令

工作目录extension/。测试设KJ_BLOCK_ONLINE_RELAY=1、KJ_STORE_OFFLINE_ONLY=1、KJ_SMOKE_CAPTURE=0；不使用线上集成命令。

\`node scripts/build-test-v6.mjs\`；三端QA构建后\`node scripts/verify-v6.mjs\`；\`npx tsx scripts/v6-ui.mjs\`；\`npx tsx scripts/overflow-v6.mjs\`、\`npx tsx scripts/overflow-v6-extra.mjs\`；\`node scripts/review-v6.mjs\`；\`npx tsx scripts/visual-v6.mjs\`（需保留.v6-baseline/desktop）。性能单独运行\`npx tsx scripts/perf-v6.mjs\`，与其他采集严格串行。最后\`node scripts/final-v6.mjs\`按pack→build:android→pack:store→三端check→两版离线smoke执行；\`node scripts/artifact-v6.mjs\`生成目录清单及旧包／权限比对，\`node scripts/report-v6.mjs\`生成本报告。

## 待 PM 复核

- 6层预算：安卓4颗闪烁星保留原位置与各自基础不透明度，改为共用一个父层3秒alternate呼吸（原首星周期）；加入冒号一起停，避免冻结仍有呼吸帧。桌面8颗独立动画不改。20秒后按线性速度衰减积分，恢复保留当前位置。
- 规范未给新range轨道/拇指细节，复用4px已有尺寸及18px toggle圆点与accent；示例以既有12px帮助文字为100%基准；QR卡内边距复用12px令牌。原生组缺接口整组隐藏，既有浏览器分区保留。
- 同网址已在其他分组时，保留原书签并在稍后阅读另存；同稍后阅读组内规范化去重。不移动用户已有分组内容。
- 协议源码在并行任务中更新，而READY版本标签未同步；本轮准确记录实际哈希与验证结果，不替并行工程修改标签。当前功能与权限不启用EdgeOne；后续迁移应另行验收。
`;
await writeFile('../docs/v6/REPORT-web.md',text);console.log('REPORT written');
