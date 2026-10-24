package re.inc.kongjing.browser.ext.core

import java.io.File

enum class CompatibilityLevel { SUPPORTED, PARTIAL, BLOCKED }
data class CompatibilityReport(val level: CompatibilityLevel, val issues: List<String>, val isolationWarning: Boolean)
/** Data table is also the native dispatcher allowlist. Unsupported APIs fail explicitly. */
object Capabilities {
    val p0: Map<String, Set<String>> = mapOf(
        "runtime" to "sendMessage connect getURL getManifest getPlatformInfo openOptionsPage reload setUninstallURL".split(' ').toSet(),
        "storage" to setOf("get","set","remove","clear","getBytesInUse","setAccessLevel"),
        "tabs" to "query get getCurrent create update remove reload sendMessage connect executeScript insertCSS".split(' ').toSet(),
        "windows" to setOf("getCurrent","getLastFocused","getAll","create"),
        "scripting" to "executeScript insertCSS removeCSS registerContentScripts getRegisteredContentScripts unregisterContentScripts updateContentScripts".split(' ').toSet(),
        "action" to "setBadgeText setBadgeBackgroundColor setBadgeTextColor getBadgeText setIcon setTitle setPopup getPopup enable disable openPopup".split(' ').toSet(),
        "i18n" to setOf("getMessage","getUILanguage","getAcceptLanguages"),
        "alarms" to setOf("create","get","getAll","clear","clearAll"),
        "contextMenus" to setOf("create","update","remove","removeAll"),
        "permissions" to setOf("contains","getAll","request","remove"),
        "declarativeNetRequest" to "updateEnabledRulesets getEnabledRulesets updateDynamicRules updateSessionRules getDynamicRules getSessionRules isRegexSupported getAvailableStaticRuleCount".split(' ').toSet(),
        "notifications" to setOf("create","update","clear","getAll"),
        "extension" to setOf("getURL","isAllowedFileSchemeAccess")
    )
    val unsupported=mapOf("commands" to "快捷键","devtools" to "开发者工具","debugger" to "调试器","nativeMessaging" to "原生消息","identity" to "使用 Google 账号登录","proxy" to "代理设置","privacy" to "隐私设置","fontSettings" to "字体设置","tabGroups" to "标签页分组","enterprise" to "企业管理","system" to "系统信息","bookmarks" to "读写书签","history" to "读写历史记录","topSites" to "常用网站","sessions" to "浏览会话","search" to "搜索服务","tabCapture" to "标签页捕获","desktopCapture" to "桌面捕获","pageCapture" to "页面捕获","gcm" to "推送服务","instanceID" to "实例标识")
    val p1=mapOf("webNavigation" to "导航观察","webRequest" to "网络请求观察","cookies" to "Cookie 管理","downloads" to "扩展下载","offscreen" to "离屏文档","userScripts" to "用户脚本","tts" to "文字朗读","sidePanel" to "侧边栏","management" to "扩展信息")
    val p1Methods=mapOf("offscreen" to setOf("createDocument","closeDocument","hasDocument"),"management" to setOf("getSelf"),"webNavigation" to setOf("getFrame","getAllFrames"),"cookies" to setOf("get","getAll","set","remove"),"downloads" to setOf("download","search"),"sidePanel" to setOf("open","setOptions","getOptions"),"userScripts" to setOf("register","unregister","getScripts","update","configureWorld","getWorldConfigurations","resetWorldConfiguration"))
    val events=mapOf("runtime" to "onMessage onConnect onInstalled onStartup onUpdateAvailable","tabs" to "onCreated onUpdated onActivated onRemoved","storage" to "onChanged","action" to "onClicked","alarms" to "onAlarm","contextMenus" to "onClicked","permissions" to "onAdded onRemoved","notifications" to "onClicked onClosed","webNavigation" to "onBeforeNavigate onCommitted onDOMContentLoaded onCompleted onHistoryStateUpdated")
    fun canonical(ns: String) = when(ns) { "browserAction","pageAction" -> "action"; "menus" -> "contextMenus"; else -> ns }
    fun analyze(m: ExtensionManifest, root: File, parseErrors: List<String> = emptyList()): CompatibilityReport {
        val issues=linkedSetOf<String>(); var blocked=false
        if (m.permissions.any { it in setOf("debugger","nativeMessaging") }) { blocked=true; issues+="需要不支持的调试器或原生消息权限" }
        m.permissions.forEach { unsupported[it]?.let { label -> issues+="$label 不可用" } }
        val partialP1=mapOf("webRequest" to "网络请求观察尚不可用","cookies" to "Cookie 管理仅支持指定网址，无法枚举全部 Cookie 属性","downloads" to "扩展下载仅支持系统下载器的基本查询","userScripts" to "用户脚本仅支持 MAIN 执行；USER_SCRIPT 独立世界与专用消息尚不可用","tts" to "文字朗读尚不可用")
        m.permissions.forEach {partialP1[it]?.let(issues::add)}
        m.json.optJSONObject("declarative_net_request")?.objects("rule_resources")?.forEach {resource->
            val file=SafeZip.path(root,resource.getString("path").trimStart('/'))
            if(file.isFile && Regex("\"type\"\\s*:\\s*\"modifyHeaders\"").containsMatchIn(file.readText()))issues+="修改网络请求头不可用"
        }
        if(m.json.has("declarative_net_request"))issues+="网络规则的子框架继承、公共域名边界及正则兼容性部分可用；带请求体的重定向不可用"
        val manifestFeatures=mapOf("devtools_page" to "开发者工具","chrome_url_overrides" to "替换浏览器页面","omnibox" to "地址栏指令","commands" to "快捷键")
        manifestFeatures.forEach { (key,label) -> if(m.json.has(key)) issues+="$label 不可用" }
        if(m.json.has("chrome_url_overrides") && m.contentScripts.isEmpty() && !m.json.has("background") && m.popup.isBlank()) blocked=true
        val scan=Regex("(?:chrome|browser)\\s*\\.\\s*(\\w+)\\s*\\.\\s*(\\w+)")
        root.walkTopDown().filter { it.isFile && it.extension in setOf("js","mjs") }.forEach { file ->
            scan.findAll(file.readText()).forEach { match ->
                val ns=canonical(match.groupValues[1]); val method=match.groupValues[2]
                if (ns in unsupported) issues+="${unsupported[ns]} 不可用"
                else if(method.startsWith("on") && ns in (p0.keys+p1.keys) && method !in (events[ns]?.split(' ') ?: emptyList()))issues+="$ns.$method 尚不可用"
                else if(ns in p1 && method !in (p1Methods[ns] ?: emptySet()) && !method.startsWith("on")) issues+="${p1[ns]} 尚不可用"
                else if(ns in p0 && ns != "storage" && method !in p0.getValue(ns) && !method.startsWith("on") && method !in setOf("id","lastError","inIncognitoContext","TAB_ID_NONE","WINDOW_ID_CURRENT")) issues+="$ns.$method 尚不可用"
            }
        }
        if(parseErrors.isNotEmpty()) { blocked=true; issues+="需要更新 Android System WebView：${parseErrors.first()}" }
        return CompatibilityReport(if(blocked) CompatibilityLevel.BLOCKED else if(issues.isEmpty()) CompatibilityLevel.SUPPORTED else CompatibilityLevel.PARTIAL,issues.toList(),m.contentScripts.isNotEmpty())
    }
}
