# READY — 空境协议库与本地中转

状态：2026-10-23 v2.2.2 协议库与本地中转修复已就绪。协议库 66/66、中转 36/36、两边类型检查通过；local/workerd 接口、三设备与日负载回归通过。本轮未修改 Worker、未部署、未运行线上写入；生产保留 v2.2.1 部署。最新修复说明和 sync.ts 哈希见末尾 v2.2.2 小节。

第 1 轮基线：Node 本地、wrangler dev、线上共用协议套件均 8/8 组，中转单元/本地回归 22/22；本地、workerd、线上直连与代理三设备场景均 6/6，线上 A→B 直连 2670ms、代理 2162ms，R2 原始字节密文检查通过。生产地址 https://kongjing.inc.re；各轮证据见 docs/v2/REPORT-relay.md。

## 扩展入口

Vite 别名 `@kongjing/protocol` 指向 `shared/protocol/src/index.ts`，直接导入 `KongjingSync`、`SecretStore`、`SyncStatus` 等。不依赖 Node 内置模块，无需预构建，库运行时无第三方依赖。

```ts
import { KongjingSync, type SecretStore } from '@kongjing/protocol';
// 在 extension/src 下的文件中；若文件更深，调整相对路径。
import powWorkerUrl from '../../shared/protocol/src/pow.worker.ts?worker&url';

const sync = new KongjingSync({
  relayUrl: 'http://127.0.0.1:8790', // 生产环境用 https://kongjing.inc.re
  secrets: indexedDbSecretStore,
  loadLocal, saveMerged, merge,
  powWorkerUrl,
});
await sync.init();
```

`SecretStore` 实现使用 IndexedDB（建议 `kj-secrets`）。必须以原生值存取、保留 CryptoKey 的 structured clone；不要 JSON 序列化密钥或把私钥转存 chrome.storage。库使用 `identity`、`group`、`relayUrl` 三个键。身份私钥不可导出；Node 测试可用导出的 `MemorySecretStore`。

只在 background/service worker 创建一个实例；popup/newtab 经 runtime 消息读取状态。唤醒后调用 init() 自动恢复组与 WS。数据变化调用 notifyLocalChange()，saveMerged 写入时不要再次触发无条件上传循环；merge 由扩展注入。成员移除事件为 `on('removed', ...)`。dispose() 停止网络与定时器，保留存储凭证；leave() 清除组凭证但保留设备身份及本地书签。

## 本地中转

```powershell
cd relay
npm ci
node local/server.mjs --port 8790 --data ./.data/dev --pow 0
```

端口 8790；HTTP/WS 协议与 Worker 共用实现；本地文件保存密文和服务运行机密，内存/文件 DO 适配。`--pow 0` 只用于开发，默认 18。本地 CORS 只放行固定扩展 ID、http://localhost:* 与 https://appassets.androidplatform.net。局域网可加 `--host 0.0.0.0`，其他机器填本机局域网地址。所有限流仍有效，重复大量联调可能得到 429；测试数据请使用单独目录。

## 接入约定与限制

- PoW JSON 为完整 challenge 响应加 `nonce`（uint64 大端 8 字节的 base64url）；向量见 test/vectors.json。
- `join().sas` 返回 `{ sas, inviterName, platform }`；`sas` 为格式化六位安全码，双方必须分别确认。`inviterName` / `platform` 来自通过 MAC 校验的 hello-i.name / hello-i.platform；名称原文返回，与 hello-j 的 peer.name 显示一致。例如默认名称「MacBook · Chrome」直接显示，不重复拼接平台。
- 快照使用标准 CompressionStream('deflate') 去掉 zlib 包装获得 deflate-raw；自带 raw DEFLATE 解码器，兼容 Node 18，浏览器代码没有 Node import。
- 已配对更换 relayUrl 会抛 RELAY_CHANGE_REQUIRES_REPAIR；先离开再重新配对。
- 重命名/加入通过成员信封认证新公钥；密钥轮换使用身份 ECDH 包裹，移除设备拿不到 wrap。
- 服务不会记录请求体。只有测试文件可使用 Node 内置模块。
- 最终接入请基于当前源码重新构建扩展：已修复 welcome 后拉取快照与配对关闭的竞态，以及加密等待期间 WS 拉取推进 rev 时的 CAS 竞争（PUT 固定使用本次合并所依据的 rev，收到 412 后重新合并）。
- PoW 使用有界并行 WebCrypto 加速；遇到两分钟挑战过期会重新申请，最多三次，不降低服务端难度。慢速或繁忙设备仍可能需要更长时间。

## 第 2 轮更新：hello-i 邀请方名称

hello-i 新增 `name`、`platform`；MAC 严格使用 `HMAC(authKey, "I|" + epkI + "|" + epkJ + "|" + name + "|" + platform)`。任一字段被篡改时，以 `BAD_CODE` 中止，不提供 SAS 或设备名称。邀请方发送当前设备名称，包含 renameSelf 后的新名称；加入方仅在字段及 MAC 验证成功后返回名称和平台。

两类 hello 共用字符串类型校验；缺失、null、数字、数组均拒绝。现有 hello-j 与 PROTOCOL 未单设名称长度或禁用字符规则，本轮不新增数值/字符限制，保留原文参与 MAC；中转原有 16 KB 配对帧上限继续适用。

**shared/protocol/src/sync.ts SHA-256：** `d44706af089c5a527c46d596c0bb1a0013ef455f31d073b4beb77032d94462e7`

新增固定 MAC 向量及真实 invite/join 回归，覆盖两个字段各自篡改、已签名但类型错误、旧 MAC 拒绝、中文/Unicode 原文及重命名。新旧 hello-i 的 MAC 不兼容，不接受旧格式回退；配对双方需使用本次源码重新构建。线上 Worker 原样转发配对帧，本轮无需更改。

