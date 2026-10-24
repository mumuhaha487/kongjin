import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const dir = "../docs/v5-perf/";
const json = async (name) =>
  JSON.parse(await readFile(dir + name + ".json", "utf8"));
const baseline = (await json("baseline-metrics")).results,
  optimized = (await json("optimized-metrics")).results;
const overflow = await json("overflow-results"),
  visual = await json("visual-results"),
  artifacts = await json("artifacts");
assert.equal(overflow.results.length, 1056);
assert.equal(overflow.results.filter((r) => r.issues.length).length, 0);
assert.deepEqual(overflow.errors, []);
const labels = {
  "android-idle": "安卓静置",
  "android-drawer": "安卓设置开合×3",
  "desktop-idle": "桌面静置",
  "desktop-drawer": "桌面设置开合×3",
};
const metricRows = [];
for (const old of baseline) {
  const next = optimized.find((r) => r.name === old.name);
  assert.ok(next);
  for (const r of [old, next])
    metricRows.push(
      `| ${labels[r.name]} | ${r === old ? "2.1.4" : "2.1.5"} | ${r.elapsedMs} | ${r.busyPercent}% | ${r.paintMs} | ${r.compositeMs} | ${r.layerTreeMs} | ${r.droppedPercent}% | ${r.over25msPercent}% | ${r.frameP95Ms} |`,
    );
}
const before = baseline.find((r) => r.name === "android-drawer"),
  after = optimized.find((r) => r.name === "android-drawer");
const metrics =
  "| 场景 | 版本 | 时长 ms | 主线程忙碌 | Paint ms | CompositeLayers ms | Layerize ms | >16.7ms帧 | >25ms帧 | P95帧 ms |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n" +
  metricRows.join("\n") +
  `\n\n两端静置均 ≤5%，静置 Paint 为 0。安卓抽屉主线程忙碌 ${before.busyPercent}% → ${after.busyPercent}%；>16.7ms 帧 ${before.droppedPercent}% → ${after.droppedPercent}%（下降 ${(before.droppedPercent - after.droppedPercent).toFixed(2)} 个百分点）；>25ms 明显长帧 ${before.over25msPercent}% → ${after.over25msPercent}%（相对下降 ${((100 * (before.over25msPercent - after.over25msPercent)) / before.over25msPercent).toFixed(1)}%）。严格 16.7ms 阈值非常接近 60Hz 的调度抖动，不能把其绝对值等同设备 gfxinfo 掉帧率。完整列出桌面抽屉的波动，不据此声称桌面抽屉所有帧指标都改善。`;
const names = {
  home: "主页/继续浏览/同步状态",
  "engine-menu": "引擎菜单",
  "search-history": "搜索历史",
  "bookmark-actions": "长按操作表",
  "bookmark-add": "添加书签",
  "bookmark-custom": "自定义图标",
  "bookmark-edit": "编辑书签",
  avatar: "头像抽屉",
  "avatar-link": "头像链接",
  me: "我的操作表",
  "settings-profile": "设置·我的",
  "settings-pairing": "设置·配对与同步",
  "settings-appearance": "设置·外观",
  "settings-clock": "设置·时钟与问候",
  "settings-search": "设置·搜索",
  "settings-bookmarks": "设置·书签",
  "settings-browser": "设置·浏览器",
  "settings-data": "设置·数据",
  "settings-about": "设置·关于",
  "settings-sharing": "设置·同步内容",
  "settings-advanced": "设置·高级",
  "data-export-code": "导出文本码",
  "data-import-preview": "导入预览",
  "history-consent": "浏览记录授权",
  "tabs-consent": "标签页授权",
  "pair-intro": "配对·介绍",
  "pair-preparing": "配对·准备中",
  "pair-invite": "配对·邀请",
  "pair-join": "配对·加入",
  "pair-sas": "配对·安全码",
  "pair-success": "配对·成功",
  "pair-failure": "配对·失败",
  "removed-notice": "移除通知卡",
  "relay-devices": "接力·设备/收到网页",
  "relay-history": "接力·历史/设备筛选",
  "clear-history": "清除浏览记录",
  "confirm-reset": "恢复默认确认",
  "confirm-leave": "离开配对组确认",
  "confirm-remove-device": "移除设备确认",
  "confirm-replace": "替换数据确认",
  "confirm-clear-browser": "清除浏览数据确认",
  "confirm-permission": "权限确认",
  "confirm-welcome": "升级欢迎卡",
  toast: "Toast",
};
const scenes = [...new Set(overflow.results.map((r) => r.name))];
const rows = scenes.map((name) => {
  const note =
    name === "pair-invite"
      ? "修复：配对码两行"
      : name === "settings-data"
        ? "修复：重置按钮不收缩/不换行"
        : name === "bookmark-actions"
          ? "修复：长按释放不误触，明确验证实际操作表"
          : "通过；无需新增布局取值";
  return `| ${names[name] || name} | 24/24 | ${note} | [小屏/大字体/深色](screenshots/overflow-${name}-360-130-dark.png) · [412/浅色](screenshots/overflow-${name}-412-100-light.png) |`;
});
const audit =
  "| 界面 | 组合通过 | 修复项/结果 | 截图 |\n| --- | ---: | --- | --- |\n" +
  rows.join("\n");
