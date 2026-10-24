package re.inc.kongjing.browser.ext.core

import java.net.URI

object MatchPattern {
    fun glob(pattern: String, value: String): Boolean = Regex("^" + pattern.split('*').joinToString(".*") { Regex.escape(it) }.replace("\\Q?\\E", ".") + "$").matches(value)
    fun matches(pattern: String, url: String, originOnly: Boolean = false): Boolean = runCatching {
        val u = URI(url); val scheme=u.scheme?.lowercase(); val host=u.host?.lowercase() ?: return false
        if (u.rawUserInfo != null) return false
        if (pattern == "<all_urls>") return scheme in setOf("http","https","ftp")
        val p = Regex("^(\\*|https?|ftp|file)://([^/]*)(/.*)$").matchEntire(pattern) ?: return false
        val (s,h,path)=p.destructured
        (s == scheme || s == "*" && scheme in setOf("http","https")) &&
            (h == "*" || h.startsWith("*.") && (host == h.substring(2) || host.endsWith("."+h.substring(2))) || host == h) &&
            (originOnly || glob(path, (u.rawPath.ifEmpty { "/" }) + (u.rawQuery?.let { "?$it" } ?: "")))
    }.getOrDefault(false)
    fun allowedPage(url: String): Boolean = runCatching {
        val u=URI(url); val h=u.host?.lowercase() ?: ""
        u.scheme in setOf("http","https") && h != "appassets.androidplatform.net" && !h.endsWith(".ext.kongjing.invalid") &&
            h != "chromewebstore.google.com" && !(h == "chrome.google.com" && u.path.startsWith("/webstore"))
    }.getOrDefault(false)
    fun storeId(input: String): String? {
        if (Regex("[a-p]{32}").matches(input.trim())) return input.trim()
        return runCatching {
            val u=URI(input.trim()); require(u.scheme == "https" && u.rawUserInfo == null)
            require(u.host == "chromewebstore.google.com" && u.path.startsWith("/detail/") || u.host == "chrome.google.com" && u.path.startsWith("/webstore/detail/"))
            u.path.trimEnd('/').substringAfterLast('/').takeIf { Regex("[a-p]{32}").matches(it) }
        }.getOrNull()
    }
}