本轮复现命令（PowerShell；使用独立目录，避免影响端口 8790 的扩展联调）：

```powershell
cd shared\protocol
npm test
npm run typecheck
cd ../..
# 终端 1：--pow 0 仅用于本地测试
node relay/local/server.mjs --port 8792 --data shared/protocol/node_modules/.cache/hello-i-round2-reproduce --pow 0
# 终端 2（仓库根目录）
node relay/node_modules/tsx/dist/cli.mjs shared/protocol/test/local-e2e.ts http://127.0.0.1:8792
Get-FileHash shared/protocol/src/sync.ts -Algorithm SHA256
```

本地结果见 `shared/protocol/artifacts/round2-local-e2e.json`。本轮未修改 extension/、release/、keys/、server/ 或 relay/ 实现，未访问 Cloudflare 凭证，未部署或重置线上限流。

## v2.2 接力 API 已就绪

READY 时间：2026-10-22 20:27（UTC+08:00）。可开始接入；下方 v2.2.1 说明优先于本节旧时间参数。入口仍为 `shared/protocol/src/index.ts`，直接引用源码；快照、配对、hello-i 与轮换保持原接口。

```ts
import { KongjingSync, IndexedDBQueueStore } from '@kongjing/protocol';
const sync = new KongjingSync({
  relayUrl: 'http://127.0.0.1:8790', secrets,
  queueStore: new IndexedDBQueueStore('kj-continuity'),
  loadLocal, saveMerged, merge, powWorkerUrl,
});
// 在 init 前注册；按 record.id 写入应用数据，保证业务效果幂等。
sync.onJournal((records, { replay }) => applyJournal(records, replay));
sync.onSlots(slots => renderDevices(slots));
sync.onIncoming(item => showIncoming(item));
await sync.init();
sync.journalAppend('hv', { v: [{ u: 'https://example.com/', ti: 'Example', at: Date.now() }] });
await sync.putSlot({ windows: [{ focused: true, tabs: [] }] });
const image = await sync.putBlob(bytes, 'image/webp');
// settings.background.image 引用 { ...image, mime, w, h }，快照由原有流程保存。
const id = sync.sendTo(otherDeviceId, { k: 'url', u: 'https://example.com/', ti: 'Example' });
// 用户打开/确认收到的记录后调用 sync.ack(id)。
await sync.syncNow();
```

新增 `journalAppend/onJournal/journalCursor`、`putSlot/getSlots/onSlots/deleteSlot`、`putBlob/getBlob/deleteBlob`、`sendTo/onIncoming/ack`。日志每 50 条或首条入队 10 秒上传，网络恢复后补传；以服务端 seq 排序，持久化游标避免正常重连/重启重复，gap 发空回调并设置 `status().historyGap`。浏览器默认使用单独的 IndexedDB 队列，Node 默认内存；Node 需要跨进程恢复时应注入持久化 QueueStore（get/set/delete）。禁止把 QueueStore 与 SecretStore 设为同一个实例。队列/槽/迁移档案均保存密文，不含明文网址、标题或图片。

移除设备会先迁移合并后的有效历史/搜索、本机槽、已知及快照引用的背景 blob，再发布转寄并清理旧房间。其他成员重传本机槽并从新房间游标 0 拉取。应用端仍负责 PRD §1 的隐私过滤、授权开关、30/90 天本地保留及历史删除的界面处理。不要上传无痕/内网/敏感查询参数。

向量已加入 slotId HKDF、日志/槽/图片加解密及 AAD；当前单元测试：协议库 48/48、中转 33/33，均通过 TypeScript 检查；Node 本地与 workerd 三设备 500 条记录与轮换均 7/7，活动测试房间残留 0。两种目标共用接口套件均旧协议 8/8、新通道 4/4；workerd 另有 7 组注入时钟、限额及实际存储检查通过。离线槽更新和删除也会持久化重试；回调如果返回 Promise，会等待其成功再提交游标。

PM 已在 PROTOCOL §9 确认：不增加明文 ttlDays；所有日志统一最长 90 天，客户端收件箱只保留 7 天；投递是至少一次，应用按 recordId 幂等。详见下方 v2.2.1。

**shared/protocol/src/sync.ts SHA-256：** `4e1d3869529d2fa214bcfa87e93a1ee62641e46cc7b27b5889dfc1505648b1cd`


## v2.2.1 接力 API 已就绪

READY 时间：2026-10-22 21:21（UTC+08:00）。本轮协议库 54/54、中转 35/35；类型检查、本地与 workerd 共用接口和三设备均通过。PM §9 的两个边界已解决，无待决事项。

日志自动上传：满 50 条，或第一条入队后 10 秒；离线仍持久化密文、稳定 recordId 重试。回调成功后才保存游标：崩溃发生在业务提交后、游标保存前会重交付，属于至少一次。返回 Promise 的回调会被等待；应用要在同一业务事务中记录已处理 recordId 和实际变更。浏览记录继续按 historyEntryId 去重，收件箱、删除、ack 按 recordId 去重。

```ts
sync.onJournal(async (records) => {
  await appDb.transaction(async tx => {
    for (const record of records) {
      if (await tx.hasProcessed(record.id)) continue;
      await tx.applyRecord(record);
      await tx.markProcessed(record.id);
    }
    await tx.deleteInboxOlderThan(Date.now() - 7 * 86400000);
  });
});
// onIncoming 也应按 item.id 幂等持久化；应用自行定时执行上述收件箱清理。
```

不发送明文 ttlDays 或记录类型；snd/ack 与其他日志在中转统一最长 90 天。库不会通知超过 7 天的 snd；应用收件箱本身的 7 天清理由应用执行，密文迁移档案不是收件箱 UI。

