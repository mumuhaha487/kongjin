import { defineConfig, build } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createManifest, version } from "./scripts/manifest.mjs";
import { checkAndroidEngine } from "./scripts/worker-safety.mjs";
import { androidCss } from "./scripts/android-css";
import type { NormalizedOutputOptions, OutputBundle } from "rollup";
const real = existsSync(resolve("../shared/protocol/READY.md"));
const store = process.env.KJ_STORE === "1";
const android = process.env.KJ_PLATFORM === "android";
if (!store && !readFileSync(resolve("../shared/protocol/READY.md"), "utf8").includes("## v3.3.1"))
  throw Error("Protocol v3.3.1 readiness is required before building self-use/Android");
const storePlugins = () => [
  ...(store
    ? [
        {
          name: "kongjing-store-exclude-continuity",
          enforce: "pre" as const,
          transform(code: string, id: string) {
            if (
              /\.[tj]sx?$/.test(id) &&
              id.replace(/\\/g, "/").includes("/src/")
            )
              return code.replace(/!STORE\b/g, "false");
          },
          resolveId(source: string) {
            if (/\/peer-mesh\.ts$/.test(source)) return "\0kj-store-peer";
            if (/(^|\/)continuity\//.test(source) || /offscreen\/remote$/.test(source)) return "\0kj-store-excluded";
          },
          load(id: string) {
            if (id === "\0kj-store-peer") return `export class PeerMesh {
              ensure() {} setForeground() {} dispose() {} connectedSlots() { return []; }
              async broadcast() {} async acceptSignal() {} async send() { throw Error("NETWORK"); }
            }`;
            if (id === "\0kj-store-excluded")
              return "export const OffscreenController=undefined,remoteContinuity=undefined,receiveHostState=undefined,hostCollect=undefined,hostNotify=undefined,installDesktopContinuity=undefined,mergeSnapshots=undefined,normalizeSnapshot=undefined,attachContinuity=undefined,continuityHost=undefined,snapshotForSharing=undefined,connectContinuity=undefined,useContinuity=undefined,continuityCommand=undefined,openContinuity=undefined,shareBackground=undefined,RelayRoot=undefined,ResumePill=undefined,RelayButton=undefined,SharingSettings=undefined,SendRow=undefined;";
          },
          generateBundle(
            _options: NormalizedOutputOptions,
            bundle: OutputBundle,
          ) {
            for (const [file, chunk] of Object.entries(bundle)) {
              if (
                chunk.type !== "chunk" ||
                !("\0kj-store-excluded" in chunk.modules)
              )
                continue;
              if (
                Object.values(bundle).some(
                  (other) =>
                    other.type === "chunk" &&
                    other !== chunk &&
                    (other.imports.includes(file) ||
                      other.dynamicImports.includes(file) ||
                      other.code.includes(file)),
                )
              )
                throw Error("Store exclusion was referenced at runtime");
              delete bundle[file];
            }
          },
        },
      ]
    : []),
];
const protocolAlias = (mode: string) =>
  resolve(
    mode === "qa"
      ? "src/features/pairing/mock/index.ts"
      : real
          ? "../shared/protocol/src/index.ts"
          : "src/features/pairing/unavailable.ts",
  );
const engineAlias = () => [];
export default defineConfig(({ mode }) => ({
  plugins: [
    ...storePlugins(),
    ...(android
      ? [
          {
            name: "kongjing-android-css87",
            enforce: "pre" as const,
            transform(code: string, id: string) {
              if (id.endsWith(".css")) return androidCss(code, id);
            },
          },
        ]
      : []),
    react(),
    {
      name: "kongjing-manifest",
      async generateBundle(_options, bundle) {
        if ((android || store) && mode !== "qa") {
          await writeFile(
            resolve(
              store
                ? "tests/store-build-graph.json"
                : "tests/webview87-build-graph.json",
            ),
            JSON.stringify(
              {
                target: store ? "chrome111" : "chrome87",
                modules: [
                  ...new Set(
                    Object.values(bundle).flatMap((chunk) =>
                      chunk.type === "chunk" ? Object.keys(chunk.modules) : [],
                    ),
                  ),
                ],
              },
              null,
              2,
            ),
          );
        }
      },
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return android
            ? html
                .replace("/src/app/main.tsx", "/src/platform/android-entry.ts")
                .replace(
                  "width=device-width,initial-scale=1.0",
                  "width=device-width,initial-scale=1.0,viewport-fit=cover,interactive-widget=resizes-content",
                )
            : html;
        },
      },
      async writeBundle(options) {
        if (!android) {
          // MV3 forbids import(), including same-origin modules. Do not share
          // the page's lazy chunks or DOM-based preload helper with this entry.
          await build({
            configFile: false,
            plugins: [
              ...storePlugins(),
              {
                name: "kongjing-worker-safety",
                generateBundle(_options, bundle) {
                  const chunks = Object.values(bundle).filter(
                    (c) => c.type === "chunk",
                  );
                  if (chunks.length !== 1 || chunks[0].type !== "chunk")
                    throw Error("Background must be one chunk");
                  const worker = chunks[0];
                  if (
                    worker.imports.length ||
                    worker.dynamicImports.length ||
                    /\bimport\s*\(|\b(?:window|document)\b/.test(worker.code)
                  )
                    throw Error("Unsafe service worker output");
                },
                async writeBundle(_options, bundle) {
                  if (store && mode !== "qa") {
                    const path = resolve("tests/store-build-graph.json");
                    const graph = JSON.parse(readFileSync(path, "utf8"));
                    graph.modules = [
                      ...new Set([
                        ...graph.modules,
                        ...Object.values(bundle).flatMap((c) =>
                          c.type === "chunk" ? Object.keys(c.modules) : [],
                        ),
                      ]),
                    ];
                    await writeFile(path, JSON.stringify(graph, null, 2));
                  }
                },
              },
            ],
            define: {
              __KJ_STORE__: JSON.stringify(store),
              __KJ_ANDROID__: "false",
              ...(store ? { RTCPeerConnection: "undefined" } : {}),
              window: "undefined",
              document: "undefined",
              "globalThis.document": "undefined",
            },
            resolve: { alias: [{ find: "@kongjing/protocol", replacement: protocolAlias(mode) }, ...engineAlias()] },
            publicDir: false,
            build: {
              outDir: options.dir,
              emptyOutDir: false,
              target: "chrome111",
              modulePreload: false,
              rollupOptions: {
                input: resolve("src/background/index.ts"),
                output: {
                  inlineDynamicImports: true,
                  entryFileNames: "background.js",
                },
              },
            },
          });
        }
        if (android) {
          const { rm, cp } = await import("node:fs/promises");
          await rm(resolve(options.dir!, "manifest.json"), { force: true });
          const { readFile } = await import("node:fs/promises");
          const boot = await readFile(resolve("public/boot.js"), "utf8");
          await writeFile(
            resolve(options.dir!, "boot.js"),
            'document.documentElement.dataset.platform="android";' +
              boot +
              ';try{if(!localStorage.getItem("kongjing:mirror"))document.documentElement.dataset.theme=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}catch(_){}',
          );
          await cp(
            resolve("node_modules/@fontsource-variable/inter/LICENSE"),
            resolve(options.dir!, "FONT-LICENSE.txt"),
          );
          if (mode !== "qa") await checkAndroidEngine(options.dir!);
          if (mode !== "qa")
            await writeFile(
              resolve(options.dir!, "READY.md"),
              `# 空境安卓主页已就绪\n\n构建时间：${new Date().toISOString()}\n\n入口：https://appassets.androidplatform.net/home/index.html\n\n最低支持 Chrome / WebView 87；安卓入口在加载应用前安装内置方法、inert 及压缩流兼容层，CSS按Chrome87降级。\n\n资源均为相对路径；请将本目录整体复制到 assets/home/。生产使用真实协议库 v3.3.1（入组首次写入至少2分钟退避重试、joinPhase/Device.joining、直连存活检测、withLocalLock应用原子提交、EdgeOne + WebRTC直连）；sync-edge.ts SHA-256：${createHash("sha256").update(readFileSync(resolve("../shared/protocol/src/sync-edge.ts"))).digest("hex")}；adaptive-poll.ts SHA-256：${createHash("sha256").update(readFileSync(resolve("../shared/protocol/src/adaptive-poll.ts"))).digest("hex")}；shared/protocol/src/sync.ts SHA-256：${createHash(
                "sha256",
              )
                .update(readFileSync(resolve("../shared/protocol/src/sync.ts")))
                .digest(
                  "hex",
                )}，IndexedDB本机数据及密钥存储，页面内同步，PoW入口 ./pow.worker.js。\n\n主页版本：${version}。2.4.0 按 MOBILE-UI §2 优化安卓手机竖屏与横屏主页：合并问候日期（保留完整昵称并仅按宽度省略昵称，问候行左右留20px，日期完整）、竖屏内容上下1:2弹性空白（超屏归零）、横屏左栏在可用高度居中、缩小时钟、48px搜索、52px书签图块、横屏40%/60%两栏及auto-fill/minmax(72px,1fr)自动列数网格；HomeInsets可选--kj-toolbar-height，未提供时56px加安全区，底部另留16px；桌面与平板布局不变。2.3.4 新增完成加入与可恢复失败视图、本次和重开页面重试、邀请方等待加入标签；显式取消清理待加入凭据。2.3.3 修复接力设备卡片离线徽标、时间与发送按钮受压折行；控件单行断言已加入完整溢出矩阵。2.3.2 已包含设备行间距、分隔线与连接标签层级修订；安卓抽屉/对话框/菜单/Toast 使用不透明 --glass，深浅关闭态开关使用 --toggle-off；默认浏览器行未默认显示“去设置”，已默认显示绿色 Check 与“已是默认”；高级设置的“仅直连”开关下方新增持续可见的传输与离线更新说明。桌面常规毛玻璃保持原样。沿用 2.3.1 的本机写入/远端合并丢失更新修复，所有上下文共用 kongjing:app-data Web Lock，原生收藏等待落盘和发布排入；配对设备行自适应高度。BRIDGE §7 已支持 scrollToTop、addReadLater、pairWithCode、browserPrefsChanged；调用 getBrowserPrefs、setWebDarkMode、setTextZoom、requestDefaultBrowser，缺原生接口隐藏新偏好。安卓环境单调度器最高30Hz，20秒空闲后1.2秒减速定格。第二轮交互优化：空闲预挂载抽屉、分区content-visibility、原参数合成器弹簧、细粒度订阅与布局缓存；markIncomingRead已实现。性能版：静态canvas背景、合成器云海、安卓轻量面板、流畅优先、分钟对齐时钟。新增 BRIDGE setVisible {visible:boolean}，暂停隐藏主页动画和界面计时，通过setForeground同步实际可见性，安卓隐藏且无待发时停止轮询。被移出配对组通知本地持久化，支持确认清除、重新配对清除及一次6秒Toast。换密钥迁移已改为静态模块，兼容 MV3 service worker；同步引擎包禁止动态导入。markIncomingRead 已实现（批量标记已读、幂等 ack）。历史标题修复：电脑端延迟采集与30秒补查；本地及远端同一访问可补齐真实标题、同步刷新搜索索引；空标题按主机名与路径显示。2.1.2新增授权tabs时120秒内迟到标题按原始at补齐。新增 BRIDGE：recordVisits、setOpenTabs、getDevices、sendToDevice、searchHistory、openRelay、pendingIncoming、markIncomingRead；调用原生 incoming / requestNotificationPermission 时缺失降级。原生接口以 docs/v3-mobile/BRIDGE.md 和 docs/v4-continuity/PROTOCOL.md §8 为准，收到 KongjingNative.ready() 后才调用 window.kongjing.call(id, method, argsJson)。searchBookmarks 已支持：检索全部同步书签，默认最多6条，按标题前缀、标题包含、网址包含排序。\n`,
            );
          return;
        }
        await writeFile(
          resolve(options.dir!, "manifest.json"),
          JSON.stringify(await createManifest(store), null, 2),
        );
      },
    },
  ],
  define: {
    __KJ_STORE__: JSON.stringify(store),
    __KJ_ANDROID__: JSON.stringify(android),
    ...(store ? { RTCPeerConnection: "undefined" } : {}),
  },
  base: "./",
  ...(android
    ? {
        css: {
          transformer: "lightningcss" as const,
          lightningcss: { targets: { chrome: 87 << 16 } },
        },
      }
    : {}),
  resolve: {
    alias: [
      { find: "@kongjing/protocol", replacement: protocolAlias(mode) },
      ...engineAlias(),
      ...(process.env.KJ_PROFILE === "1"
        ? [
            {
              find: /^react-dom\/client$/,
              replacement: resolve("node_modules/react-dom/profiling.js"),
            },
          ]
        : []),
    ],
  },
  build: {
    modulePreload: {
      resolveDependencies(_filename, deps, context) {
        // MV3 service workers have no document/head for modulepreload links.
        return context.hostId === "background.js" ? [] : deps;
      },
    },
    outDir:
      process.env.KJ_PERF_MAP === "1"
        ? "dist-android-analysis"
        : process.env.KJ_PROFILE === "1"
          ? "dist-android-profiler"
          : `dist${android ? "-android" : store ? "-store" : ""}${mode === "qa" ? "-qa" : ""}`,
    sourcemap: process.env.KJ_PERF_MAP === "1",
    target: android ? "chrome87" : "chrome111",
    ...(android
      ? { cssTarget: "chrome87", cssMinify: "lightningcss" as const }
      : {}),
    rollupOptions: {
      input: {
        index: resolve("index.html"),
        ...(!android
          ? {
              popup: resolve("popup.html"),
            }
          : {}),
        ...(!android ? { bar: resolve("src/content/bar.ts") } : {}),
        ...(!android && !store ? { offscreen: resolve("offscreen.html") } : {}),
        "pow.worker": resolve(
          android
            ? "src/platform/android-pow.worker.ts"
            : "src/features/pairing/pow.worker.ts",
        ),
      },
      output: {
        entryFileNames: (chunk) =>
          ["background", "bar", "pow.worker"].includes(chunk.name)
            ? chunk.name + ".js"
            : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        ...(android && mode !== "qa"
          ? {
              manualChunks: (id: string) =>
                id.replace(/\\/g, "/").includes("/shared/protocol/src/")
                  ? "protocol-engine"
                  : undefined,
            }
          : {}),
      },
    },
  },
}));
