package re.inc.kongjing.browser.core

/** Native visibility signal precedes WebView pause; v3 home also suspends sync checks.
 * onPause does not call pauseTimers (which would affect every tab and pending sends).
 */
class HomeVisibility(
    private val notify: (Boolean) -> Unit,
    private val pause: () -> Unit,
    private val resume: () -> Unit
) {
    private var ready = false
    private var visible = false
    private var applied: Boolean? = null

    fun update(activityResumed: Boolean, homeSelected: Boolean, switcherOpen: Boolean) {
        val next = activityResumed && homeSelected && !switcherOpen
        if (applied == next) return
        visible = next
        // Old homes can reject UNKNOWN_METHOD; this optional signal never blocks native lifecycle.
        if (ready) notify(next)
        if (next) resume() else pause()
        applied = next
    }

    fun markReady() {
        if (ready) return
        ready = true
        notify(visible)
    }

    fun resetReady() { ready = false }
}

object TabPreviewSize {
    fun scaled(width: Int, height: Int): Pair<Int, Int>? =
        if (width <= 0 || height <= 0) null else (width / 3).coerceAtLeast(1) to (height / 3).coerceAtLeast(1)
}
