package re.inc.kongjing.browser.ext.api

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView

/** Stable native integration contract. All methods are main-thread except intercept. */
data class TabHandle(val id: Int)
data class ExtensionTab(
    val id: Int, val url: String, val title: String = "", val active: Boolean = false,
    val status: String = "complete", val favIconUrl: String? = null, val index: Int = 0,
    val windowId: Int = 1, val incognito: Boolean = false,
)
data class TabQuery(val active: Boolean? = null, val currentWindow: Boolean? = null,
    val windowId: Int? = null, val urls: List<String> = emptyList(), val title: String? = null,
    val status: String? = null)
data class ExtensionFrame(val frameId: Int = 0, val parentFrameId: Int = -1,
    val documentId: String? = null)
data class ExtensionContextTarget(val tab: TabHandle, val pageUrl: String,
    val linkUrl: String? = null, val srcUrl: String? = null, val selectionText: String? = null,
    val frame: ExtensionFrame = ExtensionFrame())
data class ExtensionMenuItem(val extensionId: String, val id: String, val title: String,
    val enabled: Boolean = true, val checked: Boolean? = null)

/** Native adapter MUST filter out the homepage; ids remain stable until a tab is removed. */
interface TabController {
    val currentTabId: Int?
    fun query(query: TabQuery = TabQuery()): List<ExtensionTab>
    fun create(url: String, active: Boolean = true): ExtensionTab
    fun update(tabId: Int, url: String? = null, active: Boolean? = null): ExtensionTab
    fun remove(tabId: Int)
    fun reload(tabId: Int, bypassCache: Boolean = false)
}

interface ExtensionHost {
    val supported: Boolean
    fun attach(tab: TabHandle, webView: WebView)
    fun detach(tab: TabHandle)
    /** WebView IO thread. Must not touch views or block on the main thread. */
    fun intercept(tab: TabHandle, request: WebResourceRequest): WebResourceResponse?
    fun onNavigationStarted(tab: TabHandle, url: String, frame: ExtensionFrame = ExtensionFrame()) {}
    fun onNavigationCommitted(tab: TabHandle, url: String, frame: ExtensionFrame = ExtensionFrame()) {}
    fun onNavigationDomContentLoaded(tab: TabHandle, url: String, frame: ExtensionFrame = ExtensionFrame()) {}
    fun onNavigationCompleted(tab: TabHandle, url: String, frame: ExtensionFrame = ExtensionFrame()) {}
    fun onNavigationHistoryStateUpdated(tab: TabHandle, url: String, frame: ExtensionFrame = ExtensionFrame()) {}
    fun onTabCreated(tab: ExtensionTab) {}
    fun onTabActivated(tab: TabHandle) {}
    fun onTabRemoved(tab: TabHandle) {}
    fun onTabUpdated(tab: ExtensionTab, changed: Set<String>) {}
    fun contextMenuItems(target: ExtensionContextTarget): List<ExtensionMenuItem> = emptyList()
    fun clickContextMenu(item: ExtensionMenuItem, target: ExtensionContextTarget) {}
    fun setForeground(foreground: Boolean) {}
    fun destroy() {}
}

/** Compile-safe placeholder while the native UI and runtime are developed independently. */
object NoopExtensionHost : ExtensionHost {
    override val supported = false
    override fun attach(tab: TabHandle, webView: WebView) = Unit
    override fun detach(tab: TabHandle) = Unit
    override fun intercept(tab: TabHandle, request: WebResourceRequest): WebResourceResponse? = null
}
