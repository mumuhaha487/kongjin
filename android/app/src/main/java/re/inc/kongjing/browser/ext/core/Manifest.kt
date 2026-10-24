package re.inc.kongjing.browser.ext.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

fun JSONArray.values(): List<Any> = (0 until length()).map { get(it) }
fun JSONObject.strings(key: String): List<String> = optJSONArray(key)?.values()?.filterIsInstance<String>() ?: emptyList()
fun JSONObject.objects(key: String): List<JSONObject> = optJSONArray(key)?.values()?.filterIsInstance<JSONObject>() ?: emptyList()

data class ExtensionManifest(val id: String, val json: JSONObject, val messages: JSONObject) {
    val version: String get() = json.getString("version")
    val name: String get() = json.getString("name")
    val permissions: Set<String> get() = json.strings("permissions").filterNot { "://" in it || it == "<all_urls>" }.toSet()
    val hosts: Set<String> get() = (json.strings("host_permissions") + json.strings("permissions").filter { "://" in it || it == "<all_urls>" }).toSet()
    val optionalPermissions: Set<String> get() = json.strings("optional_permissions").filterNot {"://" in it || it=="<all_urls>"}.toSet()
    val optionalHosts: Set<String> get() = (json.strings("optional_host_permissions")+json.strings("optional_permissions").filter {"://" in it || it=="<all_urls>"}).toSet()
    val contentScripts get() = json.objects("content_scripts")
    val action: JSONObject get() = json.optJSONObject("action") ?: json.optJSONObject("browser_action") ?: json.optJSONObject("page_action") ?: JSONObject()
    val popup get() = action.optString("default_popup")
    val options get() = json.optJSONObject("options_ui")?.optString("page") ?: json.optString("options_page")
    fun url(path: String = "") = "https://$id.ext.kongjing.invalid/${path.trimStart('/')}"
    fun message(key: String, substitutions: List<String> = emptyList()): String {
        if (key == "@@extension_id") return id
        if (key == "@@ui_locale") return "zh_CN"
        val entry=messages.optJSONObject(key.lowercase()) ?: return ""
        var value=entry.optString("message")
        val placeholders=entry.optJSONObject("placeholders") ?: JSONObject()
        value=Regex("\\$([A-Za-z0-9_]+)\\$").replace(value) { m ->
            val p=placeholders.keys().asSequence().firstOrNull { it.equals(m.groupValues[1],true) }
            p?.let { placeholders.optJSONObject(it)?.optString("content") } ?: ""
        }
        return Regex("\\$\\$|\\$(\\d+)").replace(value) { m -> if (m.value == "$$") "$" else substitutions.getOrNull(m.groupValues[1].toInt()-1) ?: "" }
    }
    companion object {
        fun load(id: String, root: File, locale: String = "zh_CN"): ExtensionManifest {
            require(Regex("[a-p]{32}").matches(id))
            val raw=JSONObject(File(root,"manifest.json").readText())
            require(raw.optInt("manifest_version") in 2..3) { "仅支持 manifest v2/v3" }
            require(Regex("[0-9]+(?:\\.[0-9]+){0,3}").matches(raw.getString("version"))) { "无效的扩展版本" }
            require(raw.getString("name").isNotBlank())
            fun file(path:String) {require(path.isNotBlank() && SafeZip.path(root,path.trimStart('/')).isFile) {"扩展引用了不存在的文件：$path"}}
            raw.objects("content_scripts").forEach {validateContentScript(it,root)}
            raw.optJSONObject("background")?.let {bg->bg.strings("scripts").forEach(::file);if(bg.has("service_worker"))file(bg.getString("service_worker"));if(bg.has("page"))file(bg.getString("page"))}
            for(action in listOf("action","browser_action","page_action")) raw.optJSONObject(action)?.optString("default_popup")?.takeIf {it.isNotBlank()}?.let(::file)
            raw.optString("options_page").takeIf {it.isNotBlank()}?.let(::file)
            raw.optJSONObject("options_ui")?.optString("page")?.takeIf {it.isNotBlank()}?.let(::file)
            raw.optJSONObject("declarative_net_request")?.objects("rule_resources")?.forEach {file(it.getString("path"))}
            val fallback=raw.optString("default_locale")
            val messages=JSONObject()
            val languages=listOf(fallback,locale.substringBefore('_'),locale).filter { Regex("[A-Za-z_]+",RegexOption.IGNORE_CASE).matches(it) }.distinct()
            languages.forEach { lang ->
                val f=File(root,"_locales/$lang/messages.json")
                if(f.isFile) { val map=JSONObject(f.readText()); map.keys().forEach { messages.put(it.lowercase(),map.get(it)) } }
            }
            val manifest=ExtensionManifest(id,raw,messages)
            val resolved=Regex("__MSG_([A-Za-z0-9_@]+)__").replace(raw.toString()) { match ->
                JSONObject.quote(manifest.message(match.groupValues[1])).removeSurrounding("\"")
            }
            return manifest.copy(json=JSONObject(resolved))
        }
        fun validateContentScript(script:JSONObject,root:File) {
            require(script.strings("matches").isNotEmpty()) {"内容脚本必须声明 matches"}
            for(key in listOf("matches","exclude_matches","excludeMatches"))require(script.strings(key).all {it=="<all_urls>" || Regex("^(\\*|https?|file|ftp)://[^/]*(/.*)$").matches(it)}) {"内容脚本匹配模式无效"}
            require(script.optString("run_at",script.optString("runAt","document_idle")) in setOf("document_start","document_end","document_idle"))
            require(script.optString("world","ISOLATED") in setOf("ISOLATED","MAIN","USER_SCRIPT"))
            (script.strings("js")+script.strings("css")).forEach {path->val file=SafeZip.path(root,path.trimStart('/'));require(file.isFile && file.length()<=20*1024*1024) {"内容脚本文件无效：$path"}}
        }
    }
}

object PermissionText {
    private val descriptions=mapOf("tabs" to "读取您的浏览记录","webNavigation" to "读取您的浏览记录","notifications" to "显示通知","downloads" to "管理您的下载内容","declarativeNetRequest" to "阻止网页上的内容","declarativeNetRequestWithHostAccess" to "阻止网页上的内容","clipboardRead" to "读取您复制和粘贴的数据","clipboardWrite" to "修改您复制和粘贴的数据","geolocation" to "检测您的实际位置")
    private val silent=setOf("storage","alarms","contextMenus","menus","scripting","activeTab","unlimitedStorage")
    fun describe(permissions: Collection<String>, hosts: Collection<String>): List<String> = buildList {
        if(hosts.any { it in setOf("<all_urls>","*://*/*","http://*/*","https://*/*") }) add("读取和更改您在所有网站上的数据")
        else if(hosts.isNotEmpty()) {
            val names=hosts.map { it.substringAfter("://").substringBefore('/').removePrefix("*.") }.distinct()
            add("读取和更改您在 ${names.first()}${if(names.size>1) " 和另外 ${names.size-1} 个网站" else ""}上的数据")
        }
        permissions.filterNot { it in silent }.map { descriptions[it] ?: "使用扩展权限：$it" }.distinct().forEach(::add)
    }
}