WebSocket 在线时停止五分钟兜底轮询，断线仍轮询；journal/slot 通知合并 1 秒。槽内容相同不上传；单设备上传/删除间隔至少 10 秒，期间最新覆盖/删除先持久化再延迟发送，因此 putSlot/deleteSlot 完成不代表此时已经发出网络请求。POST journal 的连续 seq 回执可交付本机记录，发现缺口仍补拉。

为满足稀疏负载 HTTP 上限，slot WS 通知新增可选 env 密文缓存提示（删除为 null）。仅在完整帧不超过 64 KiB 时附带；客户端解密并校验 slotId，老通知或大槽仍 GET /slots。旧客户端忽略附加字段，原字段、路由和限流不变。客户端仍用 getSlots 做初始/重连同步。

日负载（500 次稀疏访问、500 次槽变化、3 台各在线 8h）实测：local SQLite 保守含索引 4,043 行写、workerd 原生 SQL+KV/alarm 3,026 行写；HTTP 均 2,029、HTTP DO 调用均 4,562，含 1,450 WS 入站帧。运行 `cd relay; node --import tsx test/daily-load.ts`。测试时钟与计数端点只存在于本地测试入口，不进入生产。

**shared/protocol/src/sync.ts SHA-256：** `06c6d41a3ad2bceaa15c0ab18eeef6e1012dc9ac9da11e410d7a33da0e4f7dc1`。

生产发布完成：2026-10-22 21:22 +08:00，https://kongjing.inc.re；Deployment ID `958363c3-dfbc-4fc0-b7e8-51210dfae826`。线上仅一轮代理三设备 7/7，实际存储密文检查通过、活动测试房间残留 0。详细证据见 docs/v4-continuity/REPORT-relay.md。

## v2.2.2：加入方关闭竞态修复

READY 时间：2026-10-23 01:05（UTC+08:00）。入口、SecretStore 注入、配对帧与原有 API 不变。配对仍须由两端核对 SAS 并确认。

加入方收到 welcome 后，配对 WebSocket 的 close/error 会排在消息处理之后，不能抢先把尚在解密或持久化的配对判成 NETWORK。`JoinSession.done` 在 welcome 解密与校验、组凭证保存、首次组 WebSocket 实际 open 后成功；首次组连接失败或 30 秒未打开仍会失败。后续快照拉取由组连接的原有同步流程执行，暂时的快照同步错误不再决定配对结果。

邀请方也修复了对称窗口：welcome 发出后关闭配对传输不再打断成员保存、成员广播与首次快照提交；这些步骤本身失败仍拒绝 `InviteSession.done`。取消、welcome 校验失败、真实持久化失败及 welcome 前断开仍正常报错。组凭证已经保存而首次连接失败时保留凭证，由现有重连恢复。

本地中转默认增加精确来源 `https://appassets.androidplatform.net`，与线上一致；`relay/wrangler.example.toml` 同步提供该 EXTRA_ORIGINS，其他未知来源不回显允许头。启动仍为 `cd relay` 后运行 `node local/server.mjs --port 8790 --data .data/dev`。

验证：新增 12 项确定性配对回归（welcome 后立即关闭、两端慢存储、两种确认顺序、首次组连接等待/超时及真实错误等），协议库 **66/66**、中转 **36/36**、类型检查通过；local/workerd 旧接口 8/8、新通道 4/4、三设备 500 条及轮换/密文检查各 7/7；本地快照/离线转寄和慢速同步两套回归各 6/6，活动测试房间残留 0。日负载 HTTP 均 2,029，SQLite 写入 local 4,043、workerd 3,026，与 v2.2.1 相同。

**shared/protocol/src/sync.ts SHA-256：** `a4b838a3962ca9f88fbcb962d6540c5066004806fb1eb4f14b40b9bab4777eb7`。

本轮没有改动 Worker 逻辑或生产配置，**未部署、未访问线上验收接口**；扩展与安卓工程由各自工程师重新构建接入。证据和待 PM 复核的实现选择见 `docs/v4-continuity/REPORT-relay.md` 末尾。


## v2.2.3：MV3 service worker 换密钥迁移修复

READY 时间：2026-10-22T18:04:30.063Z。协议路由、配对帧、数据格式与客户端 API 不变，无需部署线上 Worker。

continuity.migrate 的迁移模块改为顶层静态导入；库内运行时源码没有动态 import()。可见性监听通过 globalThis.document 可选访问，在没有 window/document 的 service worker 中安全跳过，其他宿主行为不变。

新增完整无 DOM VM 回归：动态 import() 被宿主拒绝，实际 KongjingSync.removeDevice 完成快照、保留日志、状态槽及图片重新加密/迁移、旧房间退休，旧密钥不能解密新快照。协议库 67/67、中转 36/36、双方 typecheck、workerd 协议/通道/三设备迁移与密文审计通过。真实扩展后台三场景证据见 docs/v4-continuity/REPORT-web.md 的 2.1.3 小节。

**shared/protocol/src/sync.ts SHA-256：** `f26c3c2f05c798ef7dc485ce85cbc4af8816ee26c04dfbf96c3384b723991ca4`。

本轮没有修改中转实现、没有线上请求或部署。


## v3（EdgeOne + 直连）已就绪

READY 时间：2026-10-24 02:08（UTC+08:00）。协议库 **76/76** 项单测与类型检查通过，Edge 服务 **6/6** 组测试通过；真实浏览器三设备已验证配对、直连、回退、离线补齐、换密钥、仅直连。直连传输与离线补齐达标；长轮询自定义域名直连轮 **3.583 秒**、最新代理复验 **4.584 秒**，超过 3 秒目标，详细证据与平台限制见 docs/v6/REPORT-edge.md。

