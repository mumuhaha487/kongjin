package re.inc.kongjing.browser.core

/** Main-thread lifecycle state, independent of Android so callback ordering is testable. */
class DefaultBrowserMonitor(private val read: () -> Boolean, private val notify: () -> Unit) {
    enum class Flow { SETTINGS, ROLE }
    private var pending: Flow? = null
    private var ready = false
    private var forcePending = false
    private var lastNotified: Boolean? = null

    fun begin(flow: Flow) { pending = flow }
    fun launchFailed() { pending = null }
    fun homeReset() { ready = false; lastNotified = null }
    fun homeReady() { ready = true; publish() }
    fun resumed() {
        if (pending == Flow.ROLE) return // The result callback owns this flow, in either lifecycle order.
        val returned = pending == Flow.SETTINGS
        pending = null
        publish(returned)
    }
    fun roleResult() { pending = null; publish(true) }
    fun changed() { publish(true) }
    private fun publish(force: Boolean = false) {
        forcePending = forcePending || force
        if (!ready) return
        val current = read()
        if (forcePending || current != lastNotified) {
            notify()
            lastNotified = current
            forcePending = false
        }
    }
}
