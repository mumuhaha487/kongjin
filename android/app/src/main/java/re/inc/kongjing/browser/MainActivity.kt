package re.inc.kongjing.browser

import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import android.content.pm.ActivityInfo
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import re.inc.kongjing.browser.core.UrlRules
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class MainActivity : ComponentActivity() {
    lateinit var browser: BrowserController
        private set
    private var files: ValueCallback<Array<Uri>>? = null
    private var permissionResult: (() -> Unit)? = null
    private val notificationWaiters = CopyOnWriteArrayList<CountDownLatch>()
    private var video: FrameLayout? = null
    private var videoCallback: WebChromeClient.CustomViewCallback? = null
    private var previousOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        files?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        files = null
    }
    private val permissionPicker = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        permissionResult?.invoke(); permissionResult = null
    }
    private val browserRole = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (::browser.isInitialized) browser.extras.defaultBrowser.roleResult()
    }
    fun requestBrowserRole(intent: Intent) { browserRole.launch(intent) }
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        android.webkit.WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG || BuildConfig.WEBVIEW_INSPECT)
        enableEdgeToEdge()
        splash.setOnExitAnimationListener { screen -> screen.view.animate().alpha(0f).setDuration(200).withEndAction { screen.remove() }.start() }
        browser = BrowserController(this)
        handleIntent(intent)
        setContent { BrowserApp(browser) }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }
    private fun handleIntent(intent: Intent?) {
        if (intent == null || browser.notificationIntent(intent)) return
        intent.dataString?.let { if (UrlRules.webUrl(it) != null) browser.navigate(it, true) }
    }
    /** JavascriptInterface runs off the UI thread; the permission dialog/result stays on main. */
    fun requestNotificationPermissionBlocking(): String {
        if (android.os.Build.VERSION.SDK_INT < 33) return "granted"
        fun granted() = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (granted()) return "granted"
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return "denied"
        val latch = CountDownLatch(1)
        notificationWaiters += latch
        runOnUiThread {
            if (isFinishing || isDestroyed || !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) || permissionResult != null) latch.countDown()
            else requestPermissionsFor(listOf(Manifest.permission.POST_NOTIFICATIONS)) { latch.countDown() }
        }
        try { latch.await(60, TimeUnit.SECONDS) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        finally { notificationWaiters.remove(latch) }
        return if (granted()) "granted" else "denied"
    }
    fun applyBars(dark: Boolean, home: Boolean = browser.active.home && !browser.showTabs) {
        val statusColor = if (home) android.graphics.Color.TRANSPARENT else
            if (dark) 0xff0a1020.toInt() else 0xfff7fafe.toInt()
        enableEdgeToEdge(
            statusBarStyle = if (dark) SystemBarStyle.dark(statusColor) else SystemBarStyle.light(statusColor, statusColor),
            navigationBarStyle = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT) else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
        )
        @Suppress("DEPRECATION")
        if (android.os.Build.VERSION.SDK_INT < 35) window.statusBarColor = statusColor
        WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark }
    }
    fun chooseFiles(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams) {
        cancelFileChooser(); files = callback
        runCatching { filePicker.launch(params.createIntent()) }.onFailure { files?.onReceiveValue(null); files = null; browser.toast("未找到文件选择器") }
    }
    fun cancelFileChooser() { files?.onReceiveValue(null); files = null }
    fun requestPermissionsFor(permissions: List<String>, complete: () -> Unit) {
        if (permissionResult != null) { browser.toast("请先完成当前授权"); complete(); return }
        permissionResult = complete
        permissionPicker.launch(permissions.toTypedArray())
    }
    fun enterVideo(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (video != null) { callback.onCustomViewHidden(); return }
        previousOrientation = requestedOrientation
        videoCallback = callback
        video = FrameLayout(this).apply { setBackgroundColor(android.graphics.Color.BLACK); addView(view, FrameLayout.LayoutParams(-1, -1)) }
        addContentView(video, ViewGroup.LayoutParams(-1, -1))
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
    fun exitVideo() {
        if (video == null) return
        video?.let { (it.parent as? ViewGroup)?.removeView(it); it.removeAllViews() }; video = null
        videoCallback?.onCustomViewHidden(); videoCallback = null
        browser.fullScreen = false
        requestedOrientation = previousOrientation
        WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
    }
    override fun onResume() { super.onResume(); if (::browser.isInitialized) { browser.resume(); applyBars(browser.dark) } }
    override fun onStart() { super.onStart(); if (::browser.isInitialized) browser.setForeground(true) }
    override fun onStop() { if (::browser.isInitialized) browser.setForeground(false); super.onStop() }
    override fun onPause() { if (::browser.isInitialized) browser.pause(); super.onPause() }
    override fun onTrimMemory(level: Int) { super.onTrimMemory(level); if (::browser.isInitialized && level >= TRIM_MEMORY_RUNNING_LOW) browser.onMemoryPressure() }
    override fun onDestroy() { notificationWaiters.forEach(CountDownLatch::countDown); exitVideo(); if (::browser.isInitialized) browser.destroy(); super.onDestroy() }
}
