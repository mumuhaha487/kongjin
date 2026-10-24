package re.inc.kongjing.browser.core

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.Locale

data class Suggestion(val url: String, val title: String, val bookmark: Boolean = false, val deviceName: String? = null)

/** All callbacks run on the UI thread. Each query owns its debounce and bridge cancellation. */
class AddressSuggestions(
    private val bridge: BridgeDispatcher,
    private val history: (String, (List<Suggestion>) -> Unit) -> Unit,
    private val schedule: (Long, () -> Unit) -> (() -> Unit)
) {
    fun query(query: String, publish: (List<Suggestion>) -> Unit): () -> Unit {
        var active = true
        var local = emptyList<Suggestion>()
        var bookmarks = emptyList<Suggestion>()
        var remote = emptyList<Suggestion>()
        val cancels = mutableListOf<() -> Unit>()
        fun emit() { if (active) publish(merge(bookmarks, local, remote)) }
        publish(emptyList())
        val cancelDebounce = schedule(DEBOUNCE_MS) {
            if (active) {
                history(query) { items -> if (active) { local = items; emit() } }
                cancels += bridge.call("searchBookmarks", JSONObject().put("query", query).put("limit", LIMIT)) { result ->
                    if (active) {
                        bookmarks = decodeBookmarks(result.getOrNull())
                        emit()
                    }
                }
                cancels += bridge.call("searchHistory", JSONObject().put("query", query).put("limit", LIMIT)) { result ->
                    if (active) { remote = decodeHistory(result.getOrNull()); emit() }
                }
            }
        }
        return { active = false; cancelDebounce(); cancels.forEach { it() } }
    }

    companion object {
        const val DEBOUNCE_MS = 120L
        const val LIMIT = 6

        private fun normalized(url: String): String? = UrlRules.webUrl(url)?.takeUnless(UrlRules::isAssetOrigin)

        // Match the home bridge's fragment-insensitive URL comparison. Keep path/query case intact.
        private fun key(url: String): String {
            val uri = URI(url).normalize()
            val authority = uri.rawAuthority.lowercase(Locale.ROOT).let {
                when (uri.scheme) { "https" -> it.removeSuffix(":443"); "http" -> it.removeSuffix(":80"); else -> it }
            }
            return "${uri.scheme}://$authority${uri.rawPath}${uri.rawQuery?.let { "?$it" }.orEmpty()}"
        }

        fun decodeBookmarks(data: Any?): List<Suggestion> {
            val array = data as? JSONArray ?: return emptyList()
            return (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                val url = normalized(item.opt("url") as? String ?: return@mapNotNull null) ?: return@mapNotNull null
                val title = item.opt("title") as? String ?: return@mapNotNull null
                Suggestion(url, title.ifBlank { UrlRules.host(url) }, true)
            }
        }

        fun decodeHistory(data: Any?): List<Suggestion> {
            val array = data as? JSONArray ?: return emptyList()
            return (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                val url = normalized(item.opt("u") as? String ?: return@mapNotNull null) ?: return@mapNotNull null
                val title = item.opt("ti") as? String ?: return@mapNotNull null
                val device = item.opt("devName") as? String ?: return@mapNotNull null
                if (device.isBlank()) return@mapNotNull null
                Suggestion(url, title.ifBlank { UrlRules.host(url) }, deviceName = device.take(100))
            }
        }

        fun merge(bookmarks: List<Suggestion>, history: List<Suggestion>, remote: List<Suggestion> = emptyList()): List<Suggestion> {
            val seen = hashSetOf<String>()
            return (bookmarks.asSequence().map { it.copy(bookmark = true, deviceName = null) } +
                history.asSequence().map { it.copy(bookmark = false, deviceName = null) } + remote.asSequence().map { it.copy(bookmark = false) })
                .mapNotNull { item -> normalized(item.url)?.let { item.copy(url = it) } }
                .filter { seen.add(key(it.url)) }.take(LIMIT).toList()
        }
    }
}
