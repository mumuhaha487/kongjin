package re.inc.kongjing.browser.core

import org.json.JSONObject

data class IncomingItem(val id: String, val from: String, val u: String?, val ti: String, val tx: String? = null, val at: Long = System.currentTimeMillis()) {
    fun json(): JSONObject = JSONObject().put("id", id).put("from", from).put("u", u ?: JSONObject.NULL)
        .put("ti", ti).put("tx", tx ?: JSONObject.NULL).put("at", at)
    companion object {
        fun decode(json: String): IncomingItem? = runCatching {
            require(json.length <= 32768)
            val obj = JSONObject(json)
            val id = obj.getString("id"); require(id.isNotBlank() && id.length <= 200)
            val from = obj.getString("from"); require(from.isNotBlank() && from.length <= 200)
            val rawUrl = obj.opt("u") as? String
            val url = rawUrl?.let { require(it.length <= 8192); UrlRules.webUrl(it)?.takeUnless(UrlRules::isAssetOrigin) ?: error("Invalid incoming URL") }
            val text = (obj.opt("tx") as? String)?.take(4000)
            require(url != null || !text.isNullOrBlank())
            val title = (obj.opt("ti") as? String).orEmpty().take(1000).ifBlank { url?.let(UrlRules::host) ?: text.orEmpty().take(120) }
            IncomingItem(id, from, url, title, text, obj.optLong("at", System.currentTimeMillis()))
        }.getOrNull()
    }
}

object IncomingRoute {
    const val ACTION = "re.inc.kongjing.browser.OPEN_INCOMING"
    const val EXTRA_ID = "incomingId"
    // Notification intents carry only an ID. Never trust a URL/ack ID supplied by another app.
    fun resolve(action: String?, id: String?, lookup: (String) -> IncomingItem?): IncomingItem? =
        if (action == ACTION && !id.isNullOrBlank()) lookup(id)?.takeIf { it.id == id && (it.u == null || ContinuityPublisher.eligible(it.u)) } else null
}

data class RelayDevice(val id: String, val name: String, val platform: String, val online: Boolean)
