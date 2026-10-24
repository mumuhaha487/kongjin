package re.inc.kongjing.browser.core

import java.net.URI

/** Scroll distance is measured in dp, independent of the emulator/device density. */
class ToolbarScrollPolicy {
    private var downward = 0f
    fun reset() { downward = 0f }
    fun update(y: Float, oldY: Float, home: Boolean, panelOpen: Boolean): Boolean? {
        if (home || panelOpen || y <= 0f) { reset(); return false }
        val delta = y - oldY
        if (delta < 0f) { reset(); return false }
        downward += delta
        return if (downward > 24f) true else null
    }
}

object MobileUiPolicy {
    data class SearchIcon(val key: String, val name: String, val letter: String)
    fun searchIcon(template: String): SearchIcon {
        val host = domain(template.substringBefore('?')).lowercase()
        return when {
            host == "bing.com" || host.endsWith(".bing.com") -> SearchIcon("bing", "Bing", "B")
            host == "baidu.com" || host.endsWith(".baidu.com") -> SearchIcon("baidu", "百度", "百")
            host == "duckduckgo.com" || host.endsWith(".duckduckgo.com") -> SearchIcon("duckduckgo", "DuckDuckGo", "D")
            Regex("(^|\\.)google\\.(com|[a-z]{2}|com\\.[a-z]{2}|co\\.[a-z]{2})$").containsMatchIn(host) -> SearchIcon("google", "Google", "G")
            else -> SearchIcon("custom", host.ifBlank { "自定义搜索引擎" }, host.take(1).uppercase().ifEmpty { "自" })
        }
    }
    fun menuLabelSp(measuredAt11Sp: Float, availablePx: Float): Int = if (measuredAt11Sp > availablePx) 10 else 11
    fun domain(url: String): String = runCatching { URI(url).host.orEmpty().removePrefix("www.") }.getOrDefault("")
    fun subtitle(url: String): String = runCatching { URI(url).let { domain(url) + it.rawPath.orEmpty() + (it.rawQuery?.let { q -> "?$q" } ?: "") } }.getOrDefault(url)
    fun tabColumns(widthDp: Int, heightDp: Int) = if (widthDp > heightDp) 3 else 2
    fun recentSearches(previous: List<String>, query: String): List<String> = query.trim().take(500).let { term ->
        if (term.isEmpty()) previous.take(5) else (listOf(term) + previous.filterNot { it.equals(term, true) }).take(5)
    }
    /** Chrome query patterns; malformed patterns never broaden a query. */
    fun matches(pattern: String, value: String): Boolean = runCatching {
        if(pattern=="<all_urls>")return UrlRules.webUrl(value)!=null
        Regex(pattern.split('*').joinToString(".*") { Regex.escape(it) }).matches(value)
    }.getOrDefault(false)
}

/** IDs are never reused, even after going Home and opening a new page in the same native tab. */
class ExtensionTabIds {
    private var next = 1
    private val ids = mutableMapOf<String, Int>()
    fun id(native: String): Int = ids.getOrPut(native) { next++ }
    fun existing(native: String): Int? = ids[native]
    fun native(id: Int): String? = ids.entries.firstOrNull { it.value == id }?.key
    fun remove(native: String): Int? = ids.remove(native)
}
