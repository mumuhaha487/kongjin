package re.inc.kongjing.browser.core

import java.net.URI

sealed class ScanTarget {
    data class Web(val url: String) : ScanTarget()
    data class Pairing(val code: String) : ScanTarget()
}

object BrowserFeatures {
    fun historyTarget(index: Int, size: Int, offset: Int): Boolean = offset != 0 && index in 0 until size && index.toLong()+offset in 0L until size.toLong()
    fun scan(value: String): ScanTarget? {
        val text = value.trim()
        val code = if (text.startsWith("kongjing://pair?", true)) runCatching {
            val uri = URI(text)
            if (uri.host != "pair" || uri.rawUserInfo != null) null else uri.rawQuery.split('&')
                .firstOrNull { it.startsWith("code=") }?.substringAfter('=')?.let { java.net.URLDecoder.decode(it, "UTF-8") }
        }.getOrNull() else text
        if (code != null && Regex("KJ-[A-Z0-9]{5}-[A-Z0-9]{5}").matches(code)) return ScanTarget.Pairing(code)
        return UrlRules.webUrl(text)?.takeUnless(UrlRules::isAssetOrigin)?.let(ScanTarget::Web)
    }
    fun clipboard(value: String?): String? = value?.takeIf { it.length <= 8192 }?.let(UrlRules::addressUrl)?.takeUnless(UrlRules::isAssetOrigin)
    fun zoom(value: Int) = value.coerceIn(80, 150)
    fun dark(value: String) = value.takeIf { it in setOf("follow", "on", "off") }
    fun darkEnabled(mode: String?, appDark: Boolean) = mode == "on" || mode == "follow" && appDark
    fun origin(value: String): String? = runCatching {
        val url = URI(UrlRules.webUrl(value) ?: return null)
        "${url.scheme}://${url.host}${if (url.port == -1) "" else ":${url.port}"}"
    }.getOrNull()
    fun safeFileName(value: String): String = value.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(180).ifBlank { "download" }
}

/** Bounded, persisted recent list. Invalid and home URLs never enter it. */
data class ClosedPage(val url: String, val title: String, val desktop: Boolean = false)
class ClosedPages(initial: List<ClosedPage> = emptyList()) {
    private val entries = initial.filter { UrlRules.webUrl(it.url) != null && !UrlRules.isAssetOrigin(it.url) }.take(10).toMutableList()
    fun list(): List<ClosedPage> = entries.toList()
    fun push(page: ClosedPage) {
        if (UrlRules.webUrl(page.url) == null || UrlRules.isAssetOrigin(page.url)) return
        entries.add(0, page); while (entries.size > 10) entries.removeAt(entries.lastIndex)
    }
    fun remove(index: Int): ClosedPage? = if (index in entries.indices) entries.removeAt(index) else null
}