- 源码入口：`shared/protocol/src/index.ts`，新增 `createSync`、`EdgeKongjingSync`、`TransportEdge`、`PeerMesh`。浏览器路径只依赖 WebCrypto 和标准 API，无 Node import、无动态 import。
- 新集成使用 `createSync(options)`，默认 EdgeOne https://sync.example.com；显式 `transport: "cloudflare"` 使用旧版。原 `KongjingSync` 不改变既有行为，工程师须替换构造入口，不能仅替换 v2 relayUrl。
- SecretStore 的 `identity` / `group` 格式沿用 v2；升级无需重新配对。单独注入 IndexedDBQueueStore（不能与 SecretStore 是同一实例），密文缓存、补传队列与 cursor 存在队列库；Node 默认内存队列，重启持久化测试需注入文件实现。
- 已有 Cloudflare 组默认双写最多 7 天，所有成员出现 EdgeOne 即提前结束；`legacyMigration:false` 仅用于全新组或隔离测试。旧版换密钥支持注入相同 GK，避免双写组分裂。
- 高级设置注入 `directOnly`、`turn:[{urls,username,credential}]`，或运行时 `setDirectOnly(true)`。仅直连时清除自己服务器对象，并停止 Cloudflare 双写；其他设备也应开启，才能保证整组没有暂存。离线设备必须等双方同时在线。
- 仅直连换密钥时，旧纪元凭证及加密转寄保存在发起设备的 SecretStore `edge.rotationBridges`，保留 7 天；旧房间只传信令。离线成员与发起设备再次同时在线后经 DataChannel 接收 ECDH 包装的新密钥，不上传 state / h / ev。此路径已用真实 Chrome 三设备单独回归；发起设备丢失或 7 天后才回来的旧纪元成员需要重新配对。
- `status().transport` 与 `Device.transport` 为 `direct | relay | offline`：界面显示「直连 / 中转 / 离线」及设备标签。
- 桌面 MV3 **必须**在 offscreen document 中实例化 v3 客户端 / PeerMesh（`chrome.offscreen`，manifest `offscreen` 权限，reason `WEB_RTC`）。Service worker 通过 runtime 消息委托；全扩展只开一个实例。现有 SecretStore/QueueStore 由 offscreen 直接访问或消息代理，CryptoKey 用 structured clone，不能 JSON 序列化。安卓在 WebView 页面实例化，默认允许 appassets 来源。
- `loadLocal/saveMerged/merge` 继续由应用注入；通知 `notifyLocalChange()`。`journalAppend/onJournal` 是至少一次交付，应用按 recordId 幂等；日期分桶和事件独立密文保存，`putSlot/getSlots`、`putBlob/getBlob`、`sendTo/onIncoming/ack` 保留 API。监听器应在 init 前注册以接收恢复重放。
- `leave()` 发出加密离组事件，剩余成员中 deviceId 最小的设备在 5 秒后换密钥。原有 Cloudflare 传输与 v2 回归全部保留。
- `onJournal` / `onIncoming` 返回 Promise 时会等待成功；失败不提交已交付标记或 watch 游标，P2P 原始密文先持久化并定时重试。崩溃窗口允许重交付，应用仍须按 recordId 幂等。换密钥先创建新房间，遇到限流/网络失败时旧组凭证与同步继续可用，不提前发布转寄。

```ts
import { createSync, IndexedDBQueueStore } from "@kongjing/protocol";
const sync = createSync({
  secrets, queueStore: new IndexedDBQueueStore("kongjing-edge"),
  loadLocal, saveMerged, merge, powWorkerUrl,
  // relayUrl 默认 https://sync.example.com；仅直连默认 false
});
sync.on("status", state => renderStatus(state.transport, state.devices));
sync.onJournal((records, { replay }) => applyByRecordId(records));
await sync.init(); // 从现有 group 恢复；无组时沿用 createGroup/invite/join
// node edge/scripts/dev.mjs --port 8791 --data edge/.data
```

SHA-256：
- `src/sync.ts`：`8dad83d9c25761bf704a50b13c199e3621a5d78038fc3750a09019ed9e55dcfd`（旧传输兼容，增加迁移换密钥参数并修正浏览器 fetch 调用绑定）
- `src/sync-edge.ts`：`34f442d73c15d132648b5d9ea3765657c1fb8daca028602d2086ffa2b17020f6`（v3 实现）
- `src/edge-bridge.ts`：`ffd9fb5f0510e3fec71f07326424f3665578bfe3021b622d5d2e03684829839a`（仅直连的离线换密钥桥）

待 PM 复核：Blob 无原子条件写；slot HMAC 的密钥由组内共享，不能防恶意已配对成员冒用。上线域名可用，协议工程就绪；产品扩展和安卓的集成、重构建未在本轮修改。

## v3.1 自适应轮询

READY 时间：2026-10-24 02:57（UTC+08:00）。依据 PROTOCOL-v3-edgeone.md §9。协议库 **82/82**、类型检查通过；Edge 路由 **8/8**。线上仅一组设备完成直连/代理两段：直连数据 159/170ms，断连回退 1403/1278ms，离线补齐 3218/2142ms，均达到本轮目标。完整证据、容量假设及附加测试夹具的问题见 docs/v6/REPORT-edge.md 的 v3.1 小节。

新增 `EdgeKongjingSync.setForeground(boolean): void`，可以在 init 前调用。默认前台；`clientPlatform: "android" | "desktop"` 可显式指定，未指定时从 Android UA / 已保存的平台名识别。桌面 offscreen document 本身的 visibilityState 不能代表新标签页是否可见，须由可见页面 / service worker 转发实际 UI 状态。

