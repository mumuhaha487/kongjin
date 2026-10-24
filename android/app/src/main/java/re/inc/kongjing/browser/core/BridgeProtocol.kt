package re.inc.kongjing.browser.core

import org.json.JSONObject

object BridgeProtocol {
    const val TIMEOUT_MS = 5_000L
    val methods = setOf("getGroups", "findBookmark", "addBookmark", "removeBookmark", "openSettings", "getSearchTemplate", "getTheme", "searchBookmarks",
        "recordVisits", "setOpenTabs", "getDevices", "sendToDevice", "searchHistory", "openRelay", "pendingIncoming", "markIncomingRead", "setVisible",
        "scrollToTop", "addReadLater", "pairWithCode", "browserPrefsChanged")
    fun script(id: String, method: String, args: JSONObject): String {
        require(method in methods)
        return "window.kongjing.call(${JSONObject.quote(id)},${JSONObject.quote(method)},${JSONObject.quote(args.toString())})"
    }
    fun decode(json: String): Result<Any> = runCatching {
        require(json.length <= 1_048_576) { "BRIDGE 响应过大" }
        val obj = JSONObject(json)
        if (!obj.getBoolean("ok")) error(obj.optString("error", "主页调用失败"))
        obj.opt("data") ?: JSONObject()
    }
}

/** UI-thread dispatcher; scheduler is injected so queue, deadline and late replies can be tested. */
class BridgeDispatcher(
    private val send: (String) -> Unit,
    private val schedule: (Long, () -> Unit) -> (() -> Unit)
) {
    private data class Pending(val script: String, val callback: (Result<Any>) -> Unit, var cancel: () -> Unit = {})
    private val pending = linkedMapOf<String, Pending>()
    private var sequence = 0L
    private var ready = false

    fun call(method: String, args: JSONObject = JSONObject(), callback: (Result<Any>) -> Unit): () -> Unit {
        val id = "native-${++sequence}"
        val request = Pending(BridgeProtocol.script(id, method, args), callback)
        pending[id] = request
        request.cancel = schedule(BridgeProtocol.TIMEOUT_MS) {
            pending.remove(id)?.callback?.invoke(Result.failure(IllegalStateException("主页响应超时（5 秒），请重试")))
        }
        if (ready) send(request.script)
        return { pending.remove(id)?.cancel?.invoke(); Unit }
    }

    fun markReady() {
        if (ready) return
        ready = true
        pending.values.toList().forEach { send(it.script) }
    }

    fun reply(id: String, json: String) {
        val request = pending.remove(id) ?: return
        request.cancel()
        request.callback(BridgeProtocol.decode(json))
    }

    fun reset() {
        ready = false
        val requests = pending.values.toList()
        pending.clear()
        requests.forEach { it.cancel(); it.callback(Result.failure(IllegalStateException("主页已重新加载，请重试"))) }
    }
}
