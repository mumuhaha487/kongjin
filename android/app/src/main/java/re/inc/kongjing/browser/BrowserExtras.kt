package re.inc.kongjing.browser

import android.Manifest
import android.app.DownloadManager
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.MotionEvent
import android.webkit.WebView
import androidx.compose.runtime.*
import androidx.core.content.ContextCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.core.DefaultBrowserMonitor
import re.inc.kongjing.browser.core.BrowserFeatures
import re.inc.kongjing.browser.core.ClosedPage
import re.inc.kongjing.browser.core.ClosedPages
import re.inc.kongjing.browser.core.ScanTarget
import re.inc.kongjing.browser.core.UrlRules
import java.text.DateFormat
import java.util.Date

data class DownloadEntry(val id: Long, val name: String, val bytes: Long, val total: Long, val state: Int, val at: Long)
data class BackEntry(val offset: Int, val title: String, val url: String)
data class BrowserMessage(val text: String, val label: String? = null, val action: (() -> Unit)? = null)

/** Device-local browser services; deliberately separate from synced homepage preferences. */
class BrowserExtras(private val browser: BrowserController) {
    private val activity get() = browser.activity
    private val prefs get() = browser.store.prefs
    private val main = Handler(Looper.getMainLooper())
    var scanner by mutableStateOf(false)
    var clipboard by mutableStateOf<String?>(null)
    var pull by mutableFloatStateOf(0f)
    var message by mutableStateOf<BrowserMessage?>(null)
    var downloads by mutableStateOf<List<DownloadEntry>>(emptyList())
    var recent by mutableStateOf<List<ClosedPage>>(emptyList())
    var backEntries by mutableStateOf<List<BackEntry>>(emptyList())
    var deleteDownload by mutableStateOf<DownloadEntry?>(null)
    var confirmCloseAll by mutableStateOf(false)
    private var dismissMessage: Runnable? = null
    private val closed = ClosedPages(runCatching {
        val a = JSONArray(prefs.getString("recentClosed", "[]")); (0 until a.length()).map { a.getJSONObject(it).let { r -> ClosedPage(r.getString("url"),r.getString("title"),r.optBoolean("desktop")) } }
    }.getOrDefault(emptyList()))
    private val manager get() = activity.getSystemService(DownloadManager::class.java)
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID,-1) ?: return
            if (id !in downloadIds()) return
            refreshDownloads()
            downloads.firstOrNull { it.id == id && it.state == DownloadManager.STATUS_SUCCESSFUL }?.let { row ->
                notify("已下载 ${row.name}", "打开") { openDownload(row.id) }
            }
        }
    }
    init {
        recent = closed.list()
        ContextCompat.registerReceiver(activity,receiver,IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),ContextCompat.RECEIVER_EXPORTED)
    }
    fun notify(text: String, label: String? = null, action: (() -> Unit)? = null) {
        dismissMessage?.let(main::removeCallbacks)
        message = BrowserMessage(text,label,action)
        dismissMessage = Runnable { message = null }.also { main.postDelayed(it,5000) }
    }
    fun readClipboard() {
        clipboard = null
        if (!activity.hasWindowFocus()) return
        val manager = activity.getSystemService(ClipboardManager::class.java)
        if (!manager.hasPrimaryClip()) return
        clipboard = BrowserFeatures.clipboard(manager.primaryClip?.getItemAt(0)?.text?.toString())
    }
    fun prefsJson(): String = JSONObject().put("isDefault",isDefault()).put("darkMode",prefs.getString("webDarkMode","follow"))
        .put("darkSupported",darkSupported()).put("textZoom",BrowserFeatures.zoom(prefs.getInt("webTextZoom",100))).toString()
    fun darkSupported() = WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING) || WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)
    fun darkEnabled() = BrowserFeatures.darkEnabled(prefs.getString("webDarkMode","follow"),browser.dark)
    @Suppress("DEPRECATION")
    fun apply(web: WebView) {
        web.settings.textZoom = BrowserFeatures.zoom(prefs.getInt("webTextZoom",100))
        val enabled = darkEnabled()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings,enabled)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) WebSettingsCompat.setForceDark(web.settings,if (enabled) WebSettingsCompat.FORCE_DARK_ON else WebSettingsCompat.FORCE_DARK_OFF)
    }
    fun setDark(mode: String) { BrowserFeatures.dark(mode)?.let { prefs.edit().putString("webDarkMode",it).apply(); browser.applyWebPrefs() } }
    fun setZoom(value: Int) { prefs.edit().putInt("webTextZoom",BrowserFeatures.zoom(value)).apply(); browser.applyWebPrefs() }
    fun isDefault(): Boolean = runCatching {
        if (Build.VERSION.SDK_INT >= 29) activity.getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_BROWSER)
        else Intent(Intent.ACTION_VIEW,Uri.parse("https://example.com")).addCategory(Intent.CATEGORY_BROWSABLE)
            .resolveActivity(activity.packageManager)?.packageName == activity.packageName
    }.getOrDefault(false)
    val defaultBrowser = DefaultBrowserMonitor(::isDefault) { browser.bridge.call("browserPrefsChanged") {} }
    private fun openDefaultSettings() {
        defaultBrowser.begin(DefaultBrowserMonitor.Flow.SETTINGS)
        activity.startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
    }
    fun requestDefault() {
        runCatching {
            if (Build.VERSION.SDK_INT >= 29) {
                val role = activity.getSystemService(RoleManager::class.java)
                if (role.isRoleAvailable(RoleManager.ROLE_BROWSER) && !role.isRoleHeld(RoleManager.ROLE_BROWSER)) {
                    defaultBrowser.begin(DefaultBrowserMonitor.Flow.ROLE)
                    activity.requestBrowserRole(role.createRequestRoleIntent(RoleManager.ROLE_BROWSER))
                } else openDefaultSettings()
            } else openDefaultSettings()
        }.onFailure { defaultBrowser.launchFailed(); browser.toast("请在系统设置中选择默认浏览器") }
    }
    fun prefsChanged() { defaultBrowser.changed() }
    fun scan() {
        browser.sheet = null
        if (ContextCompat.checkSelfPermission(activity,Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanner = true
        else activity.requestPermissionsFor(listOf(Manifest.permission.CAMERA)) {
            if (ContextCompat.checkSelfPermission(activity,Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanner = true
            else browser.toast("请允许相机权限以扫描二维码")
        }
    }
    fun scanned(value: String) {
        when(val target = BrowserFeatures.scan(value)) {
            is ScanTarget.Web -> { scanner = false; browser.navigate(target.url) }
            is ScanTarget.Pairing -> { scanner = false; browser.goHome(); browser.bridge.call("pairWithCode",JSONObject().put("code",target.code)) { if (it.isFailure) browser.toast("配对页面暂不可用，请重试") } }
            null -> browser.toast("二维码不是网址或空境配对码")
        }
    }
    fun backHistory() {
        if (browser.active.home) return
        val list = browser.view().copyBackForwardList()
        backEntries = (list.currentIndex-1 downTo (list.currentIndex-15).coerceAtLeast(0)).mapNotNull { i -> list.getItemAtIndex(i)?.let { BackEntry(i-list.currentIndex,it.title.orEmpty().ifBlank { UrlRules.host(it.url) },it.url) } }
        browser.sheet = "backHistory"
    }
    fun jumpBack(offset: Int) { browser.navigateHistory(offset) }
    private fun saveClosed() {
        recent = closed.list(); val a = JSONArray(); recent.forEach { a.put(JSONObject().put("url",it.url).put("title",it.title).put("desktop",it.desktop)) }
        prefs.edit().putString("recentClosed",a.toString()).apply()
    }
    fun closed(tab: BrowserTab, undo: Boolean) {
        if (tab.incognito || tab.home) return
        val page = ClosedPage(tab.url,tab.title,tab.desktop); closed.push(page); saveClosed()
        if (undo) notify("已关闭", "撤销") { restore(page); closed.remove(0); saveClosed() }
    }
    fun restore(index: Int) { closed.remove(index)?.let { restore(it); saveClosed() } }
    private fun restore(page: ClosedPage) { browser.navigate(page.url,true); if (page.desktop) browser.toggleDesktop(); browser.sheet = null }
    fun closeAll() {
        confirmCloseAll = false
        browser.tabs.map { it.id }.forEach { browser.closeTab(it, false) }
        browser.showTabs = false; browser.sheet = null; notify("已关闭全部标签页，可在最近关闭中恢复")
    }
    fun readLater() {
        if (browser.active.home) return
        val tab = browser.active; browser.sheet = null
        browser.bridge.call("addReadLater",JSONObject().put("url",tab.url).put("title",tab.title).put("iconDataUrl",browser.store.iconData(tab.url))) { result ->
            browser.toast(if (result.isSuccess) "已加入稍后阅读" else "加入稍后阅读失败，请重试")
        }
    }
    fun pinShortcut() {
        val tab = browser.active; if (tab.home) return
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(activity)) { browser.toast("当前桌面不支持添加快捷方式"); return }
        val icon = tab.icon ?: Bitmap.createBitmap(128,128,Bitmap.Config.ARGB_8888).also { b ->
            val c = Canvas(b); c.drawColor(0xff2f6ceb.toInt()); c.drawText(UrlRules.host(tab.url).take(1).uppercase(),64f,88f,Paint(Paint.ANTI_ALIAS_FLAG).apply { color = -1; textSize = 72f; textAlign = Paint.Align.CENTER })
        }
        val intent = Intent(activity,MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse(tab.url))
        val shortcut = ShortcutInfoCompat.Builder(activity,"page-"+tab.url.hashCode().toUInt().toString()).setShortLabel(tab.title.take(40).ifBlank { "网页" })
            .setIcon(IconCompat.createWithBitmap(icon)).setIntent(intent).build()
        browser.sheet = null
        runCatching { ShortcutManagerCompat.requestPinShortcut(activity,shortcut,null) }.onFailure { browser.toast("无法添加快捷方式") }
    }
    fun grants(url: String): Set<String> = BrowserFeatures.origin(url)?.let { prefs.getStringSet("site:$it", emptySet())?.toSet() }.orEmpty()
    fun grant(url: String, permissions: List<String>) { BrowserFeatures.origin(url)?.let { origin -> prefs.edit().putStringSet("site:$origin",grants(url)+permissions).apply() } }
    fun revoke(permission: String) {
        val origin = BrowserFeatures.origin(browser.active.url) ?: return
        prefs.edit().putStringSet("site:$origin",grants(origin)-permission).apply()
        if (permission.contains("LOCATION")) android.webkit.GeolocationPermissions.getInstance().clear(origin)
        browser.view().reload() // Stop active capture/location sessions as well as future remembered grants.
        browser.sheet = null; browser.toast("已撤销网站权限")
    }
    private fun downloadIds(): Set<Long> = prefs.getStringSet("downloadIds",emptySet()).orEmpty().mapNotNull(String::toLongOrNull).toSet()
    fun trackDownload(id: Long) { prefs.edit().putStringSet("downloadIds",downloadIds().map(Long::toString).toSet()+id.toString()).apply() }
    fun refreshDownloads() {
        val ids = downloadIds(); if (ids.isEmpty()) { downloads = emptyList(); return }
        val rows = mutableListOf<DownloadEntry>()
        manager.query(DownloadManager.Query().setFilterById(*ids.toLongArray()))?.use { c ->
            fun long(name: String) = c.getLong(c.getColumnIndexOrThrow(name))
            while(c.moveToNext()) rows += DownloadEntry(long(DownloadManager.COLUMN_ID),c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)),long(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR),long(DownloadManager.COLUMN_TOTAL_SIZE_BYTES),long(DownloadManager.COLUMN_STATUS).toInt(),long(DownloadManager.COLUMN_LAST_MODIFIED_TIMESTAMP))
        }
        downloads = rows.sortedByDescending { it.at }
    }
    fun openDownloads() { browser.sheet = "downloads"; refreshDownloads() }
    fun openDownload(id: Long) {
        runCatching {
            val uri = manager.getUriForDownloadedFile(id) ?: error("未完成")
            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri,manager.getMimeTypeForDownloadedFile(id) ?: "application/octet-stream").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(intent)
        }.onFailure { browser.toast("文件未完成、已移除或没有可打开的应用") }
    }
    fun removeDownload(entry: DownloadEntry, file: Boolean) {
        // Removing the local record alone leaves DownloadManager and its file intact.
        if (file) manager.remove(entry.id)
        prefs.edit().putStringSet("downloadIds",downloadIds().filterNot { it == entry.id }.map(Long::toString).toSet()).apply()
        deleteDownload = null; refreshDownloads()
    }
    fun downloadDescription(row: DownloadEntry): String {
        fun size(v: Long) = if (v < 0) "未知大小" else android.text.format.Formatter.formatShortFileSize(activity,v)
        return when(row.state) {
            DownloadManager.STATUS_SUCCESSFUL -> "${size(row.total)} · ${DateFormat.getDateTimeInstance(DateFormat.SHORT,DateFormat.SHORT).format(Date(row.at))}"
            DownloadManager.STATUS_FAILED -> "下载失败 · ${size(row.bytes)}"
            DownloadManager.STATUS_PAUSED -> "已暂停 · ${size(row.bytes)} / ${size(row.total)}"
            else -> "${size(row.bytes)} / ${size(row.total)}${if (row.total>0) " · ${row.bytes*100/row.total}%" else ""}"
        }
    }
    fun attachPull(web: WebView) {
        var startX = 0f; var startY = 0f; var eligible = false
        val threshold = 92 * activity.resources.displayMetrics.density
        web.setOnTouchListener { _, e ->
            when(e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX=e.x; startY=e.y; eligible=web.scrollY==0 && !web.canScrollVertically(-1); pull=0f
                    if (eligible) web.evaluateJavascript("(function(){var e=document.elementFromPoint(${e.x/activity.resources.displayMetrics.density},${e.y/activity.resources.displayMetrics.density});for(;e&&e!==document.body;e=e.parentElement){if(e.scrollHeight>e.clientHeight&&/auto|scroll/.test(getComputedStyle(e).overflowY))return false}return true})()") { if (it != "true") eligible=false }
                }
                MotionEvent.ACTION_MOVE -> if (eligible && !browser.active.home && !browser.showTabs && web.scrollY==0 && kotlin.math.abs(e.x-startX)<threshold) pull=((e.y-startY)/threshold).coerceIn(0f,1.5f)
                MotionEvent.ACTION_UP -> { if (eligible&&pull>=1f) web.reload(); pull=0f; eligible=false }
                MotionEvent.ACTION_CANCEL,MotionEvent.ACTION_POINTER_DOWN -> { eligible=false; pull=0f }
            }
            false
        }
    }
    fun destroy() { activity.unregisterReceiver(receiver); main.removeCallbacksAndMessages(null) }
}