const visualTable =
  "| 平台/主题 | 界面 | 平均通道差（0–255） | 通道差>8占比 |\n| --- | --- | ---: | ---: |\n" +
  visual
    .map(
      (r) =>
        `| ${r.platform}/${r.theme} | ${r.name} | ${r.meanChannelDelta.toFixed(4)} | ${r.channelsOver8Percent.toFixed(4)}% |`,
    )
    .join("\n") +
  "\n\n数值见 [visual-results.json](visual-results.json)。安卓面板差异为 §2.3 明确要求的轻量档效果；桌面设置新增一行导致该区域内容顺移。";
const checks = `| 项目 | 自用版 2.1.5 | 商店版 2.0.5 | 安卓主页 2.1.5 |\n| --- | --- | --- | --- |\n| ESLint | 通过 | 通过 | 通过 |\n| Vitest | 147通过/1既有跳过 | 98通过/1既有跳过 | 142通过/6既有平台跳过 |\n| Build/QA Build | 通过 | 通过 | 通过 |\n| UI/无障碍 | UI、焦点陷阱、Esc、菜单键盘通过 | 同左，隔离检查通过 | 触摸、长按、拖拽、抽屉、横屏安全区、桥接/缺原生降级通过 |\n| 正式构建自检 | CSP/敏感值/签名/ID通过 | 权限/无key/无接力/ZIP逐字节通过 | appassets相对资源、PoW worker、同步包静态导入检查通过 |\n| 真实扩展/旧环境冒烟 | unpacked新标签页、popup、favicon、动态内容脚本通过，无控制台/CSP错误 | 正式扩展收藏/搜索/配对入口通过，无控制台/CSP错误；线上次数0 | 删除新API/拒绝deflate-raw两模式通过，KJ2/KJ2E兼容及焦点/Esc通过 |\n| Chrome/WebView87兼容检查 | 桌面目标不变 | 桌面目标不变 | 90源码（含shared）、11JS、3CSS通过 |\n\n本轮新增5项性能单元测试（分钟/秒边界、8节点预算、60段transform流光、smoothFirst迁移、可见性与暂停计时）。证据日志位于 extension/tests/：lint-{self,store,android}-v5-final.log、test-{self,store,android}-v5-final.log、verify-v5-final.log、behavior-v5-final.log、check-v5-final.log、check-store-v5-final.log、smoke-v5-final.log、smoke-store-v5-final.log、build-android-v5-final.log。`;
const artifactTable =
  "| 产物 | SHA-256 |\n| --- | --- |\n" +
  artifacts.artifacts
    .map((r) => `| [${r.path}](../../${r.path}) | \`${r.sha256}\` |`)
    .join("\n") +
  `\n\n安卓已就绪：构建时间 **${artifacts.androidBuildTime}**；入口 https://appassets.androidplatform.net/home/index.html。READY.md 明确 2.1.5 与 setVisible。目录校验以 SHA256SUMS.txt 的 SHA-256 为整体指纹（清单按文件名排序，含 READY.md，排除清单自身），不是把目录当成单个文件。\n\n${artifacts.previousArchivesUnchanged} 个既有 ZIP/CRX 哈希全部保持原值。自用 unpacked 位于 release/unpacked/。商店权限：${artifacts.storePermissions.map((v) => "`" + v + "`").join(" / ")}；host_permissions：${artifacts.storeHosts.map((v) => "`" + v + "`").join(" / ")}，与2.0.1一致。详见 [artifacts.json](artifacts.json)。`;
let report = await readFile(dir + "REPORT-web.md", "utf8");
for (const [key, value] of Object.entries({
  metrics,
  overflow: audit,
  visual: visualTable,
  checks,
  artifacts: artifactTable,
})) {
  assert.ok(
    report.includes("<!-- " + key + " -->"),
    "Report marker missing: " + key,
  );
  report = report.replace("<!-- " + key + " -->", value);
}
await writeFile(dir + "REPORT-web.md", report);
console.log(
  "Report completed: 1056 audit combinations, final traces, artifacts, visual review and three-platform verification",
);
