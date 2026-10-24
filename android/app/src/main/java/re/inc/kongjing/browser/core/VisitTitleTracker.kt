package re.inc.kongjing.browser.core

/** One WebView navigation. A late title updates the original visit, never its timestamp. */
class VisitTitleTracker {
    private var url: String? = null
    private var incognito = false
    private var title = ""
    private var visit: Visit? = null
    private var waitingForTitle = false

    fun started(url: String, incognito: Boolean = false) {
        this.url = url
        this.incognito = incognito
        title = ""
        visit = null
        waitingForTitle = false
    }

    fun finished(url: String, at: Long): Visit? {
        if (url != this.url || visit != null || !ContinuityPublisher.eligible(url, incognito)) return null
        return Visit(url, title, at).also {
            visit = it
            waitingForTitle = title.isEmpty()
        }
    }

    fun receivedTitle(url: String?, value: String?): Visit? {
        if (url != this.url || url == null) return null
        val candidate = value.orEmpty().trim()
        // WebView may report the URL itself (with or without its scheme) before <title> arrives.
        if (candidate.isEmpty() || candidate.trimEnd('/') == url.trimEnd('/') ||
            candidate.trimEnd('/') == url.substringAfter("://").trimEnd('/')) return null
        title = candidate
        val original = visit ?: return null
        if (!waitingForTitle) return null
        waitingForTitle = false
        return original.copy(ti = title)
    }

    fun clear() {
        url = null
        visit = null
        title = ""
        waitingForTitle = false
    }
}
