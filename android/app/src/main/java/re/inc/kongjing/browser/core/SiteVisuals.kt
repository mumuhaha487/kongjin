package re.inc.kongjing.browser.core

object SiteVisuals {
    // Match extension/src/lib/favicon.ts: signed int32 hash, then unsigned remainder.
    fun hue(host: String): Float {
        var hash = 0
        host.codePoints().forEach { hash = hash * 31 + Character.toChars(it)[0].code }
        return (hash.toUInt() % 360u).toFloat()
    }
    fun tabCount(count: Int): String = if (count >= 100) "99+" else count.toString()
}