```ts
const sync = createSync({
  transport: "edge", // 默认也是 edge；返回类型可直接调用 setForeground
  clientPlatform: "android", // 桌面 offscreen 使用 "desktop"
  secrets, queueStore, loadLocal, saveMerged, merge, powWorkerUrl,
});
sync.setForeground(document.visibilityState === "visible");
document.addEventListener("visibilitychange", () => {
  sync.setForeground(document.visibilityState === "visible");
});
await sync.init();
// 安卓原生生命周期也应转发 onResume/onPause，避免只依赖 WebView visibilitychange。
// 桌面 offscreen：接收 runtime 消息后 sync.setForeground(message.visible)。
```

| 状态 | 检查 / presence |
|---|---|
| 所有在线成员已直连 | 无实时 watch；5 分钟一次 list 补齐，120 秒 presence |
| 有在线成员未直连，前台 | 25 秒 watch，服务端每 1 秒检查，超时立即续发；60 秒 presence |
| 有在线成员未直连，后台 | 60 秒普通检查 / presence |
| 只有自己在线 | 前台 20 秒 / 后台 90 秒普通检查；60 秒 presence |
| 安卓隐藏且无待发数据 | 停止检查和 presence；恢复前台立即检查、发送 presence、补传 |

新配对成员与信令会唤醒状态机；DataChannel 断开 / disconnected 立即切换回退。通知写入只推送和补传，不再每次自动全量 list；显式 syncNow 仍强制补齐。仅直连的待发数据在全部成员连接并发送后结束待发状态，缓存继续保留供重连重放；旧纪元转寄桥也停止常驻长轮询并遵守安卓可见性。旧 Cloudflare 传输与密码学构造不变。瞬时切换前已经发出的服务器 watch 可能继续执行至原 25 秒期限，新状态不再续发。

后台读失败不会加快普通检查频率；隐藏 / 状态切换的取消信号同时停止队列中后续对象 GET，未完成读取的 cursor 不提交，恢复后继续补齐。

发现上限需注意：孤机前台在下一次 20 秒检查发现新设备；已有全直连网状组按规范只做 5 分钟补齐，因此外部恢复的旧成员在既有成员一侧最坏等到下一次补齐，没有偷偷增加轮询来承诺所有情况下 20 秒发现。新配对可经已有 DC 传播成员变更。仅直连离线成员仍须等待双方同时在线。

源码 SHA-256：

- `src/sync-edge.ts`：`4b8f6a1b2f310646d0d6d741fd7f084f68a9aafe09911a77b0579ee10151a6a3`
- `src/adaptive-poll.ts`：`de684388cb86349b124151ec4fd13a28108b883ae3c71329454e369da245643d`
- `src/peer-mesh.ts`：`4cfcf576392215f7bf51b67af3cfb4758436236bf0801e86d7c1a1f656f3646c`
- `src/transport-edge.ts`：`d2f04dd18e90f20a9ab02603507db183444c204f97e84f72cf2e1c86920b1103`
- `src/transport.ts`：`a4b22be826158daa82c41e51c0cc07ff210825f013ee96f08e108a13a0a5f5a1`
- `src/edge-bridge.ts`：`b73a0c5a0337f662294f20c440c2e857b9135c99dff06134133deea93b14d37c`
- `src/sync.ts`：`8dad83d9c25761bf704a50b13c199e3621a5d78038fc3750a09019ed9e55dcfd`（旧传输未改）

## v3.3：直连存活检测与原子性

READY 时间：**2026-10-24 04:08 +08:00**。依据 PROTOCOL §9.6–§9.8；优先采用 PM 最后的 `withLocalLock` 接口决定。SDK 代码、类型检查与本地测试已就绪；**线上性能验收仍为 PARTIAL**，具体限制见下。没有修改 extension、android 或已发布安装包，需要应用工程师集成本节源码。

### 应用锁接入（Edge 与旧 Cloudflare 共用）

`createSync` 新增可选泛型 `withLocalLock<T>(task: () => Promise<T>): Promise<T>`。所有远端快照合并（含 P2P、Edge HTTP、旧 Cloudflare、首次同步、换密钥和离线补齐）仍经 `mergeChain` 排序，再在一次应用锁内重新读本地、merge、落盘。不能把分别加锁的 load/save 当成一次事务。Edge 兼容双写的旧客户端也共享主客户端的锁/降级队列。

```ts
import {createSync} from '@kongjing/protocol';

// 所有扩展 origin 上下文使用同名 Web Lock；App 可注入等价锁。
const withAppDataLock = <T>(task: () => Promise<T>): Promise<T> =>
  navigator.locks.request('kongjing:app-data', task);

const sync = createSync({
  relayUrl: 'https://sync.example.com',
  secrets, queueStore,
  withLocalLock: withAppDataLock,
  loadLocal: rawLoadAppData,
  saveMerged: rawSaveAppData,
  merge: mergeAppData,
});
await sync.init();

// 每次应用写入也取相同的锁，锁内重新读最新值；不要提交旧缓存快照。
await withAppDataLock(async () => {
  const latest = await rawLoadAppData();
  await rawSaveAppData(applyLocalDelta(latest, delta));
});
sync.notifyLocalChange(); // 释放锁后再通知；锁内不要 await syncNow()。
```

`rawLoadAppData` / `rawSaveAppData` **不再取应用锁，也不能调用 `runExclusive`**；库已经持锁才调用它们，save 必须等待实际存储成功，失败向上传播。其他应用写入、跨上下文消息处理也必须遵守同一约定。内容脚本不能用网页 origin 的 Web Lock 替代扩展 origin 的锁，应交给扩展后台提交。协议锁不能修复应用自己用旧缓存覆盖新值、吞存储异常的问题。

