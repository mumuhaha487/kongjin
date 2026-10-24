# Chrome Web Store 发布说明

当前电脑商店上传包版本为 **2.1.0**，上传文件为 `release/kongjing.zip`。`release/kongjing.crx` 仅为同一 ZIP 使用既有密钥签名的容器，不是另一套功能版本，也不代替商店上传 ZIP。`extension/package.json` 的主界面版本 2.4.0 同时服务于 Android 主页，商店版本以打包后的 `manifest.json` 为准。

## 构建上传包

在仓库根目录安装前端依赖并打包：

```sh
npm --prefix extension ci
npm --prefix extension run test:store
npm --prefix extension run lint:store
npm --prefix extension run pack:store
```

构建不需要云平台凭据、作者私钥或本机历史产物。直接将生成的 ZIP 上传到自己的 Chrome Web Store Developer Dashboard。ZIP 根目录必须有 `manifest.json`，不要再包一层目录，也不要把源码目录或 Android 构建上传到商店。

发布前检查 ZIP 内清单、代码与实际权限。不要只看源码清单：商店构建会裁剪非商店功能。首次发布及后续更新都需要真实的 Chrome Web Store 审核，构建成功与本地检查通过不保证审核通过。正式商店 URL 以审核后分配的页面为准；用户从正式商店安装，GitHub 上的上传 ZIP 不等同于已上架产品。

## 商店功能边界

商店版是 Manifest V3 扩展，后台入口使用 Service Worker。后台同步通过 HTTP/WebSocket 连接所选平台，不使用 offscreen document 或 WebRTC 点对点通道。不要向审核方描述它包含安卓或非商店版专属功能。

基础权限用于以下功能：

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存本机书签、设置及同步状态 |
| `favicon` | 读取浏览器缓存的网站图标 |
| `activeTab` | 用户点击收藏时获取当前网页地址与标题 |
| `contextMenus` | 提供用户主动操作的收藏入口 |
| `alarms` | 唤醒后台并安排同步维护 |
| `search` | 将搜索交给浏览器默认搜索引擎 |

商店版不请求 `offscreen`、`history`、`tabs` 或 `notifications` 权限。基础功能无需浏览记录权限，也不读取任意网页正文。搜索不会静默更换浏览器默认搜索提供方。

空境栏是同一书签管理用途下的可选入口，默认关闭。用户在设置中主动开启时，才同时申请可选 `scripting` 及 HTTP(S) 网站访问权限，将随包提供的书签栏注入普通网页；不读取网页正文。鼠标悬停或点击边缘展开，移出栏及菜单区域后自动收回，Alt+J 和 Esc 仍可操作。商店、浏览器内部页面与被用户隐藏的网站不显示。审核材料需披露可选权限和这一用途，不得宣称该更新已通过谷歌审核。

默认主机权限仅用于 Cloudflare 公共服务 `https://kongjing.inc.re/*`。HTTP(S) 可选主机声明不会自动授予访问权。仅在用户确认自建服务时，申请访问该精确来源；开启空境栏会另行明确申请普通 HTTP(S) 网站权限。拒绝授权后保留本机功能，显示该自建服务或空境栏不可用；浏览器设置中可撤销授权。

自建地址与平台要匹配：Cloudflare 和 EdgeOne 使用各自后端。同步和图标请求使用用户选择的 endpoint。服务器 CORS 还需允许实际安装的扩展来源，不能假定开发安装 ID 与正式商店 ID 相同。详见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 隐私与审核材料

公开隐私政策：<https://kongjing.inc.re/privacy>，仓库对应文件为 `relay/public/privacy.html` 与 `edge/public/privacy.html`。

商店的单一用途说明、权限说明、数据披露与隐私政策必须符合最终 ZIP 的实际行为：本地书签和新标签页是核心功能，多设备同步可选，内容在设备上端到端加密。服务端仍能处理随机标识、密文大小、时间和网络元数据；网站图标查询会发送域名。搜索词在用户提交后会交给默认搜索引擎。不得将端到端加密表述为没有任何网络元数据。

可执行代码随 ZIP 打包。同步服务、图标响应和用户填写的服务地址仅提供数据，不提供远程可执行代码。不要添加远程脚本、下载后执行的模块或远程求值逻辑。

### 控制台可粘贴说明

`scripting` / 脚本编写理由：

```text
The optional scripting permission is used only for the Kongjing bookmark Dock. This feature is disabled by default. When the user explicitly enables it and grants website access, the extension uses chrome.scripting to register and inject bar.js, which is included in the extension package, into permitted HTTP/HTTPS pages. The Dock lets users access saved bookmarks and save the current page. Disabling the feature unregisters the content script. No remote code is downloaded or executed.
```

主机权限理由（替换旧版「未使用内容脚本」说明）：

```text
The required https://kongjing.inc.re/* access connects to the default sync and favicon service. Sync payloads are encrypted on the device; the relay stores and forwards ciphertext. Favicon requests send a site's domain to retrieve its public icon. Optional HTTP/HTTPS access is requested only after a user action: for the exact origin of a user-configured sync service, or for websites when the user enables the bookmark Dock. The Dock injects only bar.js included in the extension package and lets the user open saved bookmarks or save the current page URL and title. It does not read page body text or browsing history. Optional access can be denied or revoked.
```

「远程代码」按当前商店包的实际行为选择「否」。联网传输数据不等同于加载远程可执行代码。若未来实现改变，应更新披露；不得为了匹配表单选项删减功能或隐瞒行为。

截图和介绍应展示最终商店版的真实界面。若提供审核测试步骤，使用自己的临时测试设备与可撤销配对，说明如何创建配对、比对安全码、授权自建来源和离开配对组；不要在公开材料中提供真实用户密钥或私人后端地址。

## 发布前验证

使用最终 ZIP 检查清单权限和背景入口，验证新标签页、默认搜索、收藏、导入导出、配对及重新打开浏览器后的数据恢复。额外覆盖拒绝自建来源权限、撤销权限、断网和服务暂时不可用的情况。

网络恢复应继续同步，超时与重试必须有界；自动重试仅用于安全的幂等操作。Chrome 可能暂停 Service Worker，后台传递时间受浏览器生命周期和网络影响，不能承诺永久在线或固定时延。本地书签、搜索记录与设置应在服务不可用时保留。

发布后记录版本、ZIP SHA-256、正式商店 URL 和审核状态，并更新 GitHub Releases。下载别名与官网说明应指向这个商店上传包，不应混入其他电脑构建。发布流程见 [RELEASE.md](RELEASE.md)。
