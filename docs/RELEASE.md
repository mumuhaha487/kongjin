# 版本构建与发布

当前版本分别为：Chrome Web Store 上传包 **2.1.0**、主界面 / Android 内置主页 **2.4.0**、Android 应用 **1.4.2（versionCode 12）**。这三个版本号用于不同产物；以每个最终归档内的清单为准。

公开仓库提供源码与可重建配置，不含作者的生产凭据、签名私钥或私人部署资料。发布使用自己的云账号、商店开发者账号和 Android 签名身份。

## 电脑商店 ZIP

```sh
npm --prefix extension ci
npm --prefix extension run test:store
npm --prefix extension run lint:store
npm --prefix extension run pack:store
```

商店上传文件为 `release/kongjing.zip`。检查 ZIP 根目录 `manifest.json` 的 `version`、Service Worker 入口、权限与实际打包内容，再上传到 Chrome Web Store。商店审核是独立流程，不能以构建成功替代审核，也不能保证审核结果。完整权限说明见 [STORE.md](STORE.md)。

可选设置 `KONGJING_CRX_KEY_PATH` 为自己的既有私钥，打包时同时生成 `release/kongjing.crx`。CRX 的 ZIP 载荷与商店 ZIP 字节完全相同，未改变功能；没有私钥时不创建替代身份。CRX 本地签名不等于 Google 商店签名。

## Android 调试构建

准备 Node.js 22+、JDK 17 和 Android SDK。SDK 路径由自己的 `android/local.properties` 或标准 SDK 环境变量提供，不写入公开源码。在 Windows PowerShell 中：

```powershell
npm --prefix extension ci
npm --prefix extension run build:android
npm --prefix android/extension-runtime ci
npm --prefix android/extension-runtime run fixtures
npm --prefix android/extension-runtime run build
cd android
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

运行时测试使用七个第三方商店样本，需 Python 3 从官方更新服务下载到本机，不在仓库重新分发。下载器遵循标准 HTTPS_PROXY，可用 KJ_FIXTURE_PROXY 指定自己的代理。若只编译 APK，可单独执行 assembleDebug；完整 JVM 验证需要先备齐样本。

调试构建无需作者私钥，使用本机调试签名。默认主页来自真实的 `extension/dist-android` 构建。发布包必须包含真实主页与构建标识，不能用占位主页或模拟页面代替。

## Android 签名发布

使用自己的 keystore，在 **`android/keystore.properties`** 填写：

```properties
storeFile=../keys/my-release.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=YOUR_KEY_ALIAS
keyPassword=YOUR_KEY_PASSWORD
```

这些值是占位示例。`storeFile` 可以是绝对路径，或相对于 `android/` 的路径；跨平台路径可使用 `/`。本机属性文件和密钥均已由 `.gitignore` 排除。不要将真实值复制到 issue、截图、构建日志、CI 公共变量或版本附件。

已有应用的覆盖更新必须保持相同 applicationId 与签名身份。自己创建的签名不能覆盖作者签名的已安装包；自行分发前规划自己的应用身份和升级路径，保留密钥的离线备份。

从仓库根目录运行发布构建脚本：

```powershell
pwsh -File android/scripts/Build-Release.ps1
```

该脚本先构建 Android 主页，再运行 JVM 测试、lint 和签名构建，并自动管理构建所需的 `DEVICE.lock`。公开构建不依赖作者的历史报告或本机已有锁文件。构建和归档参数以脚本参数定义为准；归档脚本为 `android/scripts/Package-Release.ps1`。

最终检查 APK 内 `versionName=1.4.2`、`versionCode=12`、最低系统版本以及签名证书，并计算 SHA-256。保留同一发布身份，不能为了方便更新而自动生成新的签名或把调试包标为正式版。

APK 保存在 Gradle 标准输出 `android/app/build/outputs/apk/release/app-release.apk`。归档脚本只向 `release/android.url` 写官网下载链接；证书与 SHA-256 输出到控制台，不在交付目录生成附加文件。

## 运行兼容性验证

验证实际发布包中的本地主页、收藏持久化、搜索、配对与网络恢复。同步请求使用有界超时和退避，仅自动重试适合重试的幂等操作；服务不可用时本地数据应保留，联网后继续同步。

Android 最低系统版本为 8.0，WebView 版本会影响网页与扩展运行能力。**WebView 91 不支持运行环境所需的 document-start 注入时，扩展安装会安全失败。** 应明确显示不支持的原因，不得记录为安装成功或承诺所有扩展可运行。本地主页兼容性与扩展运行环境兼容性分别验证；升级系统 WebView 后仍需对具体扩展测试。

本轮发布验收不应为了重跑测试而修改用户设备、删除真实配对数据或轮换生产机密。自动化测试优先使用隔离的本地服务和临时配对。

## GitHub Releases 与官网下载

目录固定名为 `release`，只有四个文件：

```text
release/
  kongjing.crx
  kongjing.zip
  android.url
  source.zip
