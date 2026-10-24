# 自行部署空境同步服务

默认公共同步地址是 **https://kongjing.inc.re/**，运行在 Cloudflare。使用默认服务无需部署。源码与发布版本：<https://github.com/mumuhaha487/kongjin>。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fmumuhaha487%2Fkongjin)
[![Deploy with EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/pages/new?repository-url=https%3A%2F%2Fgithub.com%2Fmumuhaha487%2Fkongjin&build-command=npm%20run%20build%3Aedgeone&install-command=npm%20install&output-directory=edge%2Fpublic&env=KONGJING_POW_SECRET)

按钮进入平台官方创建向导，并部署到你自己的账号。使用仓库根目录和默认分支；无需填写作者的账号、项目或域名。平台是否需要付费、开通存储或验证账号，以自己的控制台提示为准。

## 选择平台

| 选择 | 运行与持久化 | 客户端选择 |
| --- | --- | --- |
| Cloudflare（默认） | Workers、SQLite Durable Objects、R2；静态官网由 Workers Static Assets 提供 | Cloudflare |
| EdgeOne Makers（自建可选） | Node.js Cloud Functions、Makers Blob；静态官网由 Makers 托管 | EdgeOne |

中国大陆用户可将 EdgeOne Makers 和自己的已备案域名组合，作为改善延迟、可达性与连接可靠性的选择。加速地区、函数地区及域名备案要求以平台当前规则为准；实际表现取决于运营商、地区和配置，需要在自己的网络中验证。

两种后端的存储与接口不同，不能通过仅更换域名混用。电脑商店扩展使用后台 Service Worker 的 HTTP/WebSocket 同步；点对点 WebRTC 仅用于支持它的安卓或非商店版本。

## Cloudflare 一键部署

1. 点击 Deploy to Cloudflare，登录自己的账号并按提示创建仓库副本。
2. 保持项目根目录为仓库根目录，使用根目录 `wrangler.jsonc`。部署命令为 `npm run deploy:cloudflare`。
3. 向导读取 Wrangler 配置，自动创建并绑定 R2 和 Durable Objects。保留 `BUCKET`、`GROUPS`、`PAIRS`、`GUARDS` 绑定名及 SQLite migration；可以按向导设置自己账号下的资源名称。
4. 向导会根据根目录 `.dev.vars.example` 提示所需机密。分别为 `POW_SECRET` 和 `IP_HASH_SALT` 生成独立的至少 32 字节安全随机值，在平台的机密输入框填写。
5. 部署完成后取得自己的 HTTPS Worker 地址；如需自定义域名，在自己的 Cloudflare 控制台绑定。访问 `/v1/health` 检查服务，再按下文连接客户端。

官方说明：[Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。此入口支持 R2 与 Durable Objects 的自动配置，并从 `.dev.vars.example` 或 `.env.example` 发现机密字段。占位示例不是可用的生产机密。

## Cloudflare 手动部署

安装 Node.js 22 或更高版本，然后在自己的目录中运行：

```sh
git clone https://github.com/mumuhaha487/kongjin.git
cd kongjin
npm install
```

先在终端通过环境变量提供 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。令牌需要所选账号的 Workers 脚本及 R2 编辑权限；不要把值提交到仓库。部署脚本会创建缺失的 R2 桶和运行时机密，已有机密保持原值。

检查根目录 `wrangler.jsonc` 中的资源名称。在自己账号内准备 `BUCKET` 绑定所指向的 R2 桶；若 Wrangler 提供创建资源的提示，可按提示完成。Durable Objects 由配置中的 migration 创建。不要复制他人的账号 ID、路由或资源 ID。

```sh
npm run deploy:cloudflare
```

首次部署脚本自动生成独立的随机值并通过标准输入写入缺失的机密。若需手动管理，可使用 `npx wrangler secret put POW_SECRET --config wrangler.jsonc` 与 `IP_HASH_SALT` 同名命令。首次配置完成前不能处理业务请求。机密只应进入运行时机密存储；不要写入源码、公开配置、静态文件、构建产物或部署按钮 URL。已有部署的机密无需在每次更新时重新生成。

自己的开发环境若需要本地机密，按示例创建被 Git 忽略的 `.dev.vars`；不要提交该文件。可在当前终端使用官方支持的环境变量认证，但不要把凭据写入仓库。

## EdgeOne Makers 一键部署

1. 点击 Deploy to EdgeOne Makers，登录自己的账号并导入仓库默认分支。
2. 使用仓库根目录，安装命令 `npm install`，构建命令 **`npm run build:edgeone`**，静态输出目录 **`edge/public`**。根目录 `edgeone.json` 和 `cloud-functions/` 是该平台的部署入口；不要把构建根目录改为 `edge/`。
3. 按引导在项目中设置 **`KONGJING_POW_SECRET`**，使用至少 32 字节安全随机值。通过平台的受保护环境变量/运行时设置提供，只供 Cloud Functions 使用；不要写入客户端环境变量或构建产物。
4. Cloud Functions 使用 `@edgeone/pages-blob` 访问项目自己的 Blob namespace。平台会在首次使用 namespace 时创建它；不需要 KV、作者的项目 ID 或公开访问令牌。保持函数入口配置的 namespace 名称一致。
5. 按自己的用户地区选择支持的部署与加速地区。绑定自己的 HTTPS 域名；若使用中国大陆加速，先按平台要求完成域名备案和验证。
6. 部署后检查 `/v2/health`，再用两个客户端验证配对、修改书签和网络恢复后的同步。健康检查成功不代表所有权限和业务机密均已验证。

官方文档：[部署按钮与参数](https://pages.edgeone.ai/document/deploy-button)、[导入 Git 仓库](https://pages.edgeone.ai/document/importing-a-git-repository)、[Cloud Functions](https://pages.edgeone.ai/document/cloud-functions)、[Blob Storage](https://pages.edgeone.ai/document/blob-storage)。按钮参数只包含变量名称，不包含机密值。

手动导入时，在 Makers 控制台创建项目并选择相同仓库、根目录、命令和输出目录。在本机可先运行 `npm install` 和 `npm run build:edgeone` 检查构建，再通过官方控制台部署。普通 Makers 函数内的 Blob SDK 使用项目运行时身份，不需要把账号 API Token 带进函数包。

## 客户端、平台和 CORS

1. 在空境的同步设置选择 **Cloudflare** 或 **EdgeOne**，再填写该平台部署得到的完整 HTTPS origin（协议、域名及可选端口，不带 API 路径）。所有配对设备使用相同的平台与地址。
2. 电脑扩展会在你确认自建地址时请求该 **精确来源** 的可选访问权限。声明中支持其他 HTTPS 地址与本机开发地址，不会自动授予所有网站权限。拒绝或撤销授权后，该地址不能连接。
3. 浏览器访问权限与服务端 CORS 是两个独立条件。扩展请求的来源格式为 `chrome-extension://<扩展 ID>`；实际 ID 以自己的商店安装或测试安装显示为准。公开模板支持合法的 Chrome 扩展来源；若收紧 CORS 白名单，应使用自己实际分发的 ID。
4. Cloudflare 可在运行时配置 `EXTRA_ORIGINS`，Makers 可在运行时配置 `KONGJING_CORS_ORIGINS`，用逗号分隔额外的完整来源。保留安卓主页来源 `https://appassets.androidplatform.net`；不要用任意网站通配符代替精确来源。CORS 不是身份认证，服务仍依赖配对凭证与防滥用限制。
5. 更换后端或地址时，先导出重要数据，再离开原配对组并重新配对。本机书签保留；原平台的数据不会自动迁移到新平台。

本地开发地址只供自己的设备调试。公开自建服务使用 HTTPS；Cloudflare 的 WebSocket 路径也要由代理正确转发。

## 更新与故障恢复

升级时保留自己的资源绑定、机密和域名，使用同一账号部署仓库的新版本。不要以重新生成密钥或删除存储作为普通更新步骤。

本地书签与本地搜索不依赖同步服务，离线仍可使用。网络恢复后客户端继续同步；外部网页搜索和新图标下载仍需要网络。若连接失败，依次检查平台选择、HTTPS 地址、扩展来源授权、CORS 和运行时机密，再查看自己的平台日志。不要把日志中的凭据或配对数据公开提交到 issue。
