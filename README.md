# 空境 · Kongjing

安静的新标签页、本地书签与端到端加密的多设备同步，提供 Chrome 商店扩展和 Android 浏览器。默认公共同步服务为 **[kongjing.inc.re](https://kongjing.inc.re/)**，由 Cloudflare 提供基础设施；你也可以部署到自己的 Cloudflare 或 EdgeOne Makers 账号。

[GitHub](https://github.com/mumuhaha487/kongjin) · [最新发布](https://github.com/mumuhaha487/kongjin/releases/latest) · [隐私政策](https://kongjing.inc.re/privacy) · [部署指南](docs/DEPLOYMENT.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fmumuhaha487%2Fkongjin)
[![Deploy with EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/pages/new?repository-url=https%3A%2F%2Fgithub.com%2Fmumuhaha487%2Fkongjin&build-command=npm%20run%20build%3Aedgeone&install-command=npm%20install&output-directory=edge%2Fpublic&env=KONGJING_POW_SECRET)

## 下载与版本

| 组件 | 当前版本 | 获取方式 |
| --- | --- | --- |
| Chrome Web Store 上传包 | 2.1.0 | [kongjing.zip](https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing.zip) |
| 同一商店构建的 CRX | 2.1.0 | [kongjing.crx](https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing.crx) |
| Android APK | 1.4.1（versionCode 11） | [官网下载](https://kongjing.inc.re/download/android) |
| 完整公开源码 | main 发布提交 | [source.zip](https://github.com/mumuhaha487/kongjin/releases/latest/download/source.zip) |
| 主界面 / Android 内置主页源码 | 2.4.0 | `extension/` |

电脑 ZIP 是向 Chrome Web Store 提交的发布包，不代表已经通过商店审核。用户应从审核通过后的正式商店页面安装，具体状态见最新发布说明。商店包与 Android 主页使用各自的版本号。详见[商店发布说明](docs/STORE.md)和[版本发布流程](docs/RELEASE.md)。

## 使用与同步

本机保存书签、设置和搜索记录。离线时，本地书签与本地搜索继续可用；网络恢复后同步继续。网页搜索、打开外部网站和获取新图标需要网络。

电脑商店包支持可选空境栏：在设置中主动开启并授权后，悬停或点击网页边缘展开书签，鼠标移出栏及菜单后自动收回。默认关闭，不申请浏览记录权限。

配对由用户主动开启。同步内容在设备上加密，服务端保存或转发密文，无法读取书签内容。电脑商店版使用后台 Service Worker，通过 HTTP/WebSocket 同步；安卓和非商店运行环境可在支持时使用 WebRTC 直连。网络请求使用有界超时和退避；只有适合重试的幂等操作才自动重试，本机持久化数据不会因暂时断网清空。

自建时，在同步设置中选择 **Cloudflare** 或 **EdgeOne** 并填写自己的 HTTPS 服务地址，所有设备使用相同平台和地址。电脑扩展只在用户确认地址时请求该精确来源的可选主机权限。更换后端需要重新配对。中国大陆用户可考虑 EdgeOne Makers 与自己的已备案域名，作为改善延迟和可达性的选择；实际体验需根据网络与部署地区验证。

## 源码结构

| 路径 | 内容 |
| --- | --- |
| `extension/` | 新标签页前端、电脑商店构建、Android 主页构建 |
| `android/` | Kotlin Android 浏览器与扩展运行环境 |
| `shared/protocol/` | 共用的加密、配对与同步协议 |
| `relay/` | Cloudflare Worker、Durable Objects、R2 与官网 |
| `edge/` | EdgeOne Makers 同步实现、Blob 存储与官网 |
| `wrangler.jsonc` | Cloudflare 根目录部署配置 |
| `edgeone.json`、`cloud-functions/` | Makers 根目录部署配置与函数入口 |

这是整理后的公开源码快照，包含构建所需源码与公开配置。私人部署凭据、签名私钥、历史工作记录和本机工具路径不属于公开构建输入。

## 本地构建

安装 Node.js 22 或更高版本。Android 构建另外需要 JDK 17 和 Android SDK；在自己的 `android/local.properties` 配置 SDK，或设置标准 SDK 环境变量。

```sh
git clone https://github.com/mumuhaha487/kongjin.git
cd kongjin
npm --prefix extension ci
npm --prefix extension run pack:store
```

发布目录固定为 `release`，不附版本或其他后缀。交付文件只有 `kongjing.zip`、`kongjing.crx`、`android.url` 和 `source.zip`，不附图片、校验文本或说明文件。ZIP 根目录含 `manifest.json`，无需作者私钥或云账号即可构建并提交商店。

CRX 使用同一份 ZIP 签名，需设置 `KONGJING_CRX_KEY_PATH` 指向自己的既有私钥；缺少私钥时只构建 ZIP，不自动创建新的签名身份。CRX 不是 Google 商店签名包，正常用户仍从正式商店安装。`android.url` 打开官网 APK 下载，源码归档来自经过审查的公开 Git 提交。完整四项归档流程见 [RELEASE.md](docs/RELEASE.md)。

先构建真实 Android 主页，再构建调试 APK。在 Windows PowerShell 中运行：

```powershell
npm --prefix extension run build:android
npm --prefix android/extension-runtime ci
npm --prefix android/extension-runtime run fixtures
npm --prefix android/extension-runtime run build
cd android
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

运行时测试使用七个第三方商店样本，需 Python 3 从官方更新服务下载到本机，不在仓库重新分发。下载器遵循标准 HTTPS_PROXY，可用 KJ_FIXTURE_PROXY 指定自己的代理。若只编译 APK，可单独执行 assembleDebug；完整 JVM 验证需要先备齐样本。

调试构建使用自己的本机调试签名，无需作者私钥。签名发布需要自己的 `android/keystore.properties`，详见[发布流程](docs/RELEASE.md)。Android 8.0 是应用最低系统版本；扩展运行能力还取决于 WebView。WebView 91 缺少所需的 document-start 注入支持时，扩展安装会安全失败并说明限制，不会假装安装成功。更新系统 WebView 后再按实际兼容性测试；此限制不等同于本地主页无法打开。

协议与前端检查按各目录的脚本执行，例如：

```sh
npm --prefix shared/protocol ci
npm --prefix shared/protocol test
npm --prefix shared/protocol run typecheck
npm --prefix extension run test:store
npm --prefix extension run lint:store
```

部署从根目录运行 `npm install`，然后使用 `npm run deploy:cloudflare` 或 `npm run build:edgeone`。运行时机密由自己的平台控制台或官方交互命令提供，完整步骤见[部署指南](docs/DEPLOYMENT.md)。

## 安全与许可

漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，避免在公开 issue 中附上配对凭据或用户数据。项目使用 [MIT License](LICENSE)；第三方依赖保留各自的许可和声明。