```

GitHub Release 也只上传这四项，不附图片、摘要文件或额外说明。版本、已知限制、证书及校验值写在 Release 正文。Android 实体 APK 放在官网下载服务；`android.url` 是该下载入口的快捷链接。源码归档使用经过隐私扫描并已提交的公开 Git 快照，不能打包包含本机机密的整个工作目录。

从含本机私有配置的工作区导出时，`scripts/public-source.mjs` 必须收到**完整、显式的私人 HTTP(S) origin 清单**。清单包含当前与历史配置中的全部私人后端，不能仅填当前默认服务或虚构占位值。原始输入只允许协议、主机、可选端口及可选的单个结尾 `/`；清单项不能带空白。校验在URL解析消除点路径之前执行；空清单、空项、非 URL、用户信息、路径（包括 `/a/..` 和 `/.`）、百分号编码、查询及片段会在创建父目录、目标或复制文件之前失败。目标必须是工作区内尚不存在的独立目录，不能指向公共 Git 副本；审核后再比较、同步至公共 main。

最终严格扫描覆盖文件内容的原始字节、UTF-8/UTF-16视图，以及相对文件名和目录名；这些位置都检查已提供的origin/hostname、`secretValues`精确凭据和既有凭据模式。扫描同时检查原始视图及最多16层Unicode、hex和反斜杠标点转义的解码视图；第16层后若仍可继续解码，保守拒绝，不能把循环耗尽当作通过。已有直接脱敏保持不变；嵌套转义中发现已知私用值时拒绝导出，不尝试重写其程序语义。检查失败即移除本次导出；错误只含路径、行号和类别，含私用值、凭据模式或未收敛转义的名称以 `[private path]` 隐去。转义解码视图的行号以对应视图计，不输出匹配原文。

清单只在当前进程从自己已有的受保护配置加载，不放进命令行、源码、CI变量、测试、日志或提交。以下 PowerShell 示例假定自己的受保护 JSON 已有 `privateOrigins` 数组与可选 `secretValues` 数组；应按既有配置结构读取，勿改写作者的机密文件。`$protectedConfig` 和 `$snapshot` 分别是自己配置的路径及新的内部隔离目录：

```powershell
@'
import { readFile } from 'node:fs/promises';
import { exportPublicSource } from './scripts/public-source.mjs';
const config = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
await exportPublicSource(process.argv[3], {
  privateOrigins: config.privateOrigins,
  secretValues: config.secretValues ?? []
});
console.log('Internal public-source candidate checked');
'@ | node --input-type=module - "$protectedConfig" "$snapshot"
```

既有受保护加载器也可仅给当前子进程传入 `KONGJING_PRIVATE_ORIGINS`（逗号分隔、项间不加空白），再执行 `node scripts/public-source.mjs <新的内部目录>`；禁止打印该环境变量或把它持久化。精确凭据检查需按上述函数参数显式传入 `secretValues`，仅设置origin环境变量不会自动读取本机凭据。导出器不能推断清单是否遗漏了未知服务；逐层转义检查也不是任意程序求值器，不能证明字符串拼接、加密等所有编码行为都没有秘密。维护者必须先核对完整配置清单，再以独立扫描核验目录和候选归档。内部证据、浏览器数据和旧失败导出不参与公开归档。

公开源码首次构建和现有 CI **不需要作者的私人清单或凭据**。通用扫描仍用 `node scripts/check-public.mjs <公开目录>`；若显式提供了无效清单也会报错。受控导出或复核可在同一受保护加载进程调用 `checkPublic(directory, { privateOrigins, secretValues, requirePrivateOrigins: true })`，CLI 等价严格开关为 `--require-private-origins`。回归测试独立运行 `node --test tests/public-source.test.mjs`，仅使用虚构地址，不增加公共构建的机密依赖。

签名 APK 和扩展 ZIP 就绪后，先运行 `node scripts/release.mjs --downloads-only` 准备官网下载及链接；提交审查过的公开源码，再运行 `node scripts/release.mjs --source-directory <public-git-directory>` 从其 HEAD 生成 `source.zip`。在公开仓库内可省略此参数，默认使用自身 Git。运行 `node scripts/check-release.mjs --allow-extra`，然后执行 `pwsh -File scripts/clean-releases.ps1 -Apply`；脚本会先验签和检查四项产物，再删除 `release` 内其他文件及空子目录。最终 `node scripts/check-release.mjs` 应通过。商店截图如需重新生成，保存到内部 `extension/artifacts/store-assets`，不进入交付目录或 Release 附件。

官网电脑下载使用：

```text
https://github.com/mumuhaha487/kongjin/releases/latest/download/kongjing.zip
```

安卓稳定下载别名为 `https://kongjing.inc.re/download/android`。更新官网版本文字、下载重定向和校验信息时，以最终文件为准，并验证跳转后文件与已计算的 SHA-256 一致。

发布说明应区分「源码和上传包已发布」与「Chrome Web Store 已审核上架」。实际商店审核完成后再填写正式商店 URL 与状态。

## 同步服务部署

Cloudflare 是默认公共服务。自己的部署从根目录安装依赖并使用 `npm run deploy:cloudflare`；Makers 使用 `npm run build:edgeone` 和 `edge/public` 输出。运行时机密通过官方平台的受保护设置或交互命令提供，具体资源、CORS 与平台选择见 [DEPLOYMENT.md](DEPLOYMENT.md)。

更新已有服务时保留自己的存储、机密和域名。不要因普通版本发布轮换配对数据或清空持久化存储。