没有 `withLocalLock` 时，库使用自己的串行队列降级；保留辅助 `sync.runExclusive(task)`，单上下文应用可把本地读改写放入它，释放后再 `notifyLocalChange()`。**该辅助队列不可重入**，不要嵌套调用，也不要在 raw 回调内部调用；它不能互斥新标签页 / popup / offscreen 等不同上下文，电脑端应提供应用锁。此约定依 §9.8 替代原 §9.7 对辅助接口的要求。

### 存活检测与可见性

- 前台心跳 **2 秒**，无认证帧 **5 秒**判断开；桌面后台 **15 秒 / 35 秒**。空心跳与业务帧使用同一 AES-GCM 信封及 P2P AAD，走 DataChannel，不产生 HTTP/Blob 操作；业务发送可抵扣心跳。
- DC close / ICE disconnected、failed 立即回退并做一次补齐，前台使用现有 1 秒 watch，后台每 60 秒检查，同时指数退避重建。DC open 不代表恢复，收到通过认证的帧才回全直连档。应用保存队列与认证接收队列分离，慢保存不阻塞心跳。
- 继续调用 `sync.setForeground(visible)`；安卓实例设置 `clientPlatform: 'android'`，不可见时停止心跳/检查，重新可见立即检查 lastSeen，过期立即回退。桌面 offscreen 必须传真实 UI 可见性，不能用隐藏 offscreen 自身的 visibilityState 代替。
- `PeerMesh.setTestDropFrames(true)` 仅供测试模拟单端冻结：停止该端 DC 收发及 watchdog，不主动关闭 PC；不要在产品流程调用。

### 脱敏诊断

```ts
sync.setForeground(true);
const recent = sync.diagnostics(); // Edge 最近 100 次请求；返回深拷贝
```

记录 `type`（put/get/list/watch/signal）、`startedAt`（epoch ms）、`durationMs`（含响应体读取）、HTTP `status`、数值 `serverTiming`、**请求开始时**的 `pollMode`、`foreground`、匿名 `peers` 状态。网络失败/未收到 HTTP 响应为 status 0；每次重试单独记录。没有房间/slot/deviceId、URL、token、明密文或原始错误文本。只接收 total/blob_read/blob_write/blob_list 的数值 Server-Timing，避免自建服务通过 desc 注入标识；旧纪元桥请求也进入同一缓冲。该诊断接口针对 Edge 传输，不把旧 Cloudflare 请求虚构成 Edge 时长。

Edge 已发布 **3.0.1**，最终 Deployment **`dpzr51q3y7qk`**。`/v2/health` 直连/代理均 200，返回数值 Server-Timing；存储计时按请求隔离。API、安全上限和限流未变，未使用 KV。

### 验证结果与边界

协议库 **100/100（11 文件）**、typecheck PASS；Edge **9/9**。确定性回归覆盖两种传输各自的应用锁/降级队列并发写入、5s/35s 存活、安卓隐藏恢复、错误认证不得复活、慢应用不阻塞心跳、100 条诊断脱敏、慢 ICE GET 不阻塞已下载快照。

两个独立桌面 Chrome 进程/profile，真实 RTCPeerConnection，本机 host candidate（ICE=[]）；线上 HTTP 经代理至部署的 EdgeOne，不能据此宣称跨 NAT / 安卓系统休眠已经验证。每项 5 次：

| 目标 | 无声断连：中位 / 最大 | 正常 close：中位 / 最大 | 空闲 60s HTTP：中位 / 最大 |
|---|---:|---:|---:|
| 最终源码本地 | **4789 / 4802ms，5/5** | **1030 / 1048ms，5/5** | 初轮 **6 / 6，5/5**，未重复空闲轮 |
| 线上唯一轮 | **5706 / 6115ms，5/5** | **2660 / 3603ms，3/5** | **5 / 9，4/5** |

线上 close 的 **3098ms、3603ms** 超标；检测均 2ms，最慢一次状态字节约 2722ms 到达，却被同批慢 ICE 404 等到约 3601ms。已去掉整批 Promise.all 交付屏障，保留最多 6 并发、优先轮换/事件及状态、完整游标提交与错误传播；新回归和最终本地 10 次通过。**线上 Chrome 装载 SDK 在此修复之前，遵守只跑一轮，没有用新源码补跑线上；最终修复的线上 ≤3 秒仍待 PM 复核。**

线上空闲第 1 窗口为 9 次，含重连残留的 2 次 ICE GET + 2 次 DELETE，夹具只等待 2.2 秒，不能称纯稳态；保留 FAIL。后 4 窗口为 5、5、5、7 次，无 watch，含原有 presence 和 5 分钟修复。线上测试对象删除 12 个、残留 0，本地测试残留 0。

`edge/scripts/load.mjs --v33`：每日 HTTP 前台 **5252+100预算=5352**、后台 **3812+100=3912**，Blob 次数均与 v3.2 相同。88 个本轮非 watch 请求完整网络耗时平均 960ms，以至少 1000ms 作时长预算；内存≤512 MiB 时约支持 **6 / 8 位**前台/后台模型用户，心跳 HTTP=0。实际计费内存/GB-s、成熟房间 metadata 成本与长期回退限制见报告，不能视为免费容量保证。

最终源码 SHA-256：

| `src/` 文件 | SHA-256 |
|---|---|
| `sync-edge.ts` | `10560ba447a735119b7870e96448a87d729beb587376d1541a89b698a5ff111c` |
| `sync.ts` | `74218965caba753240f88e347ab1388515f8be6a2279cae256765a2bb4dd521a` |
| `peer-mesh.ts` | `bfd8abbd018e719c8df97ef92d0917460862ec3ec7a8b8ed5025cb12a52ae5e2` |
| `local-access.ts` | `eca99b5170770e7637585b1a5a8c6b0672c016ebc8a130cbd0f6fed6c9986721` |
| `transport-edge.ts` | `a4c4c3f00e4afe584fa0a6a24a9a36272518d5958e327b77a136e7bfceb9c616` |
| `diagnostics.ts` | `254963bbac84c5737b2943543ee962f09aa0ca23ba239ac3e76f39882dd0ca4b` |
| `types.ts` | `83430c70c3d613de9d7b0e4bca7c1aa9ec42853c47f5f87c9c0845e184e6bcce` |
| `edge-bridge.ts` | `c1686a31ab2fee7c5a42ea413bbdcbc0c6be89d023fecc565c87ecf88ad7e3f6` |

