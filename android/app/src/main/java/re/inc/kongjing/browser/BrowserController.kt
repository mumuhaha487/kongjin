package re.inc.kongjing.browser

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.core.BridgeDispatcher
import re.inc.kongjing.browser.core.AddressSuggestions
import re.inc.kongjing.browser.core.TabPolicy
import re.inc.kongjing.browser.core.TabUsage
import re.inc.kongjing.browser.core.UrlRules
import re.inc.kongjing.browser.core.HomeInsets
import re.inc.kongjing.browser.core.HomeVisibility
import re.inc.kongjing.browser.core.PageSecurity
import re.inc.kongjing.browser.core.TabPreviewSize
import re.inc.kongjing.browser.core.ContinuityPublisher
import re.inc.kongjing.browser.core.Visit
import re.inc.kongjing.browser.core.VisitTitleTracker
import re.inc.kongjing.browser.core.OpenTab
import re.inc.kongjing.browser.core.IncomingItem
import re.inc.kongjing.browser.core.IncomingRoute
import re.inc.kongjing.browser.core.RelayDevice
import java.io.ByteArrayInputStream
import java.util.Locale
import kotlin.math.abs

data class ContextTarget(val link: String?, val image: String?, val selection: String? = null)
data class SiteConsent(val origin: String, val purpose: String, val permissions: List<String>, val complete: (Boolean) -> Unit)

class BrowserController(val activity: MainActivity) {
    val store = BrowserStore(activity)
    val extras = BrowserExtras(this)
    val extensions = NativeExtensions(this)
    private val toolbarScroll = re.inc.kongjing.browser.core.ToolbarScrollPolicy()
    private val main = Handler(Looper.getMainLooper())
    val tabs = mutableStateListOf<BrowserTab>()
    var activeId by mutableStateOf("")
    val active: BrowserTab get() = tabs.first { it.id == activeId }
    var dark by mutableStateOf(store.prefs.getBoolean("dark", activity.resources.configuration.uiMode and 0x30 == 0x20))
    var showTabs by mutableStateOf(false)
    var sheet by mutableStateOf<String?>(null)
    var contextTarget by mutableStateOf<ContextTarget?>(null)
    var externalUrl by mutableStateOf<String?>(null)
    var consent by mutableStateOf<SiteConsent?>(null)
    var toolbarHidden by mutableStateOf(false)
    var find by mutableStateOf(false)
    var findCount by mutableIntStateOf(0)
    var findIndex by mutableIntStateOf(0)
    var fullScreen by mutableStateOf(false)
    var bookmarked by mutableStateOf(false)
    var bookmarkId by mutableStateOf<String?>(null)
    var groups by mutableStateOf<List<Pair<String, String>>>(emptyList())
    var devices by mutableStateOf<List<RelayDevice>>(emptyList())
    var devicesLoading by mutableStateOf(false)
    var devicesError by mutableStateOf<String?>(null)
    var sendingDevice by mutableStateOf<String?>(null)
    private var sendTarget: Pair<String, String>? = null
    var incomingBanner by mutableStateOf<IncomingItem?>(null)
        private set
    private var foreground = false
    private var homeReady = false
    private var activityResumed = false
    private val incomingQueue = ArrayDeque<IncomingItem>()
    private val presented = mutableSetOf<String>()
    private val notified = mutableSetOf<String>()
    private val ackInFlight = mutableSetOf<String>()
    private var cancelBanner: () -> Unit = {}
    private val continuityStore = ContinuityStore(activity)
    private val notifications = IncomingNotifications(activity)
    var searchTemplate = store.prefs.getString("searchTemplate", UrlRules.DEFAULT_SEARCH) ?: UrlRules.DEFAULT_SEARCH
        private set
    private val views = linkedMapOf<String, WebView>()
    val container = FrameLayout(activity)
    private var displayed: WebView? = null
    private var destroyed = false
    private var historyEpoch = 0L
    @Volatile private var homeInsets = HomeInsets()
    private var lastBack = 0L
    private val homeAssets = WebViewAssetLoader.AssetsPathHandler(activity)
    private val assetLoader = WebViewAssetLoader.Builder()
        .addPathHandler("/home/") { path -> homeAssets.handle("home/$path") }.build()
    lateinit var homeView: WebView
        private set
    val bridge = BridgeDispatcher(send = { script ->
        if (!destroyed) homeView.evaluateJavascript(script, null)
    }, schedule = ::scheduleOnMain)
    val addressSuggestions = AddressSuggestions(bridge,
        history = { query, callback -> store.historySuggestions(query) { items -> post { callback(items) } } },
        schedule = ::scheduleOnMain)
    private val homeVisibility = HomeVisibility(
        notify = { visible -> bridge.call("setVisible", JSONObject().put("visible", visible)) { /* optional on older homes */ } },
        pause = { homeView.onPause() }, resume = { homeView.onResume() })
    private val continuity = ContinuityPublisher(call = { method, args, callback -> bridge.call(method, args, callback); Unit },
        schedule = ::scheduleOnMain, initialVisits = continuityStore.visits(), save = continuityStore::saveVisits)

    private fun scheduleOnMain(delay: Long, block: () -> Unit): () -> Unit {
        val runnable = Runnable(block)
        main.postDelayed(runnable, delay)
        return { main.removeCallbacks(runnable) }
    }

