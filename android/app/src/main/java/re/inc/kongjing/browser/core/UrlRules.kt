package re.inc.kongjing.browser.core

import java.net.IDN
import java.net.URI
import java.net.URLEncoder
import java.util.Locale

object UrlRules {
    const val HOME = "https://appassets.androidplatform.net/home/index.html"
    const val DEFAULT_SEARCH = "https://www.bing.com/search?q=%s"
    private val scheme = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")
    private val denied = setOf("javascript", "file", "content", "data", "blob", "about", "chrome", "android-app")

    fun webUrl(value: String): String? = runCatching {
        val uri = URI(value.trim())
        val protocol = uri.scheme?.lowercase(Locale.ROOT)
        if (protocol !in setOf("http", "https") || uri.rawUserInfo != null) return null
        val authority = uri.rawAuthority ?: return null
        if (authority.contains('@') || authority.contains('\\')) return null
        val host = if (authority.startsWith('[')) authority.substringBefore(']') + "]"
            else authority.substringBefore(':')
        if (host.isBlank()) return null
        val ascii = if (host.startsWith('[')) host else IDN.toASCII(host).lowercase(Locale.ROOT)
        if (!ascii.startsWith('[') && !Regex("[a-zA-Z0-9.-]+").matches(ascii)) return null
        val portText = authority.removePrefix(host)
        if (portText.isNotEmpty() && (!portText.startsWith(':') || portText.drop(1).toIntOrNull() !in 1..65535)) return null
        "$protocol://$ascii$portText${uri.rawPath.orEmpty().ifEmpty { "/" }}${uri.rawQuery?.let { "?$it" }.orEmpty()}${uri.rawFragment?.let { "#$it" }.orEmpty()}"
    }.getOrNull()

    fun addressUrl(input: String): String? {
        val value = input.trim()
        if (value.startsWith("http://", true) || value.startsWith("https://", true)) return webUrl(value)
        if (value.isEmpty() || value.any { it.isWhitespace() || it.code !in 33..126 }) return null
        val authority = value.takeWhile { it !in "/?#" }
        if (!Regex("[A-Za-z0-9.-]+(?::[0-9]{1,5})?").matches(authority)) return null
        val host = authority.substringBefore(':')
        val labels = host.split('.')
        val ipv4 = labels.size == 4 && labels.all { it.isNotEmpty() && it.all(Char::isDigit) && it.toIntOrNull() in 0..255 }
        val domain = labels.size >= 2 && labels.all { Regex("[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?").matches(it) } &&
            Regex("[A-Za-z]{2,24}").matches(labels.last())
        if (!host.equals("localhost", true) && !ipv4 && !domain) return null
        val protocol = if (host.equals("localhost", true) || ipv4) "http" else "https"
        return webUrl("$protocol://$value")
    }

    fun searchUrl(input: String, template: String = DEFAULT_SEARCH): String {
        val safe = if (validTemplate(template)) template else DEFAULT_SEARCH
        return safe.replace("%s", URLEncoder.encode(input.trim(), "UTF-8").replace("+", "%20"))
    }

    fun resolve(input: String, template: String = DEFAULT_SEARCH): String = addressUrl(input) ?: searchUrl(input, template)

    data class AddressAction(val label: String, val url: String)
    fun addressActions(input: String, template: String = DEFAULT_SEARCH): List<AddressAction> = buildList {
        add(AddressAction("搜索：$input", searchUrl(input, template)))
        addressUrl(input)?.let { add(AddressAction("打开：$it", it)) }
    }

    fun validTemplate(value: String): Boolean = value.contains("%s") && webUrl(value.replace("%s", "query")) != null
    fun isHome(value: String): Boolean = runCatching {
        val uri = URI(value)
        uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
            uri.port in listOf(-1, 443) && uri.rawUserInfo == null &&
            uri.normalize().path.startsWith("/home/") && !uri.rawPath.contains('%') && !uri.rawPath.contains('\\')
    }.getOrDefault(false)

    fun isAssetOrigin(value: String): Boolean = runCatching {
        URI(value).host.equals("appassets.androidplatform.net", true)
    }.getOrDefault(false)

    fun externalAllowed(value: String): Boolean = runCatching {
        if (value.any { it.code < 32 }) return false
        val protocol = URI(value).scheme?.lowercase(Locale.ROOT) ?: return false
        protocol !in denied && protocol !in setOf("http", "https")
    }.getOrDefault(false)

    fun host(value: String): String = runCatching { URI(value).host.orEmpty() }.getOrDefault("")
    fun sameOrigin(first: String, second: String): Boolean = runCatching {
        fun origin(value: String): Triple<String, String, Int> {
            val uri = URI(value)
            require(uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank())
            return Triple(uri.scheme.lowercase(Locale.ROOT), uri.host.lowercase(Locale.ROOT),
                if (uri.port == -1) if (uri.scheme == "https") 443 else 80 else uri.port)
        }
        origin(first) == origin(second)
    }.getOrDefault(false)
}
