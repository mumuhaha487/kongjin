package re.inc.kongjing.browser.core

data class TabUsage(val id: String, val lastUsed: Long, val home: Boolean = false)

object TabPolicy {
    const val MAX_WEBVIEWS = 12
    /** The persistent home counts as one WebView, even when no home tab is visible. */
    fun victims(livePages: List<TabUsage>, activeId: String, budget: Int = MAX_WEBVIEWS - 1): List<String> =
        livePages.filterNot { it.home || it.id == activeId }.sortedBy { it.lastUsed }
            .take((livePages.count { !it.home } - budget).coerceAtLeast(0)).map { it.id }
}
