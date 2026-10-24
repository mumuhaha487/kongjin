package re.inc.kongjing.browser.core

import org.json.JSONArray
import org.json.JSONObject

data class Visit(val u: String, val ti: String, val at: Long, val incognito: Boolean = false) {
    fun json(): JSONObject = JSONObject().put("u", u).put("ti", ti).put("at", at)
}
data class OpenTab(val u: String, val ti: String, val active: Boolean, val incognito: Boolean = false) {
    fun json(): JSONObject = JSONObject().put("u", u).put("ti", ti).put("active", active)
}

/** UI thread. Durable visit outbox; coalesced tab snapshot. No call starts before ready(). */
class ContinuityPublisher(
    private val call: (String, JSONObject, (Result<Any>) -> Unit) -> Unit,
    private val schedule: (Long, () -> Unit) -> (() -> Unit),
    initialVisits: List<Visit> = emptyList(),
    private val save: (List<Visit>) -> Unit = {}
) {
    private val visits = initialVisits.filter { eligible(it.u, it.incognito) }.takeLast(5000).toMutableList()
    private var ready = false
    private var visitDue = visits.isNotEmpty()
    private var tabsDue = false
    private var inFlight = false
    private var tabRevision = 0L
    private var snapshot: JSONObject? = null
    private var cancelVisits: () -> Unit = {}
    private var cancelTabs: () -> Unit = {}

    fun record(visit: Visit) {
        if (!eligible(visit.u, visit.incognito)) return
        visits += visit
        // Bound memory/disk use while a homepage is unavailable; local browser history remains intact.
        if (visits.size > 5000 && !inFlight) visits.removeAt(0)
        save(visits.toList())
        visitDue = false
        cancelVisits()
        cancelVisits = schedule(2000) { visitDue = true; flushVisits() }
    }

    fun tabsChanged(tabs: List<OpenTab>, last: Visit?) {
        val available = tabs.filter { eligible(it.u, it.incognito) }
        val focused = available.firstOrNull { it.active } ?: available.lastOrNull { it.u == last?.u }
        val selected = available.take(200).toMutableList()
        if (focused != null && focused !in selected) { selected.removeAt(selected.lastIndex); selected += focused }
        val validLast = last?.takeIf { eligible(it.u, it.incognito) && selected.any { tab -> tab.u == it.u } }
        val next = JSONObject().put("tabs", JSONArray(selected.map { it.json() }))
            // BRIDGE requires an object. An empty URL is filtered by the homepage's safeSlot.
            .put("last", validLast?.json() ?: JSONObject().put("u", "").put("ti", "").put("at", 0))
        if (next.toString() == snapshot?.toString()) return
        snapshot = next
        tabRevision++
        tabsDue = false
        cancelTabs()
        cancelTabs = schedule(3000) { tabsDue = true; flushTabs() }
    }

    fun markReady() { ready = true; flushVisits(); flushTabs() }
    fun resetReady() { ready = false }
    fun clearVisits() { visits.clear(); save(emptyList()); visitDue = false; cancelVisits() }

    private fun flushVisits() {
        if (!ready || !visitDue || inFlight || visits.isEmpty()) return
        val batch = visits.take(50)
        inFlight = true
        call("recordVisits", JSONObject().put("visits", JSONArray(batch.map { it.json() }))) { result ->
            inFlight = false
            if (result.isSuccess) {
                // A local clear may have removed the batch while it was in flight.
                if (visits.take(batch.size) == batch) repeat(batch.size) { visits.removeAt(0) }
                save(visits.toList())
                // Post the next batch rather than recursing when a mock replies synchronously.
                if (visitDue) schedule(0) { flushVisits() }
            }
            // Error/timeout retains the outbox. A later visit/ready retries without a tight loop.
        }
    }

    private fun flushTabs() {
        if (!ready || !tabsDue) return
        val value = snapshot ?: return
        val revision = tabRevision
        tabsDue = false
        call("setOpenTabs", value) { if (it.isFailure && revision == tabRevision) tabsDue = true }
    }

    companion object {
        fun eligible(url: String, incognito: Boolean = false): Boolean = !incognito &&
            UrlRules.webUrl(url) != null && !UrlRules.isAssetOrigin(url)
    }
}