    init {
        store.session().forEach { saved -> tabs += BrowserTab(saved.id, saved.url, saved.title, saved.desktop).also { tab ->
            if (saved.lastUsed > 0) tab.lastUsed = saved.lastUsed
            tab.preview = store.preview(saved.id); tab.icon = store.icon(saved.url)
        } }
        if (tabs.isEmpty()) tabs += BrowserTab()
        activeId = store.prefs.getString("active", tabs.first().id).takeIf { id -> tabs.any { it.id == id } } ?: tabs.first().id
        active.lastUsed = System.currentTimeMillis()
        homeView = createView(null, true)
        homeView.addJavascriptInterface(NativeBridge(), "KongjingNative")
        container.addView(homeView, FrameLayout.LayoutParams(-1, -1))
        homeView.loadUrl(UrlRules.HOME)
        display()
    }

    fun toast(message: String) = Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
    private fun post(block: () -> Unit) { main.post { if (!destroyed) block() } }
    private fun tabFor(view: WebView): BrowserTab? = if (view === homeView) tabs.firstOrNull { it.id == activeId && it.home }
        else views.entries.firstOrNull { it.value === view }?.let { entry -> tabs.firstOrNull { it.id == entry.key } }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createView(tab: BrowserTab?, home: Boolean = false): WebView = BrowserPageView(
        if (home) activity else android.view.ContextThemeWrapper(activity,
            if (extras.darkEnabled()) R.style.Theme_Kongjing_WebDark else R.style.Theme_Kongjing),
        { !home && extensions.host.supported }, { selection -> contextTarget=ContextTarget(null,null,selection);sheet="context" }
    ).apply {
        // Capture the immutable handle on main; interception runs on WebView's IO thread.
        val extensionTab=if(!home && tab!=null)extensions.handle(tab)else null
        val visitTitles = VisitTitleTracker()
        var visitEpoch = historyEpoch
        setBackgroundColor(if (home) { if (dark) 0xff070b16.toInt() else 0xfff3f6fa.toInt() } else android.graphics.Color.WHITE)
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(true)
            mediaPlaybackRequiresUserGesture = true
            builtInZoomControls = !home
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            offscreenPreRaster = false
            setGeolocationEnabled(!home)
            if (tab?.desktop == true) userAgentString = desktopAgent(userAgentString)
        }
        if (!home) { tag=extras.darkEnabled(); extras.apply(this); extras.attachPull(this) }
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (extensionTab != null) extensions.host.intercept(extensionTab, request)?.let { return it }
                val url = request.url.toString()
                if (home && request.isForMainFrame && !UrlRules.isHome(url)) {
                    post { navigate(url, true) }
                    return blockedResponse()
                }
                if (home && UrlRules.isHome(url)) {
                    val response = assetLoader.shouldInterceptRequest(Uri.parse(url))
                    if (response != null) {
                        // Adapt only the served response; packaged assets stay byte-for-byte intact.
                        if (response.mimeType == "text/html" || response.mimeType == "text/css") {
                            val original = response.data.bufferedReader(Charsets.UTF_8).use { it.readText() }
                            val adapted = if (response.mimeType == "text/css") HomeInsets.adaptCss(original) else homeInsets.html(original)
                            response.data = ByteArrayInputStream(adapted.toByteArray(Charsets.UTF_8))
                        }
                        response.responseHeaders = (response.responseHeaders ?: emptyMap()) + mapOf(
                            "Content-Security-Policy" to "frame-src 'none'; object-src 'none'; base-uri 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
                            "X-Content-Type-Options" to "nosniff",
                            "Cache-Control" to "no-cache"
                        )
                        return response
                    }
                }
                if (UrlRules.isAssetOrigin(url)) return blockedResponse()
                return null
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (home) {
                    if (UrlRules.isHome(url)) return false
                    if (request.isForMainFrame) navigate(url, true)
                    return true
                }
                if (UrlRules.isAssetOrigin(url)) return true
                if (UrlRules.webUrl(url) != null) return false
                if (request.isForMainFrame && request.hasGesture() && UrlRules.externalAllowed(url)) externalUrl = url
                return true
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if(!home && tab!=null && url!=null) extensions.host.onNavigationStarted(extensions.handle(tab),url)
                if (!home) {
                    tab?.error = null
                    tab?.secure = false
                    view.alpha = 1f
                    visitTitles.clear()
                    visitEpoch = historyEpoch
                    if (url != null) visitTitles.started(url, tab?.incognito == true)
                }
                if (home) {
                    extras.defaultBrowser.homeReset()
                    homeReady = false
                    homeVisibility.resetReady()
                    continuity.resetReady()
                    bridge.reset()
                    if (url != null && !UrlRules.isHome(url)) { view.stopLoading(); view.loadUrl(UrlRules.HOME); return }
                }
                tabFor(view)?.let { t ->
                    t.progress = 0f
                    if (!home && url != null && UrlRules.webUrl(url) != null) {
                        if (UrlRules.host(t.url) != UrlRules.host(url)) {
                            t.icon = store.icon(url)
                            t.preview = null
                        }
                        t.url = url
                        t.title = UrlRules.host(url)
                    }
                    updateHistoryState(t,view)
                    if (t.id == activeId) { toolbarHidden = false; dismissSiteRequests() }
                }
                tab?.let { if(!home) extensions.updated(it) }; persist()
            }
            override fun onPageCommitVisible(view:WebView,url:String?) { if(!home && tab!=null && url!=null) extensions.host.onNavigationCommitted(extensions.handle(tab),url) }
            override fun onPageFinished(view: WebView, url: String?) {
                if (home && url != null && UrlRules.isHome(url)) view.evaluateJavascript(homeInsets.script(), null)
                tabFor(view)?.let { t ->
                    updateHistoryState(t,view); t.progress = 1f
                    if (!home) t.secure = PageSecurity.confirmed(t.url, url, view.url, view.certificate != null, t.error != null)
                    if (!home && t.error == null && !t.incognito && url != null && UrlRules.webUrl(url) != null && url == view.url) {
                        if (visitEpoch == historyEpoch) visitTitles.finished(url, System.currentTimeMillis())?.let { visit ->
                            store.visit(visit.u, visit.ti, visit.at)
                            continuity.record(visit)
                        }
                    }
                }
                if(!home && tab!=null) { toolbarScroll.reset(); if(tab.id==activeId)toolbarHidden=false; extensions.updated(tab); if(url!=null)extensions.host.onNavigationCompleted(extensions.handle(tab),url) }; persist()
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (!home && request.isForMainFrame) showPageError(view, tab, when(error.errorCode) {
                    ERROR_HOST_LOOKUP -> "找不到这个网站，请检查网址或网络连接"
                    ERROR_TIMEOUT -> "连接超时，请稍后重试"
                    ERROR_CONNECT -> "无法连接网站，请检查网络连接"
                    else -> "网页暂时无法加载，请检查网络后重试"
                })
            }
            override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
                handler.cancel()
                if (!home) showPageError(view,tab,"网站证书有误，为保护你的信息已阻止连接")
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG || BuildConfig.WEBVIEW_INSPECT) android.util.Log.d("KongjingWeb", "${message.messageLevel()}: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
            override fun onProgressChanged(view: WebView, newProgress: Int) { tabFor(view)?.let { val was=it.progress<1f; it.progress=newProgress/100f; if(!home && was!=(newProgress<100))extensions.updated(it) } }
            override fun onReceivedTitle(view: WebView, title: String?) {
                tabFor(view)?.let { t ->
                    t.title = if (home) "空境" else title.orEmpty().ifBlank { UrlRules.host(t.url) }
                    if (!home && !t.incognito && t.url == view.url && visitEpoch == historyEpoch)
                        visitTitles.receivedTitle(view.url, title)?.let { visit ->
                            store.updateVisitTitle(visit.u, visit.ti, visit.at)
                            continuity.record(visit)
                        }
                }
                tab?.let { if(!home)extensions.updated(it) }; publishTabs()
            }
            override fun onReceivedIcon(view: WebView, icon: Bitmap?) {
                if (!home && icon != null) tabFor(view)?.let { t ->
                    t.icon=icon
                    val capturedUrl=t.url
                    store.saveIcon(capturedUrl,icon) { data -> post {
                        if(t in tabs && t.url==capturedUrl) { t.faviconUrl=data;extensions.updated(t) }
                    } }
                }
            }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                if (!isUserGesture) return false
                val target = newPage(null)
                (resultMsg.obj as WebView.WebViewTransport).webView = target
                resultMsg.sendToTarget()
                return true
            }
            override fun onCloseWindow(window: WebView) { tabFor(window)?.let { closeTab(it.id) } }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                activity.chooseFiles(callback, params)
                return true
            }
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (displayed !== this@apply || fullScreen) { callback.onCustomViewHidden(); return }
                fullScreen = true; activity.enterVideo(view, callback)
            }
            override fun onHideCustomView() { activity.exitVideo(); fullScreen = false }
            override fun onPermissionRequest(request: PermissionRequest) {
                // DataChannel/RTCPeerConnection needs INTERNET only, never capture permission.
                // Keep all home camera/microphone requests denied; pairing uses data channels.
                post {
                    if (home || displayed !== this@apply || !UrlRules.sameOrigin(request.origin.toString(), url.orEmpty()) || !request.origin.toString().startsWith("https://")) {
                        request.deny(); return@post
                    }
                    val permissions = request.resources.mapNotNull {
                        when (it) { PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO; else -> null }
                    }
                    if (permissions.isEmpty()) { request.deny(); return@post }
                    val origin = request.origin.toString()
                    if (permissions.all { it in extras.grants(origin) && granted(it) }) { request.grant(request.resources.filter { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }.toTypedArray()); return@post }
                    consent?.complete?.invoke(false)
                    consent = SiteConsent(origin, "摄像头 / 麦克风", permissions) { approved ->
                        val grants = request.resources.filter {
                            approved && displayed === this@apply && UrlRules.sameOrigin(url.orEmpty(), origin) &&
                                when (it) {
                                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted(Manifest.permission.CAMERA)
                                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted(Manifest.permission.RECORD_AUDIO)
                                    else -> false
                                }
                        }
                        if (grants.isEmpty()) request.deny() else { extras.grant(origin,permissions.filter(::granted)); request.grant(grants.toTypedArray()) }
                    }
                }
            }
            override fun onPermissionRequestCanceled(request: PermissionRequest) { post { consent = null } }
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (home || displayed !== this@apply || !origin.startsWith("https://") || !UrlRules.sameOrigin(origin, url.orEmpty())) {
                    callback.invoke(origin, false, false); return
                }
                consent?.complete?.invoke(false)
                if (Manifest.permission.ACCESS_COARSE_LOCATION in extras.grants(origin) && granted(Manifest.permission.ACCESS_COARSE_LOCATION)) { callback.invoke(origin,true,false); return }
                consent = SiteConsent(origin, "位置信息", listOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)) { approved ->
                    val allow = approved && displayed === this@apply && UrlRules.sameOrigin(url.orEmpty(), origin) && granted(Manifest.permission.ACCESS_COARSE_LOCATION)
                    if (allow) extras.grant(origin,listOf(Manifest.permission.ACCESS_COARSE_LOCATION))
                    callback.invoke(origin, allow, false)
                }
            }
            override fun onGeolocationPermissionsHidePrompt() { consent = null }
        }
        setFindListener { index, count, _ -> findIndex = if (count == 0) 0 else index + 1; findCount = count }
        setOnScrollChangeListener { _, _, scrollY, _, oldScrollY ->
            if (!home && displayed === this@apply) toolbarScroll.update(scrollY/activity.resources.displayMetrics.density, oldScrollY/activity.resources.displayMetrics.density, false, find || sheet!=null || showTabs)?.let { toolbarHidden=it }
        }
        setOnLongClickListener {
            if (home) return@setOnLongClickListener false
            val hit = hitTestResult
            val target = when (hit.type) {
                WebView.HitTestResult.SRC_ANCHOR_TYPE -> ContextTarget(hit.extra, null)
                WebView.HitTestResult.IMAGE_TYPE -> ContextTarget(null, hit.extra)
                WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> {
                    val msg = main.obtainMessage()
                    msg.target = Handler(Looper.getMainLooper()) { result ->
                        contextTarget = ContextTarget(result.data.getString("url"), result.data.getString("src") ?: hit.extra)
                        sheet = "context"; true
                    }
                    requestFocusNodeHref(msg)
                    return@setOnLongClickListener true
                }
                else -> null
            }
            if (target != null) { haptic("light"); contextTarget = target; sheet = "context"; true } else false
        }
        setDownloadListener { url, agent, disposition, mime, _ -> download(url, agent, disposition, mime) }
        if(!home && tab!=null) extensions.attach(tab,this)
    }

    private fun blockedResponse() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    private fun granted(permission: String) = ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED
    private fun desktopAgent(agent: String) = agent.replaceFirst(Regex("\\([^)]*\\)"), "(X11; Linux x86_64)")
        .replace("Version/4.0 ", "").replace(Regex("\\bMobile\\s*"), "")
    fun view(): WebView = if (active.home) homeView else views.getValue(activeId)
    fun updateHomeInsets(insets: HomeInsets) {
        if (homeInsets == insets || destroyed) return
        homeInsets = insets
        homeView.evaluateJavascript(insets.script(), null)
    }
    fun display() {
        if (destroyed || tabs.none { it.id == activeId }) return
        val target = if (active.home) homeView else views[activeId] ?: run {
            trim(reserve = 1)
            createView(active).also { views[activeId] = it; it.loadUrl(active.url) }
        }
        if (displayed !== target) {
            displayed?.let { previous -> if (previous !== homeView) container.removeView(previous) }
            if (target !== homeView) {
                (target.parent as? ViewGroup)?.removeView(target)
                container.addView(target, FrameLayout.LayoutParams(-1, -1))
            }
            homeView.visibility = if (target === homeView) View.VISIBLE else View.INVISIBLE
            displayed = target
        }
        trim()
        updateHomeVisibility()
    }
    fun updateHomeVisibility() {
        if (!destroyed) homeVisibility.update(activityResumed, active.home, showTabs)
    }
    private fun trim(reserve: Int = 0) {
        val usage = views.keys.mapNotNull { id -> tabs.firstOrNull { it.id == id }?.let { TabUsage(id, it.lastUsed) } }
        TabPolicy.victims(usage, activeId, TabPolicy.MAX_WEBVIEWS - 1 - reserve).forEach { id -> views.remove(id)?.let { v ->
            tabs.firstOrNull { it.id==id }?.let(extensions::detach); (v.parent as? ViewGroup)?.removeView(v); v.stopLoading(); v.destroy()
        } }
    }
    fun onMemoryPressure() {
        views.keys.filter { it != activeId }.toList().forEach { id -> views.remove(id)?.let { v -> tabs.firstOrNull{it.id==id}?.let(extensions::detach); v.destroy() } }
        tabs.filter { it.id != activeId }.forEach { it.preview = null; it.icon = null }
    }
    fun openTabSwitcher() {
        captureCurrentPreview()
        showTabs = true
        updateHomeVisibility()
    }
    private fun captureCurrentPreview() {
        val tab = active
        val webView = view()
        val (width, height) = TabPreviewSize.scaled(webView.width, webView.height) ?: return
        runCatching {
            val scale = width.toFloat() / webView.width
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap); canvas.scale(scale, scale); webView.draw(canvas)
            tab.preview = bitmap; store.savePreview(tab.id, bitmap)
        }
    }
    fun select(id: String) {
        if (id == activeId) { showTabs = false; return }
        dismissSiteRequests(); closeFind()
        activeId = id; active.lastUsed = System.currentTimeMillis()
        toolbarHidden = false; toolbarScroll.reset(); showTabs = false; display(); extensions.activated(active); persist()
    }
    fun newTab() {
        dismissSiteRequests(); closeFind()
        val tab = BrowserTab(); tabs += tab; activeId = tab.id
        toolbarHidden = false; toolbarScroll.reset(); showTabs = false; display(); extensions.activated(active); persist()
    }
    private fun newPage(url: String?): WebView {
        dismissSiteRequests(); closeFind()
        val tab = BrowserTab(initialUrl = url ?: "about:blank", initialTitle = "新标签页")
        tabs += tab; activeId = tab.id; showTabs = false; toolbarHidden = false
        trim(reserve = 1)
        val web = createView(tab); views[tab.id] = web
        display(); extensions.activated(tab); if (url != null) web.loadUrl(url); persist()
        return web
    }
    fun createExtensionPage(url:String, makeActive:Boolean):BrowserTab {
        val previous=activeId
        val tab=BrowserTab(initialUrl=url, initialTitle="新标签页"); tabs+=tab
        if(makeActive){activeId=tab.id; showTabs=false; toolbarHidden=false}
        val web=createView(tab); views[tab.id]=web; web.loadUrl(url)
        if(!makeActive)activeId=previous
        display(); if(makeActive)extensions.activated(tab); persist();return tab
    }
    fun loadExtensionTab(tab:BrowserTab,url:String) {
        tab.url=url
        val web=views[tab.id] ?: createView(tab).also{views[tab.id]=it}; web.loadUrl(url);persist()
    }
    fun reloadExtensionTab(tab:BrowserTab,bypassCache:Boolean) {
        val web=views[tab.id] ?: createView(tab).also{views[tab.id]=it;it.loadUrl(tab.url)}
        if(bypassCache)web.clearCache(false);web.reload()
    }
    fun closeTab(id: String, undo: Boolean = true) {
        val index = tabs.indexOfFirst { it.id == id }; if (index < 0) return
        val previousActive=activeId
        extras.closed(tabs[index],undo)
        if (id == activeId) { dismissSiteRequests(); closeFind() }
        extensions.detach(tabs[index]); extensions.removed(tabs[index])
        views.remove(id)?.let { v -> container.removeView(v); if (displayed === v) displayed = null; v.stopLoading(); v.destroy() }
        tabs.removeAt(index); store.deletePreview(id)
        if (tabs.isEmpty()) tabs += BrowserTab()
        if (activeId == id) { activeId = tabs[index.coerceAtMost(tabs.lastIndex)].id; active.lastUsed = System.currentTimeMillis() }
        toolbarHidden = false; display(); if(activeId!=previousActive)extensions.activated(active); persist()
    }
    fun navigate(input: String, newTab: Boolean = false) {
        val url = UrlRules.webUrl(input)
        if (url == null) { if (UrlRules.externalAllowed(input)) externalUrl = input; return }
        if (UrlRules.isAssetOrigin(url)) return
        sheet = null; showTabs = false; toolbarHidden = false; closeFind(); dismissSiteRequests()
        if (newTab) { newPage(url); return }
        if (active.home) {
            active.url = url; active.title = UrlRules.host(url)
            display(); extensions.activated(active); persist()
        } else { view().loadUrl(url) }
    }
    fun submit(value: String) { if (value.isNotBlank()) { if(UrlRules.addressUrl(value)==null)store.rememberSearch(value); navigate(UrlRules.resolve(value, searchTemplate)) } }
    fun home() {
        val existing = tabs.firstOrNull { it.home }
        if (existing != null) select(existing.id) else newTab()
    }
    /** Toolbar Home replaces this tab; internal settings may still reuse a home tab. */
    fun goHome() {
        sheet = null; showTabs = false; toolbarHidden = false; closeFind(); dismissSiteRequests()
        if (active.home) { bridge.call("scrollToTop") { if (it.isFailure) homeView.evaluateJavascript("window.scrollTo(0,0)",null) }; return }
        extensions.detach(active); extensions.removed(active)
        views.remove(activeId)?.let { v -> container.removeView(v); if (displayed === v) displayed = null; v.stopLoading(); v.destroy() }
        active.url = UrlRules.HOME; active.title = "空境"; active.error = null; active.progress = 1f
        active.canBack = false; active.canForward = false; active.icon = null; display(); persist()
    }
    fun applyWebPrefs() {
        // Target 33+ WebViews derive prefers-color-scheme from isLightTheme, and ignore FORCE_DARK.
        // Recreate only when the algorithmic path needs a different context theme; preserve history.
        val modern=androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.ALGORITHMIC_DARKENING)
        views.toMap().forEach { (id,web) ->
            if(modern && web.tag != extras.darkEnabled()) {
                val tab=tabs.firstOrNull { it.id==id } ?: return@forEach
                val state=android.os.Bundle(); web.saveState(state)
                container.removeView(web); if(displayed===web) displayed=null
                extensions.detach(tab); web.stopLoading(); web.destroy()
                val replacement=createView(tab); views[id]=replacement
                if(replacement.restoreState(state)==null) replacement.loadUrl(tab.url)
            } else extras.apply(web)
        }
        display()
    }
    private fun updateHistoryState(tab: BrowserTab, web: WebView) {
        val list=web.copyBackForwardList()
        tab.canBack=list.currentIndex>0; tab.canForward=list.currentIndex in 0 until list.size-1
    }
    fun navigateHistory(offset: Int) {
        if(active.home) return
        val web=view(); val list=web.copyBackForwardList(); val index=list.currentIndex; val url=web.url
        if (!re.inc.kongjing.browser.core.BrowserFeatures.historyTarget(index,list.size,offset)) return
        sheet=null; web.goBackOrForward(offset)
        // Some older emulator WebViews expose a valid history list but ignore native history APIs.
        // Use the page's standard history only if the original navigation is still unchanged.
        scheduleOnMain(250) {
            if(!destroyed && displayed===web && web.url==url && web.copyBackForwardList().currentIndex==index)
                web.evaluateJavascript("History.prototype.go.call(history,$offset)",null)
        }
    }
    private fun showPageError(view: WebView, tab: BrowserTab?, reason: String) {
        tab?.let { it.error=reason; it.secure=false; it.progress=1f; it.title=UrlRules.host(it.url) }
        view.alpha=0f
    }
    fun retryPage() { active.error=null; view().alpha=1f; view().loadUrl(active.url) }
    fun settings(section: String? = null) {
        sheet = null; home()
        val args = JSONObject(); section?.let { args.put("section", it) }
        bridge.call("openSettings", args) { it.exceptionOrNull()?.let { e -> toast(e.message ?: "打开设置失败") } }
    }
    fun openRelay(tab: String = "history") {
        sheet = null; home()
        bridge.call("openRelay", JSONObject().put("tab", tab)) { result ->
            result.exceptionOrNull()?.let { toast(it.message ?: "无法打开接力") }
        }
    }
    private fun loadDevices(callback: ((Boolean) -> Unit)? = null) {
        bridge.call("getDevices") { result ->
            val array = result.getOrNull() as? JSONArray
            if (array != null) devices = (0 until array.length()).mapNotNull { index ->
                val row = array.optJSONObject(index) ?: return@mapNotNull null
                val id = row.optString("deviceId"); val name = row.optString("name")
                if (id.isBlank() || name.isBlank()) null else RelayDevice(id.take(200), name.take(100), row.optString("platform"), row.optBoolean("online"))
            }.distinctBy { it.id }
            callback?.invoke(array != null)
        }
    }
    fun openSendDevices() {
        if (active.home || active.incognito || UrlRules.webUrl(active.url) == null) return
        sendTarget = active.url to active.title
        devicesLoading = true; devicesError = null; sendingDevice = null; sheet = "devices"
        loadDevices { success ->
            devicesLoading = false
            if (!success) devicesError = "无法获取设备，请重试"
        }
    }
    fun sendToDevice(device: RelayDevice) {
        val target = sendTarget ?: return
        if (sendingDevice != null) return
        sendingDevice = device.id
        bridge.call("sendToDevice", JSONObject().put("deviceId", device.id).put("url", target.first).put("title", target.second)) { result ->
            sendingDevice = null
            if (result.isSuccess) {
                sheet = null; haptic("success")
                toast(if (device.online) "已发送到 ${device.name}" else "已发送到 ${device.name}，上线后送达")
            } else devicesError = result.exceptionOrNull()?.message ?: "发送失败，请重试"
        }
    }
    fun incomingFrom(item: IncomingItem): String = devices.firstOrNull { it.id == item.from }?.name ?: item.from
    fun receiveIncoming(item: IncomingItem) {
        continuityStore.add(item)
        if (continuityStore.isRead(item.id)) return
        if (foreground) {
            if (!presented.add(item.id)) return
            if (incomingQueue.size < 20) incomingQueue.addLast(item)
            showNextIncoming()
        } else if (notified.add(item.id)) notifications.show(item, incomingFrom(item))
    }
    private fun showNextIncoming() {
        if (!foreground || incomingBanner != null || incomingQueue.isEmpty()) return
        incomingBanner = incomingQueue.removeFirst()
        cancelBanner = scheduleOnMain(5000) { dismissIncoming() }
    }
    fun dismissIncoming() { cancelBanner(); incomingBanner = null; showNextIncoming() }
    fun setForeground(value: Boolean) {
        extensions.host.setForeground(value)
        foreground = value
        if (!value) {
            incomingBanner?.let { if (notified.add(it.id)) notifications.show(it, incomingFrom(it)) }
            incomingQueue.forEach { if (notified.add(it.id)) notifications.show(it, incomingFrom(it)) }
            incomingQueue.clear(); cancelBanner(); incomingBanner = null
        } else showNextIncoming()
    }
    fun openIncoming(item: IncomingItem) {
        if (continuityStore.get(item.id) == null) return
        continuityStore.markRead(item.id); notifications.cancel(item.id)
        incomingQueue.removeAll { it.id == item.id }
        if (incomingBanner?.id == item.id) dismissIncoming()
        if (item.u != null) navigate(item.u, true) else openRelay("devices")
        flushIncomingAcks()
    }
    fun notificationIntent(intent: Intent): Boolean {
        val item = IncomingRoute.resolve(intent.action, intent.getStringExtra(IncomingRoute.EXTRA_ID), continuityStore::get) ?: return false
        openIncoming(item); return true
    }
    private fun flushIncomingAcks() {
        if (!homeReady) return
        val ids = continuityStore.pendingAcks().filterNot { it in ackInFlight }
        if (ids.isEmpty()) return
        ackInFlight.addAll(ids)
        bridge.call("markIncomingRead", JSONObject().put("ids", JSONArray(ids))) { result ->
            ackInFlight.removeAll(ids.toSet())
            if (result.isSuccess) ids.forEach(continuityStore::acked)
        }
    }
    fun back() {
        when {
            fullScreen -> { activity.exitVideo(); fullScreen = false }
            sheet != null -> sheet = null
            showTabs -> showTabs = false
            find -> closeFind()
            !active.home && view().copyBackForwardList().currentIndex>0 -> navigateHistory(-1)
            !active.home -> home()
            System.currentTimeMillis() - lastBack < 2000 -> activity.finish()
            else -> { lastBack = System.currentTimeMillis(); toast("再按一次退出") }
        }
    }
    fun forward() { navigateHistory(1) }
    fun refresh() { if (active.progress < 1f) view().stopLoading() else view().reload(); sheet = null }
    fun toggleDesktop() {
        if (active.home) return
        active.desktop = !active.desktop
        view().settings.userAgentString = if (active.desktop) desktopAgent(WebSettings.getDefaultUserAgent(activity)) else WebSettings.getDefaultUserAgent(activity)
        view().reload(); persist()
    }
    fun searchPage(query: String) { view().findAllAsync(query) }
    fun closeFind() { if (find) { view().clearMatches(); find = false; findCount = 0; findIndex = 0 } }
    fun openMenu() {
        toolbarHidden=false
        loadDevices()
        sheet = "menu"; bookmarked = false; bookmarkId = null
        if (!active.home) {
            val tab = active; val url = tab.url
            bridge.call("findBookmark", JSONObject().put("url", url)) { result ->
                val data = result.getOrNull() as? JSONObject ?: return@call
                if (activeId == tab.id && active.url == url) {
                    bookmarked = data.optBoolean("found"); bookmarkId = data.optString("id").ifBlank { null }
                    store.bookmark(url, tab.title, bookmarked)
                }
            }
        }
    }
    fun openBookmark() {
        if (active.home) { toast("这个页面无法收藏"); return }
        groups = emptyList(); sheet = "bookmark"
        bridge.call("getGroups") { result ->
            val data = result.getOrNull() as? JSONArray
            if (data != null) groups = (0 until data.length()).map { data.getJSONObject(it).let { g -> g.getString("id") to g.getString("name") } }
            else { sheet = null; toast(result.exceptionOrNull()?.message ?: "无法获取分组") }
        }
    }
    fun addBookmark(title: String, group: String?, callback: (Boolean) -> Unit) {
        val tab = active; val url = tab.url
        val args = JSONObject().put("url", url).put("title", title.ifBlank { UrlRules.host(url) })
        group?.let { args.put("groupId", it) }
        store.iconData(url).takeIf { it.isNotEmpty() }?.let { args.put("iconDataUrl", it) }
        bridge.call("addBookmark", args) { result ->
            if (result.isSuccess) { store.bookmark(url, title, true); bookmarked = true; haptic("success"); callback(true) }
            else { toast(result.exceptionOrNull()?.message ?: "收藏失败"); callback(false) }
        }
    }
    fun removeBookmark() {
        val id = bookmarkId ?: return
        val url = active.url; val title = active.title
        bridge.call("removeBookmark", JSONObject().put("id", id)) { result ->
            if (result.isSuccess) { store.bookmark(url, title, false); bookmarked = false; bookmarkId = null; toast("已移除收藏"); sheet = null }
            else toast(result.exceptionOrNull()?.message ?: "移除失败")
        }
    }
    fun share(url: String = active.url) {
        if (UrlRules.webUrl(url) == null) return
        activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, url) }, "分享链接"))
        sheet = null
    }
    fun copy(url: String) {
        (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("链接", url))
        toast("已复制链接"); sheet = null
    }
    fun openExternal(url: String) {
        externalUrl = null
        if (!UrlRules.externalAllowed(url) && UrlRules.webUrl(url) == null) return
        runCatching {
            val intent = if (url.startsWith("intent:", true)) Intent.parseUri(url, Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, Uri.parse(url))
            val destination = intent.dataString.orEmpty()
            if (UrlRules.webUrl(destination) == null && !UrlRules.externalAllowed(destination)) { toast("无法打开此协议"); return }
            intent.action = Intent.ACTION_VIEW
            intent.categories?.toList()?.forEach(intent::removeCategory)
            intent.component = null; intent.selector = null; intent.addCategory(Intent.CATEGORY_BROWSABLE)
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
            intent.clipData = null
            intent.replaceExtras(android.os.Bundle())
            // A normal https URL must not resolve back to this browser.
            if (UrlRules.webUrl(url) != null) {
                val chooser = Intent.createChooser(intent, "在其他应用中打开")
                chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(android.content.ComponentName(activity, MainActivity::class.java)))
                activity.startActivity(chooser)
            } else activity.startActivity(intent)
        }.onFailure { toast("未找到可打开此链接的应用") }
    }
    fun download(url: String, agent: String? = null, disposition: String? = null, mime: String? = null) {
        if (UrlRules.webUrl(url) == null || UrlRules.isAssetOrigin(url)) { toast("暂不支持此下载链接"); return }
        val action = {
            runCatching {
                val filename = re.inc.kongjing.browser.core.BrowserFeatures.safeFileName(URLUtil.guessFileName(url, disposition, mime))
                val request = DownloadManager.Request(Uri.parse(url)).setTitle(filename)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, filename)
                mime?.takeIf { it.isNotBlank() }?.let { request.setMimeType(it) }
                agent?.let { request.addRequestHeader("User-Agent", it) }
                CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
                val id = (activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                extras.trackDownload(id)
                toast("已开始下载，可在通知栏查看进度")
            }.onFailure { toast("下载失败：${it.localizedMessage}") }
            Unit
        }
        if (Build.VERSION.SDK_INT <= 28 && !granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) activity.requestPermissionsFor(listOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)) { if (granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) action() else toast("未获存储权限，无法保存下载") }
        else action()
        sheet = null
    }
    fun haptic(kind: String) {
        val feedback = if (Build.VERSION.SDK_INT >= 30) when (kind) {
            "success" -> HapticFeedbackConstants.CONFIRM
            "warning" -> HapticFeedbackConstants.REJECT
            else -> HapticFeedbackConstants.KEYBOARD_TAP
        } else HapticFeedbackConstants.KEYBOARD_TAP
        container.performHapticFeedback(feedback)
    }
    private fun clearData(kinds: String) {
        val array = runCatching { JSONArray(kinds) }.getOrNull() ?: return
        val values = (0 until array.length()).map { array.optString(it) }.toSet()
        if ("cookies" in values) { CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush() }; GeolocationPermissions.getInstance().clearAll() }
        if ("cache" in values) { homeView.clearCache(true); store.clearPreviews(); store.clearIcons(); tabs.forEach { it.preview = null; it.icon = null } }
        if ("history" in values) { historyEpoch++; continuity.clearVisits(); store.clearHistory(); views.values.forEach(WebView::clearHistory) }
        toast("已清除所选浏览数据")
    }
    private fun dismissSiteRequests() { consent?.complete?.invoke(false); consent = null; activity.cancelFileChooser() }
    private fun publishTabs() {
        if (tabs.isEmpty()) return
        val pages = tabs.filter { ContinuityPublisher.eligible(it.url, it.incognito) }
        val last = pages.maxByOrNull { it.lastUsed }?.let { Visit(it.url, it.title, it.lastUsed, it.incognito) }
        continuity.tabsChanged(pages.map { OpenTab(it.url, it.title, it.id == activeId, it.incognito) }, last)
    }
    fun persist() { store.saveSession(tabs.filterNot { it.incognito }.map { SavedTab(it.id, it.url, it.title, it.desktop, it.lastUsed) }, activeId); publishTabs() }
    fun pause() { activityResumed = false; updateHomeVisibility(); persist(); views.values.forEach(WebView::onPause); CookieManager.getInstance().flush() }
    fun resume() { activityResumed = true; updateHomeVisibility(); views.values.forEach(WebView::onResume); extras.defaultBrowser.resumed() }
    fun destroy() {
        extensions.host.destroy()
        extras.destroy()
        persist(); dismissSiteRequests(); destroyed = true; homeReady = false; continuity.resetReady(); bridge.reset()
        container.removeAllViews(); views.values.forEach(WebView::destroy); views.clear()
        homeView.removeJavascriptInterface("KongjingNative"); homeView.destroy()
        main.removeCallbacksAndMessages(null)
        store.io.execute { store.close() }; store.io.shutdown()
    }
    inner class NativeBridge {
        @JavascriptInterface fun appVersion(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun open(url: String, newTab: Boolean) { UrlRules.webUrl(url)?.takeUnless(UrlRules::isAssetOrigin)?.let { post { navigate(it, newTab) } } }
        @JavascriptInterface fun favicon(url: String): String = if (UrlRules.webUrl(url) != null) store.iconData(url) else ""
        @JavascriptInterface fun deviceName(): String {
            val manufacturer = Build.MANUFACTURER.replaceFirstChar { it.titlecase(Locale.ROOT) }
            val model = Build.MODEL
            return (if (model.startsWith(manufacturer, true)) model else "$manufacturer $model") + " · 空境"
        }
        @JavascriptInterface fun haptic(kind: String) { if (kind in setOf("light", "success", "warning")) post { this@BrowserController.haptic(kind) } }
        @JavascriptInterface fun setTheme(theme: String) { if (theme in setOf("light", "dark")) post { dark = theme == "dark"; store.prefs.edit().putBoolean("dark", dark).apply(); applyWebPrefs() } }
        @JavascriptInterface fun getBrowserPrefs(): String = extras.prefsJson()
        @JavascriptInterface fun setWebDarkMode(mode: String) { post { extras.setDark(mode) } }
        @JavascriptInterface fun setTextZoom(percent: Int) { post { extras.setZoom(percent) } }
        @JavascriptInterface fun requestDefaultBrowser() { post { extras.requestDefault() } }
        @JavascriptInterface fun scanQr() { post { extras.scan() } }
        @JavascriptInterface fun setSearchTemplate(tpl: String) { if (UrlRules.validTemplate(tpl)) post { searchTemplate = tpl; store.prefs.edit().putString("searchTemplate", tpl).apply() } }
        @JavascriptInterface fun clearBrowsingData(kinds: String) { if (kinds.length < 1024) post { clearData(kinds) } }
        @JavascriptInterface fun incoming(json: String) {
            IncomingItem.decode(json)?.let { item -> post { if (UrlRules.isHome(homeView.url.orEmpty())) receiveIncoming(item) } }
        }
        @JavascriptInterface fun requestNotificationPermission(): String = activity.requestNotificationPermissionBlocking()
        @JavascriptInterface fun ready() { post {
            if (!UrlRules.isHome(homeView.url.orEmpty())) return@post
            if (homeReady) return@post
            homeReady = true
            bridge.markReady()
            extras.defaultBrowser.homeReady()
            homeVisibility.markReady()
            continuity.markReady()
            loadDevices()
            flushIncomingAcks()
            bridge.call("pendingIncoming") { result ->
                (result.getOrNull() as? JSONArray)?.let { array ->
                    for (index in 0 until array.length()) IncomingItem.decode(array.optJSONObject(index)?.toString().orEmpty())?.let(::receiveIncoming)
                }
            }
            bridge.call("getSearchTemplate") { result -> (result.getOrNull() as? JSONObject)?.optString("template")?.let(::setSearchTemplate) }
            bridge.call("getTheme") { result -> (result.getOrNull() as? JSONObject)?.optString("theme")?.let(::setTheme) }
        } }
        @JavascriptInterface fun reply(id: String, json: String) { if (id.length <= 64 && json.length <= 1_048_576) post { bridge.reply(id, json) } }
    }
}
