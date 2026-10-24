package re.inc.kongjing.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.core.IncomingItem
import re.inc.kongjing.browser.core.Visit

/** App-private durable outboxes, independent from the homepage's IndexedDB. */
class ContinuityStore(context: Context) {
    private val prefs = context.getSharedPreferences("continuity", Context.MODE_PRIVATE)
    private val incoming = linkedMapOf<String, IncomingItem>()
    private val read = mutableSetOf<String>()
    private val acknowledgements = mutableSetOf<String>()
    init {
        runCatching {
            val array = JSONArray(prefs.getString("incoming", "[]"))
            for (i in 0 until array.length()) {
                val row = array.getJSONObject(i)
                val item = IncomingItem.decode(row.getJSONObject("item").toString()) ?: continue
                incoming[item.id] = item
                if (row.optBoolean("read")) read += item.id
                if (row.optBoolean("ack")) acknowledgements += item.id
            }
        }
    }
    fun visits(): List<Visit> = runCatching {
        val array = JSONArray(prefs.getString("visits", "[]"))
        (0 until array.length()).map { array.getJSONObject(it).let { v -> Visit(v.getString("u"), v.optString("ti"), v.getLong("at")) } }
    }.getOrDefault(emptyList())
    fun saveVisits(visits: List<Visit>) { prefs.edit().putString("visits", JSONArray(visits.map { it.json() }).toString()).apply() }
    fun get(id: String): IncomingItem? = incoming[id]
    fun isRead(id: String): Boolean = id in read
    fun add(item: IncomingItem) {
        if (item.id in incoming) return
        incoming[item.id] = item
        val expired = incoming.values.filter { it.at < System.currentTimeMillis() - 7 * 86400000L }.map { it.id }
        (expired + incoming.keys.take((incoming.size - 100).coerceAtLeast(0))).forEach { incoming.remove(it); read.remove(it); acknowledgements.remove(it) }
        persist()
    }
    fun markRead(id: String) { if (id in incoming) { read += id; acknowledgements += id; persist() } }
    fun pendingAcks(): List<String> = acknowledgements.toList()
    fun acked(id: String) { acknowledgements.remove(id); persist() }
    private fun persist() {
        val values = incoming.values.map { JSONObject().put("item", it.json()).put("read", it.id in read).put("ack", it.id in acknowledgements) }
        // Commit notification routes before publishing a PendingIntent (survives immediate process death).
        prefs.edit().putString("incoming", JSONArray(values).toString()).commit()
    }
}