完整证据：`edge/artifacts/v33-summary.json`、`v33-{local,local-final,online}.json`、`health-v33.json`、`load-v33*.json`；报告第 12 节给出原始样本与最慢请求诊断。

## 服务端 3.0.2：按配对组限流

PM 已验收 v3.3 及安卓 1.3.0 最终包；上节保留当时的原始测量。本次为 Edge 服务端限流与两站下载发布，**客户端不需要修改**，SDK 源码及上节 SHA-256 均不变。

- 通过房间令牌认证后，`watch` 每房间 **240次/分钟**；对象写入（PUT、DELETE，含信令）每房间独立 **240次/分钟**。不同房间不再共享原 IP 120 次 watch/write 配额，同一房间换 IP 也不会获得新配额。
- 全部非 health/OPTIONS 请求另受单 IP **600次/分钟**总兜底。建组、配对、PoW、guest、令牌错误等未认证请求保留原 **300次/分钟** IP 闸门及各自细分规则；guest 仍为10次/10分钟、错误房间双计数、超限封禁30分钟。429 继续返回 Retry-After 头和 retryAfter 字段。
- 所有限流仍为 Edge 函数实例内存计数，与原架构一致，不使用 KV/Blob 计数。鉴权前先预占 IP 额度，成功才退还未认证配额，防止并发猜令牌穿过异步检查；房间配额只在令牌验证后分配。拒绝请求不做业务读写/列表/清理或租约写入。
- 既有协议仅在 Blob meta 保存 tokenHash，冷请求无法在完全零存储读取的前提下验证已有令牌。因此保留**最多一次固定 meta GET**作为鉴权步骤，之前已有纯内存 IP 闸门；此必要例外及存储计数证据写入报告「待 PM 复核」。没有改令牌、已有房间、加密或客户端契约。

验证：Edge **13/13**；同 IP 三房间合计600次有效请求无429，第601次在读取存储前被拒；单房间240边界与Retry-After、跨IP不绕过、错误令牌与并发猜测受限全部通过。真实Chrome三个独立设备存储、同回环IP、禁用P2P回退：18次变化全部送达，170次请求、**0次429**，中位867ms/最大1165ms，测试对象残留0。证据 `edge/artifacts/fallback-302-local.json`；部署与两站下载结果见 `docs/v6/REPORT-edge.md` 第13节。

部署 **`dp6qech86a27`**，CLI成功回执时间 **2026-10-24 05:15:02 +08:00**；05:15:52直连/代理health均200、version3.0.2，最终主站下载再次验证通过。主站与旧站均已发布APK1.3.0（versionCode6）/扩展2.3.1，HEAD、302稳定地址、latest.json和下载字节哈希均通过。此次更新没有修改SDK源码或既有配对组。

下载的 APK 1.2.0 / 扩展 2.2.0 按 PM 指定哈希原样发布，没有重构建。接入上述可见性调用与新版源码仍由应用工程师完成。组内成员互信及 Blob 无原子条件写已由 PM §9 接受，不再作为本轮待决项。

## v3.2：全直连设备发现已就绪

READY 时间：**2026-10-24 03:32:09 +08:00**。依据权威规范 §9.5；本节替代 v3.1 中“全直连最坏等 5 分钟发现”的说明。服务端接口、密码学、Cloudflare 旧传输不变；本轮没有部署、线上写入或重新打包应用。

- 全直连组：前台 **30 秒**、桌面后台 **60 秒**一次 room list，同时检查本机信令收件箱和设备 presence。完整补齐仍每 **300 秒**进行，与发现共用本次 list。120 秒 presence 心跳不变。
- 已连通成员由活跃 DC / 心跳证明在线，普通发现轮无需重复 GET 它们的 presence 正文；未连通成员的新 presence 和本机信令立即读取。发现新上线成员时立即连接，并复用本次列表补齐。普通发现不提交未读取业务对象的 cursor，避免回退 / 后续补齐漏数据。
- 原 offer 过期时，低 slot 一侧重发已收集候选的 SDP；保留原发起规则，不重建健康连接。后台发现后可有**最多 10 秒**的握手跟进，成功直连立即停止，到期恢复 60 秒检查；这是握手交换，不增加空闲轮询。安卓不可见且无待发数据时照常停止，握手跟进不能绕过暂停。
- 1 秒前台回退 watch、20/90 秒孤机检查、离线补传与 `setForeground(boolean)` 接入方式均沿用 v3.1。检查周期按读取开始时间计算，不把本次网络耗时再累加到下个间隔；失败仍遵守 Retry-After。

```ts
const sync = createSync({ transport: 'edge', clientPlatform: 'desktop',
  secrets, queueStore, loadLocal, saveMerged, merge, powWorkerUrl });
// 桌面 offscreen 接收实际 UI 可见性；安卓传 'android' 并转发原生生命周期。
sync.setForeground(isForeground);
await sync.init();
// 后续可见性变化：sync.setForeground(visible)。无需新增发现 API。
```

协议库 **92/92**、类型检查、Edge **8/8** 通过。真实 Chrome + Edge 本地 FileStorage，A/B 已直连、已配对的 C 上线：前台 **29.179 秒**、后台 **58.204 秒**全网直连；删除原 offer 模拟过期时分别 **29.602 / 59.107 秒**。四种场景均补齐成功并可双向同步，验收阶段未手动调用接收端 sync，测试对象全部清理。详见 `edge/artifacts/discovery-v32*-local.json`。

额度按原模型（3 设备、各 8h、500 次历史追加/天、90 天保留）重算：全前台每天 **5252 HTTP**，含 100 次启动/CORS/握手预算为 **5352**；全后台为 **3812 / 3912**。按历史 1137ms 平均完整网络耗时作预算、假设 512 MiB，约支持 **5 / 7 位**用户；128/256 MiB 为 **6 / 8 位**。这是直连稳态、函数内存和时长假设下的估算，成熟房间 metadata 操作成本及长期全回退仍须按报告复核。

源码 SHA-256：

- `src/sync-edge.ts`：`c810692ce8c769b5ad486c25ea9449971e473d564cbacdf7ea4d05403739b5c2`
- `src/adaptive-poll.ts`：`78f15a452f7e71f37f30fb8dd5a21a76f8e362576d101c08e08bca56c2bd35ff`
- `src/peer-mesh.ts`：`894df3c722dcf71e4e72a813c5c3eefb768a217db6f18283b695c943191df267`
- `src/sync.ts`：`8dad83d9c25761bf704a50b13c199e3621a5d78038fc3750a09019ed9e55dcfd`（旧传输未改）


## v3.3.1：欢迎后的加入重试与等待加入

READY：**2026-10-24 06:57:37 +08:00**。package.json / package-lock.json 版本为 **3.3.1**；入口仍为 `shared/protocol/src/index.ts`，无需构建，无新增依赖。

通过 SAS 并验证 welcome 后，Edge 首次补齐、state / 排队写入 / presence 遇到网络故障、HTTP 5xx 或 429，会保留本次加入并退避重试。首个暂态错误起至少120秒，间隔1 / 2 / 4 / 8 / 15秒，之后每15秒；Retry-After支持秒数和HTTP日期，采用响应头与正文中较晚的值，长于窗口也不会提前请求。认证、解密、应用合并、本地持久化的确定性错误不盲目重试。取消/dispose可终止等待。

**需要应用接入以下UI，不能只升级库就宣称提示已改变**（此轮未改 extension/、android/）：

- `SyncStatus.joinPhase === 'completing'`、paired=false：保持「**正在完成加入…**」，不要因暂态错误退出。完成首次同步后joinPhase清空、paired=true、JoinSession.done成功；最终失败为joinPhase='failed'，done拒绝。
- `Device.joining === true`、online=false：优先以 **var(--text-3)** 显示「**等待加入**」，不显示离线或其他连接徽标。邀请方收到加入设备首条通过认证、解密并完成应用合并的state后，joining=false，回到既有online/transport规则；presence或DC建立本身不提前清除。标记独立持久化，邀请方重启后仍有效，旧成员不追溯改成等待。

```ts
const sync = createSync({ transport: 'edge', secrets, queueStore,
  loadLocal, saveMerged, merge, withLocalLock: withAppDataLock });
sync.on('status', status => {
  if (status.joinPhase === 'completing') showJoinProgress('正在完成加入…');
  if (status.joinPhase === 'failed') showJoinFailure(status.error);
  for (const device of status.devices) {
    if (device.joining) showDeviceLabel(device, '等待加入', 'var(--text-3)');
    else showNormalDeviceLabel(device);
  }
});
const join = await sync.join(code, name, platform);
// 原有 SAS 校验与 confirm() 不变。
await join.done;
// 仅在最终失败后，由重试按钮调用并等待这个新 Promise：
await join.retry!(); // Edge 支持；不要再等待已拒绝的旧 done。
// 同一实例也可 await sync.retryJoin()；有已落盘待完成凭据时，重启 init() 自动恢复。
```

失败保留同一份已经welcome验证的组凭据，不重新绕过SAS或重复增加成员。`edge.joinPending` / `edge.pendingJoins`只写SecretStore，不修改既有group结构、成员或服务器线协议。`ProtocolError.status`新增可选HTTP状态用于重试分类；旧Cloudflare源码、旧纪元桥、withLocalLock/raw load/save约定保持不变。

最终协议库 **111/111（12文件）**、typecheck PASS；Edge **17/17**。新增覆盖首次state=500 / presence=500 / 断网后自动成功，双方成员一致；等待标记跨重启；最终失败后手动与重启恢复；故障前90秒慢准备不消耗两分钟重试窗口；180秒Retry-After、取消和不可重试错误。第1步发布的APK1.3.2 / ZIP2.3.3仍是PM给定原字节，**并未编入随后完成的本轮SDK修复**，应用需接入后再构建。第2步没有再次部署Edge，线上后端仍3.0.2。

| 源文件 | SHA-256 |
|---|---|
| `shared/protocol/src/sync-edge.ts` | `d96beae90c64080fbe8d80a9232c109693d593dbf6b777ce979a87742f28a22d` |
| `shared/protocol/src/join-retry.ts` | `6cfc2d7c7b2a25d2425c194fc992a2f3230a6116cb4188c3c9aa9410dcfa3915` |
| `shared/protocol/src/transport-edge.ts` | `63e12859241e3e80938b71c02dccb4488000fd3d8839666b27982fa28b5f7de8` |
| `shared/protocol/src/types.ts` | `7d15812cc0537fc76ae7075d3ea8526017e170ca893d68c9923f6a30dee7217d` |
| `shared/protocol/src/sync.ts` | `74218965caba753240f88e347ab1388515f8be6a2279cae256765a2bb4dd521a` |
| `edge/lib/storage.mjs` | `b7590c11d347338e0e87c4eb4405871ef15836060506a18559677a669bc02fd1` |
