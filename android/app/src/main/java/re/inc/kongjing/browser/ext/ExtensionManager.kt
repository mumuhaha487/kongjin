@file:Suppress("SetJavaScriptEnabled")
package re.inc.kongjing.browser.ext

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.*
import androidx.compose.runtime.*
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.ext.api.*
import re.inc.kongjing.browser.ext.core.*
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** Own one manager per browser controller, never attach the homepage. */
class ExtensionManager(val context: Context, val tabs: TabController) : ExtensionHost {
    private val main=Handler(Looper.getMainLooper())
    private val io=Executors.newSingleThreadExecutor { r -> Thread(r,"extension-io") }
    private val networkIo=Executors.newCachedThreadPool { r -> Thread(r,"extension-network") }
    private val repository=ExtensionRepository(File(context.filesDir,"extensions"))
    val apiState=ApiState(File(context.filesDir,"extensions-state")) {task->io.execute(task)}
    private val router=MessageRouter { delay,block -> val r=Runnable(block); main.postDelayed(r,delay); { main.removeCallbacks(r) } }
    private val storage=ExtensionStorage(File(context.filesDir,"extension-storage")) { id,area,changes -> main.post { emit(id,"storage.onChanged",changes,area) } }
    private val network=NetworkClient({ CookieManager.getInstance().getCookie(it) },{u,c-> CookieManager.getInstance().setCookie(u,c) })
    private val alarms=ExtensionAlarms(apiState) { id,alarm -> emit(id,"alarms.onAlarm",alarm) }
    private val dnr=DnrRegistry(ApiState(File(context.filesDir,"extension-rules")))
    private val notificationService=lazy {ExtensionNotifications(context) { id,name,args -> main.post { router.event(id,name,args) } }}
    private val notifications by notificationService
    private data class Binding(val view: WebView,val tab: TabHandle?,val extensionId: String,val bridge: String,val script: ScriptHandler,
        val documents: MutableMap<String,String> = mutableMapOf())
    private val bindings=mutableListOf<Binding>()
    private val views=mutableMapOf<Int,WebView>()
    private val extensionTabs=mutableMapOf<Int,String>()
    private val grants=mutableSetOf<Pair<String,Int>>()
    private val inheritedAllows=java.util.concurrent.ConcurrentHashMap<Int,Map<String,Int>>()
    private val offscreenPaths=java.util.concurrent.ConcurrentHashMap<String,String>()
    private val offscreenReady=mutableMapOf<String,(Result<Any?>)->Unit>()
    private var nextFrame=1
    private var hostView: WebView?=null
    private var alive=true
    private var foreground=true
    private var bundle: String?=null
    private val injectionWaiters=mutableMapOf<String,(Result<Any?>)->Unit>()
    private val frameInfo=mutableMapOf<String,SenderContext>()
    private val pendingLifecycle=mutableMapOf<String,MutableList<Pair<String,JSONArray>>>()
    private val started=mutableSetOf<String>()
    private var startupUpdatesChecked=false
    override val supported: Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
    var extensions by mutableStateOf<List<InstalledExtension>>(emptyList()); private set
    var managementVisible by mutableStateOf(false)
    var detailId by mutableStateOf<String?>(null)
    var actionsTabId by mutableStateOf<Int?>(null)
    var popup by mutableStateOf<Pair<String,String>?>(null)
    var pendingInstall by mutableStateOf<PendingInstall?>(null); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null)
    var permissionPrompt by mutableStateOf<PermissionPrompt?>(null); private set
    var uiRevision by mutableIntStateOf(0); private set
    data class PermissionPrompt(val extensionId: String,val permissions: Set<String>,val origins: Set<String>,val complete: (Boolean)->Unit)
    private val tick=object:Runnable { override fun run() { if(alive && foreground && extensions.any { it.enabled }) { alarms.tick(extensions.filter { it.enabled }.map { it.id }); main.postDelayed(this,1000) } } }
    init { refresh() }
    private fun post(block: ()->Unit) { main.post { if(alive) block() } }
    private fun runtime(): String = bundle ?: context.assets.open("ext-runtime/runtime.js").bufferedReader().use { it.readText() }.also { bundle=it }
    fun showManagement() { managementVisible=true }
    fun get(id: String)=extensions.firstOrNull { it.id==id }
    fun refresh(after: ()->Unit = {}) {
        io.execute {
            val loaded=repository.list()
            loaded.forEach {apiState.data(it.id)}
            val result=runCatching { dnr.rebuild(loaded) }
            post { val old=extensions;extensions=loaded; if(result.isFailure) error="广告规则加载失败：${result.exceptionOrNull()?.message}"; if(old.map {Triple(it.id,it.manifest.version,it.enabled)}!=loaded.map {Triple(it.id,it.manifest.version,it.enabled)})rebuildBindings() else if(old!=loaded) rebuildContentBindings(); after();checkStartupUpdates() }
        }
    }
    fun installFromStore(input: String) {
        val id=MatchPattern.storeId(input) ?: run { error="请输入 Chrome 应用商店链接或 32 位扩展 ID"; return }
        if(!supported) { error="需要更新 Android System WebView"; return }
        busy=true; error=null
        networkIo.execute {
            val result=runCatching { repository.prepare(network.download(id,webViewMajor()),id) }
            post { result.fold({ candidate -> checkSyntax(candidate) },{ busy=false; error="无法连接 Chrome 应用商店，请检查网络或代理设置（${it.message}）" }) }
        }
    }
    fun installFromFile(uri: Uri) {
        if(!supported) { error="需要更新 Android System WebView"; return }
        busy=true
        io.execute {
            val result=runCatching {
                val bytes=context.contentResolver.openInputStream(uri)!!.use { input -> val out=java.io.ByteArrayOutputStream(); val b=ByteArray(16384); while(true) { val n=input.read(b); if(n<0) break; require(out.size().toLong()+n<=SafeZip.MAX_BYTES); out.write(b,0,n) }; out.toByteArray() }
                repository.prepare(bytes,source="file")
            }
            post { result.fold(::checkSyntax,{busy=false;error=it.message}) }
        }
    }
    private fun checkSyntax(p: PendingInstall,onComplete:(PendingInstall)->Unit = {pendingInstall=it;busy=false}) {
        // Parse only. The candidate is not registered, enabled or allowed onto the message channel.
        io.execute {
            val files=p.root.walkTopDown().filter { it.isFile && it.extension in setOf("js","mjs") }.map { it.relativeTo(p.root).invariantSeparatorsPath to it.readText() }.toList()
            post {
                val parser=WebView(context).apply { settings.javaScriptEnabled=true; settings.allowFileAccess=false; settings.allowContentAccess=false }
                val failures=mutableListOf<String>(); var index=0
                fun finish() {
                    parser.destroy(); onComplete(p.copy(compatibility=Capabilities.analyze(p.manifest,p.root,failures)))
                }
                fun next() {
                    if(index>=files.size) { finish(); return }
                    val (path,code)=files[index++]
                    val module=path==p.manifest.json.optJSONObject("background")?.optString("service_worker")?.trimStart('/') && p.manifest.json.optJSONObject("background")?.optString("type")=="module" || path.endsWith(".mjs") || Regex("(?m)^\\s*(import|export)\\s").containsMatchIn(code)
                    parser.evaluateJavascript("KJRuntime.syntaxCheck(${JSONObject.quote(code)},$module,${webViewMajor()})") { value ->
                        if(value!="null") failures+="$path: ${value.take(200)}"
                        next()
                    }
                }
                parser.webViewClient=object:WebViewClient() { override fun onPageFinished(view:WebView,url:String?) { parser.evaluateJavascript(runtime()) { next() } } }
                parser.loadDataWithBaseURL("https://parser.ext.kongjing.invalid/","<html><head></head></html>","text/html","utf-8",null)
            }
        }
    }
    fun confirmInstall() {
        val p=pendingInstall ?: return
        if(p.compatibility.level==CompatibilityLevel.BLOCKED) return
        pendingInstall=null; busy=true
        io.execute { val result=runCatching { repository.commit(p) }; post { busy=false; result.fold({e-> started.add(e.id);pendingLifecycle.getOrPut(e.id){mutableListOf()}.add("runtime.onInstalled" to JSONArray().put(JSONObject().put("reason","install"))); refresh() },{ error=it.message }) } }
    }
    fun cancelInstall() { val p=pendingInstall ?: return; pendingInstall=null; io.execute { repository.discard(p) } }
    fun setEnabled(id: String,enabled: Boolean) { val e=get(id) ?: return; io.execute { repository.save(e.copy(enabled=enabled && !e.needsPermission)); post { refresh() } } }
    fun approveUpdate(id: String) { val e=get(id) ?: return; io.execute { repository.save(e.copy(enabled=true,needsPermission=false,grantedPermissions=e.manifest.permissions,grantedHosts=e.manifest.hosts)); post { refresh() } } }
    fun pin(id: String) { val e=get(id) ?: return; val list=extensions;io.execute { list.filter {it.pinned && it.id!=id}.forEach {repository.save(it.copy(pinned=false))};repository.save(e.copy(pinned=!e.pinned)); post { refresh() } } }
    fun setSiteAccess(id: String,mode: String,sites: Set<String> = emptySet()) {
        require(mode in setOf("all","specific","click")); val e=get(id) ?: return
        require(sites.all { MatchPattern.allowedPage(it) })
        grants.removeAll { it.first==id }
        io.execute { repository.save(e.copy(access=mode,sites=sites)); post { refresh() } }
    }
    fun remove(id: String) {
        notifications.remove(id); grants.removeAll { it.first==id };closeOffscreen(id)
        popup=popup?.takeUnless { it.first==id }; if(detailId==id) detailId=null
        io.execute { repository.remove(id); storage.remove(id); apiState.remove(id);dnr.remove(id); post { refresh() } }
    }
    fun storageBytes(id: String): Long = File(context.filesDir,"extension-storage/$id").walkTopDown().filter { it.isFile }.sumOf { it.length() }
    fun checkUpdates(id: String?=null) {
        val candidates=extensions.filter { it.source=="store" && (id==null || it.id==id) }
        networkIo.execute {
            val available=runCatching {candidates.chunked(100).flatMap {batch->network.updates(batch.associate {it.id to it.manifest.version},webViewMajor()).entries.map {it.key to it.value}}.toMap()}
            if(available.isFailure){post {error="检查更新失败：${available.exceptionOrNull()?.message}"};return@execute}
            candidates.filter {available.getOrThrow()[it.id]?.let {v->v!=it.manifest.version}==true}.forEach { old ->
                runCatching {
                    val bytes=network.download(old.id,webViewMajor()); val p=repository.prepare(bytes,old.id)
                    if(p.manifest.version==old.manifest.version) repository.discard(p)
                    else if(p.compatibility.level==CompatibilityLevel.BLOCKED) { repository.discard(p); error("新版本不兼容") }
                    else {
                        post {checkSyntax(p) {checked->
                            io.execute { val result=runCatching {if(checked.compatibility.level==CompatibilityLevel.BLOCKED){repository.discard(checked);error("新版本需要更新系统组件")}else repository.commit(checked,allowNewPermissions=false)}
                                post {result.fold({updated->pendingLifecycle.getOrPut(updated.id){mutableListOf()}.add("runtime.onInstalled" to JSONArray().put(JSONObject().put("reason","update").put("previousVersion",old.manifest.version)));refresh()},{error="扩展更新失败：${it.message}"})}
                            }
                        }}
                    }
                }.onFailure { failure -> post { error="检查更新失败：${failure.message}" } }
            }
            post { refresh() }
        }
    }
    private fun checkStartupUpdates() {
        if(startupUpdatesChecked || !supported || extensions.none {it.source=="store"})return
        startupUpdatesChecked=true
        val prefs=context.getSharedPreferences("extension-updates",Context.MODE_PRIVATE);val now=System.currentTimeMillis()
        if(now-prefs.getLong("lastCheck",0)>=24*60*60*1000L) {prefs.edit().putLong("lastCheck",now).apply();checkUpdates()}
    }
    fun activate(id: String,tabId: Int,userGesture:Boolean=true) {
        val e=get(id) ?: return
        if(!e.enabled || !actionState(id,tabId).optBoolean("enabled",true))return
        if(userGesture && (e.access=="click" || "activeTab" in e.grantedPermissions)) {grants+=id to tabId;router.event(id,"_host.grant",JSONArray()) {it.tabId==tabId && it.type=="content"}}
        actionsTabId=null
        val action=actionState(id,tabId)
        if(!action.optBoolean("enabled",true)) return
        val path=action.optString("popup",e.manifest.popup)
        if(path.isNotBlank()) popup=id to e.manifest.url(path) else emit(id,"action.onClicked",tabJson(tabs.query().firstOrNull { it.id==tabId }))
    }
    fun openOptions(id: String) { get(id)?.let { if(it.manifest.options.isNotBlank()) tabs.create(it.manifest.url(it.manifest.options)) } }
    fun actionState(id: String,tabId: Int?=null): JSONObject {
        val result=JSONObject(apiState.section(id,"action").optJSONObject("default")?.toString() ?: "{}")
        tabId?.let { apiState.section(id,"action").optJSONObject(it.toString())?.let { overrides -> overrides.keys().forEach { result.put(it,overrides.get(it)) } } }
        return result
    }
    override fun attach(tab: TabHandle,webView: WebView) { if(views[tab.id]===webView) return; detach(tab); views[tab.id]=webView; tabs.query().firstOrNull {it.id==tab.id}?.url?.let(ResourceGate::extensionId)?.let {extensionTabs[tab.id]=it}; if(supported) extensions.filter { it.enabled }.forEach { bind(it,webView,tab) } }
    override fun detach(tab: TabHandle) { views.remove(tab.id);extensionTabs.remove(tab.id); bindings.filter { it.tab==tab }.toList().forEach(::unbind) }
    private fun unbind(b: Binding) { b.script.remove(); WebViewCompat.removeWebMessageListener(b.view,b.bridge); b.documents.values.forEach { router.unregister(it); frameInfo.remove(it) }; bindings.remove(b) }
    private fun rebuildBindings() {
        bindings.toList().forEach(::unbind)
        hostView?.destroy(); hostView=null
        offscreenPaths.clear();offscreenReady.values.toList().forEach {it(Result.failure(IllegalStateException("Extension context invalidated.")))};offscreenReady.clear()
        main.removeCallbacks(tick)
        if(!supported || extensions.none { it.enabled }) { bundle=null; return }
        views.forEach { (id,view) -> extensions.filter { it.enabled }.forEach { bind(it,view,TabHandle(id)) } }
        val host=WebView(context).apply {
            settings.javaScriptEnabled=true; settings.domStorageEnabled=true; settings.allowFileAccess=false; settings.allowContentAccess=false; settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
            isFocusable=false; isClickable=false
            webViewClient=object:WebViewClient() {
                override fun shouldInterceptRequest(view:WebView,r:WebResourceRequest): WebResourceResponse? {
                    val url=r.url.toString();val target=ResourceGate.extensionId(url)
                    val ref=r.requestHeaders.entries.firstOrNull {it.key.equals("Referer",true)}?.value
                    val own=target!=null && ResourceGate.extensionId(ref ?: "")==target
                    val bootstrap=ref?.startsWith("https://host.ext.kongjing.invalid/")==true && extensions.any {e->e.id==target && (r.url.path=="/_kj/background.html" || r.url.path=="/"+e.manifest.json.optJSONObject("background")?.optString("page") || offscreenPaths[e.id]==url)}
                    return interceptResource(r,own || bootstrap)
                }
                override fun shouldOverrideUrlLoading(view:WebView,r:WebResourceRequest): Boolean = !ResourceGate.reserved(r.url.toString())
            }
        }
        hostView=host
        extensions.filter { it.enabled }.forEach { bind(it,host,null) }
        val frames=extensions.filter { it.enabled && it.manifest.json.has("background") }.joinToString("") { e ->
            val bg=e.manifest.json.getJSONObject("background"); val path=bg.optString("page","_kj/background.html")
            "<iframe src=\"${e.manifest.url(path)}\"></iframe>"
        }
        host.loadDataWithBaseURL("https://host.ext.kongjing.invalid/","<!doctype html><html><body>$frames</body></html>","text/html","utf-8",null)
        if(foreground) main.post(tick) else host.onPause()
    }
    private fun rebuildContentBindings() {
        bindings.filter {it.tab!=null}.toList().forEach(::unbind)
        if(supported)views.forEach {(id,view)->extensions.filter {it.enabled}.forEach {bind(it,view,TabHandle(id))}}
    }
    private fun mayAccess(e:InstalledExtension,tabId:Int?,url:String):Boolean = SiteAccess.allowed(e,url,tabId!=null && e.id to tabId in grants)
    private fun bind(e:InstalledExtension,view:WebView,tab:TabHandle?) {
        val name="__kj_ext_"+UUID.randomUUID().toString().replace("-","").take(16)
        lateinit var binding:Binding
        WebViewCompat.addWebMessageListener(view,name,setOf("*")) { _,message,origin,isMain,proxy ->
            if(!alive || get(e.id)?.enabled!=true) return@addWebMessageListener
            val raw=message.data ?: return@addWebMessageListener
            if(raw.length>52*1024*1024) return@addWebMessageListener
            runCatching { receive(binding,JSONObject(raw),origin.toString(),isMain,proxy) }.onFailure { failure ->
                runCatching { val m=JSONObject(raw); if(m.optString("kind")=="call") proxy.postMessage(reply(m.optString("id"),null,failure.message).toString()) }
            }
        }
        val registered=apiState.section(e.id,"scripts").keys().asSequence().map { apiState.section(e.id,"scripts").getJSONObject(it) }.toList()
        val users=apiState.section(e.id,"userScripts").keys().asSequence().map {apiState.section(e.id,"userScripts").getJSONObject(it)}.toList()
        val script=WebViewCompat.addDocumentStartJavaScript(view,ScriptBuilder.bootstrap(e,runtime(),name,registered,users,tab!=null && e.id to tab.id in grants),setOf("*"))
        binding=Binding(view,tab,e.id,name,script); bindings+=binding
    }
    fun attachExtensionPage(id:String,view:WebView,onReady:()->Unit = {}) { val e=get(id) ?: return; require(supported); view.settings.javaScriptEnabled=true;view.settings.domStorageEnabled=true;view.settings.allowFileAccess=false;view.settings.allowContentAccess=false;view.settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
        view.webViewClient=object:WebViewClient() { override fun shouldInterceptRequest(v:WebView,r:WebResourceRequest)=interceptResource(r,r.isForMainFrame && ResourceGate.extensionId(r.url.toString())==id || ResourceGate.extensionId(r.requestHeaders["Referer"] ?: "")==id)
            override fun onPageFinished(v:WebView,url:String?) {onReady()}
            override fun shouldOverrideUrlLoading(v:WebView,r:WebResourceRequest):Boolean { if(ResourceGate.extensionId(r.url.toString())==id)return false; if(r.isForMainFrame) tabs.create(r.url.toString()); return true } }
        view.webChromeClient=object:WebChromeClient() { override fun onCloseWindow(window:WebView) { popup=null } }
        bind(e,view,null)
    }
    fun detachExtensionPage(view:WebView) { bindings.filter { it.view===view }.toList().forEach(::unbind); view.destroy() }
    private fun receive(b:Binding,m:JSONObject,origin:String,isMain:Boolean,proxy:JavaScriptReplyProxy) {
        require(m.optInt("v")==1)
        val e=get(b.extensionId) ?: return
        val doc=m.getString("documentId"); require(doc.length in 1..128)
        val own=ResourceGate.extensionId(origin)==e.id
        require(own || b.tab!=null && MatchPattern.allowedPage(origin) && (SiteAccess.declared(e,origin) || "activeTab" in e.grantedPermissions)) { "扩展来源或主机权限不匹配" }
        if(m.getString("kind")=="hello") {
            val key=UUID.randomUUID().toString()
            b.documents.remove(doc)?.let { router.unregister(it); frameInfo.remove(it) }
            val sender=SenderContext(e.id,if(own) { if(b.view===hostView) "background" else "page" } else "content",b.tab?.id,if(isMain)0 else nextFrame++,UUID.randomUUID().toString(),origin)
            b.documents[doc]=key; frameInfo[key]=sender
            router.register(MessageRouter.Endpoint(key,sender) { proxy.postMessage(it.toString()) })
            proxy.postMessage(JSONObject().put("v",1).put("kind","hello").put("endpoint",key).toString())
            return
        }
        val key=b.documents[doc] ?: error("未登记的文档")
        val endpoint=router.endpoint(key) ?: error("已失效的文档")
        require(endpoint.sender.url==origin && (endpoint.sender.type!="content" || b.tab?.id==endpoint.sender.tabId))
        require(own || mayAccess(e,b.tab?.id,origin)) { "尚未授予此网站的访问权限" }
        val args=m.optJSONArray("args") ?: JSONArray()
        when(m.getString("kind")) {
            "response" -> router.response(endpoint,m.getString("id"),m.opt("value"),m.optBoolean("handled"),m.optString("error").ifEmpty { null })
            "injectionResult" -> injectionWaiters.remove(key+":"+m.getString("id"))?.invoke(if(m.has("error")) Result.failure(IllegalStateException(m.getString("error"))) else Result.success(m.opt("value")))
            "port" -> when(m.getString("op")) {
                "connect" -> {
                    val api=m.getString("api"); MessageRouter.check(endpoint.sender,e.manifest,api,e.grantedPermissions)
                    val info=args.optJSONObject(if(api=="tabs.connect")1 else 0) ?: JSONObject()
                    router.connect(endpoint,m.getString("id"),info.optString("name"),if(api=="tabs.connect")args.getInt(0) else null,info.optInt("frameId").takeIf { info.has("frameId") },info.optString("documentId").takeIf { it.isNotEmpty() })
                }
                "message" -> router.post(endpoint,m.getString("id"),m.opt("message"))
                "disconnect" -> router.disconnect(m.getString("id"),key)
            }
            "call" -> {
                val api=m.getString("api"); val callId=m.getString("id")
                fun done(result:Result<Any?>) { post { result.fold({ proxy.postMessage(reply(callId,it).toString()) },{proxy.postMessage(reply(callId,null,it.message).toString())}) } }
                if(api=="_ui.close" && endpoint.sender.type!="content") {if(sourceTab(endpoint.sender)!=null)tabs.remove(sourceTab(endpoint.sender)!!)else popup=null;done(Result.success(null));return}
                if(api=="_lifecycle.ready" && endpoint.sender.type=="background") {
                    emit(e.id,"_host.visibility",foreground)
                    pendingLifecycle.remove(e.id)?.forEach {(name,a)->router.event(e.id,name,a)}
                    if(started.add(e.id))emit(e.id,"runtime.onStartup")
                    done(Result.success(null));return
                }
                if(api=="_offscreen.ready" && own && b.view===hostView) {if(offscreenPaths[e.id]?.let {java.net.URI(it).path}==args.optString(0))offscreenReady.remove(e.id)?.invoke(Result.success(null));done(Result.success(null));return}
                if(api.startsWith("_navigation.") && endpoint.sender.type=="content") {
                    b.tab?.let { tab -> val url=args.optString(0,origin); if(api=="_navigation.dom") onNavigationDomContentLoaded(tab,url,ExtensionFrame(endpoint.sender.frameId)) else if(api=="_navigation.history") onNavigationHistoryStateUpdated(tab,url,ExtensionFrame(endpoint.sender.frameId)) }
                    done(Result.success(null)); return
                }
                MessageRouter.check(endpoint.sender,e.manifest,api,e.grantedPermissions)
                if(api in setOf("runtime.sendMessage","tabs.sendMessage")) {
                    val tabId=if(api=="tabs.sendMessage")args.getInt(0) else null
                    val options=args.optJSONObject(if(tabId==null)1 else 2) ?: JSONObject()
                    router.message(endpoint,callId,args.opt(if(tabId==null)0 else 1),tabId,options.optInt("frameId").takeIf { options.has("frameId") },options.optString("documentId").takeIf { it.isNotEmpty() });return
                }
                if(api=="scripting.executeScript" || api=="scripting.insertCSS" || api=="scripting.removeCSS" || api=="tabs.executeScript" || api=="tabs.insertCSS") { inject(e,endpoint,api,args,::done); return }
                if(api=="permissions.request") { requestPermissions(e,args.getJSONObject(0),::done); return }
                if(api=="offscreen.createDocument") {
                    require(!offscreenPaths.containsKey(e.id)){"Only a single offscreen document may be created."}
                    val url=validateTabUrl(e,args.getJSONObject(0).getString("url"));require(ResourceGate.extensionId(url)==e.id)
                    val host=hostView ?: error("Extension host is not ready")
                    offscreenPaths[e.id]=url;offscreenReady[e.id]=::done
                    host.evaluateJavascript("(()=>{const f=document.createElement('iframe');f.id="+JSONObject.quote("offscreen-"+e.id)+";f.src="+JSONObject.quote(url)+";document.body.appendChild(f)})()",null)
                    main.postDelayed({offscreenReady.remove(e.id)?.invoke(Result.failure(IllegalStateException("Offscreen document timed out")))},30000);return
                }
                if(api.startsWith("storage.") || api=="network.fetch" || api.startsWith("declarativeNetRequest.")) {
                    val executor=if(api=="network.fetch")networkIo else io
                    executor.execute { done(runCatching { dispatch(e,endpoint,api,args) }) }
                } else done(runCatching { dispatch(e,endpoint,api,args) })
            }
        }
    }
    private fun reply(id:String,value:Any?,error:String?=null)=JSONObject().put("v",1).put("kind","reply").put("id",id).put("result",value ?: JSONObject.NULL).put("undefined",value==null).also { if(error!=null)it.put("error",error) }
    private fun emit(id:String,name:String,vararg args:Any?) { router.event(id,name,JSONArray(args.toList())) }
    private fun webViewMajor()=WebViewCompat.getCurrentWebViewPackage(context)?.versionName?.substringBefore('.')?.toIntOrNull() ?: 91
    private fun sourceTab(sender:SenderContext)=sender.tabId
    private fun tabJson(tab:ExtensionTab?):JSONObject?=tab?.let { JSONObject().put("id",it.id).put("windowId",1).put("index",it.index).put("url",it.url).put("title",it.title).put("active",it.active).put("highlighted",it.active).put("status",it.status).put("incognito",false).put("pinned",false).put("favIconUrl",it.favIconUrl) }

    // API methods below execute on main unless explicitly classified as IO above.
    private fun dispatch(e:InstalledExtension,source:MessageRouter.Endpoint,api:String,args:JSONArray):Any? {
        val parts=api.split('.');val ns=Capabilities.canonical(parts[0]);val method=parts.last();val id=e.id
        fun objectAt(i:Int=0)=args.optJSONObject(i) ?: JSONObject()
        if(ns=="storage") return storage.call(id,parts[1],method,args,source.sender.type=="content","unlimitedStorage" in e.grantedPermissions)
        if(ns=="network") return network.fetchJson(args.getString(0),objectAt(1),e.grantedHosts)
        if(ns=="runtime") return when(method) {
            "getPlatformInfo" -> JSONObject().put("os","android").put("arch","arm").put("nacl_arch","arm")
            "getManifest" -> e.manifest.json
            "getURL" -> e.manifest.url(args.optString(0))
            "openOptionsPage" -> { openOptions(id); null }
            "reload" -> { main.post { rebuildBindings() }; null }
            "setUninstallURL" -> { val u=args.optString(0); require(u.isEmpty() || MatchPattern.allowedPage(u)); apiState.data(id).put("uninstallURL",u); apiState.save(id); null }
            else -> error("不支持 $api")
        }
        if(ns=="i18n") return when(method) { "getAcceptLanguages"->JSONArray().put("zh-CN").put("zh").put("en");"getUILanguage"->"zh-CN";"getMessage"->e.manifest.message(args.getString(0));else->null }
        if(ns=="extension") return if(method=="getURL") e.manifest.url(args.optString(0)) else false
        if(ns=="tabs") {
            val current=tabs.currentTabId ?: -1
            fun read(tab:ExtensionTab):JSONObject = readableTab(e,tab)
            return when(method) {
                "query" -> { val q=objectAt(); val urls=when(val u=q.opt("url")) { is String->listOf(u);is JSONArray->u.values().map { it as String };else->emptyList() };JSONArray(tabs.query(TabQuery(q.optBoolean("active").takeIf {q.has("active")},q.optBoolean("currentWindow").takeIf {q.has("currentWindow")},q.optInt("windowId").takeIf {q.has("windowId")},urls,q.optString("title").takeIf {q.has("title")},q.optString("status").takeIf {q.has("status")})).map(::read)) }
                "get" -> read(tabs.query().firstOrNull { it.id==args.getInt(0) } ?: error("No tab with id: ${args.getInt(0)}"))
                "getCurrent" -> source.sender.tabId?.let { n -> tabs.query().firstOrNull { it.id==n }?.let(::read) }
                "create" -> { val o=objectAt(); val url=validateTabUrl(e,o.optString("url","about:blank"));val tab=tabs.create(url,o.optBoolean("active",true));ResourceGate.extensionId(url)?.let {extensionTabs[tab.id]=it};read(tab) }
                "update" -> { val explicit=args.opt(0) is Number; val target=if(explicit)args.getInt(0) else current; val o=objectAt(if(explicit)1 else 0);val url=o.optString("url").takeIf {o.has("url")}?.let {validateTabUrl(e,it)};ResourceGate.extensionId(url ?: "")?.let {extensionTabs[target]=it};read(tabs.update(target,url,o.optBoolean("active").takeIf {o.has("active")})) }
                "remove" -> { val ids=if(args.opt(0) is JSONArray) args.getJSONArray(0).values().map { (it as Number).toInt() } else listOf(args.getInt(0));ids.forEach(tabs::remove);null }
                "reload" -> { val explicit=args.opt(0) is Number; tabs.reload(if(explicit)args.getInt(0) else current,objectAt(if(explicit)1 else 0).optBoolean("bypassCache"));null }
                else -> error("不支持 $api")
            }
        }
        if(ns=="windows") { val window=JSONObject().put("id",1).put("focused",true).put("type","normal").put("state","normal").put("incognito",false);if(objectAt().optBoolean("populate"))window.put("tabs",JSONArray(tabs.query().map {readableTab(e,it)}));return when(method) {"getAll"->JSONArray().put(window);"create"->{tabs.create(validateTabUrl(e,objectAt().optString("url","https://chromewebstore.google.com/")));window};else->window} }
        if(ns=="action") {
            val o=objectAt(); val tab=o.optInt("tabId").takeIf {o.has("tabId")};val section=apiState.section(id,"action"); val key=tab?.toString() ?: "default";val value=section.optJSONObject(key) ?: JSONObject().also {section.put(key,it)}
            val current=actionState(id,tab)
            val field=when(method) {"setBadgeText","getBadgeText"->"badgeText";"setBadgeBackgroundColor"->"badgeBackgroundColor";"setBadgeTextColor"->"badgeTextColor";"setTitle"->"title";"setPopup","getPopup"->"popup";"setIcon"->"icon";else->"enabled"}
            when(method) {
                "getBadgeText"->return current.optString(field)
                "getPopup"->return current.optString(field,e.manifest.popup)
                "openPopup"->{val target=tabs.currentTabId ?: -1;post { activate(id,target,userGesture=false) };return null}
                "enable","disable"->{val t=args.optInt(0).takeIf {args.opt(0) is Number};val k=t?.toString() ?: "default";val v=section.optJSONObject(k) ?: JSONObject().also {section.put(k,it)};v.put("enabled",method=="enable")}
                else -> value.put(field,when(method) {"setBadgeText"->o.optString("text");"setTitle"->o.optString("title");"setPopup"->o.optString("popup");"setIcon"->o.opt("path") ?: o.opt("imageData") ?: JSONObject.NULL;else->o.opt("color") ?: JSONObject.NULL})
            }
            apiState.save(id);uiRevision++;return null
        }
        if(ns=="alarms") return alarms.call(id,method,args)
        if(ns=="contextMenus") {
            val menus=apiState.section(id,"menus")
            when(method) {
                "create" -> {val o=objectAt();val key=o.get("id").toString();require(!menus.has(key));require(o.strings("contexts").all {it in setOf("page","link","image","selection","all")});menus.put(key,o);apiState.save(id);return null}
                "update" -> { val key=args.get(0).toString(); val item=menus.optJSONObject(key) ?: error("Cannot find menu item");val update=objectAt(1);update.keys().forEach {item.put(it,update.get(it))} }
                "remove" -> require(menus.remove(args.get(0).toString())!=null)
                "removeAll" -> apiState.data(id).put("menus",JSONObject())
            };apiState.save(id);return null
        }
        if(ns=="permissions") {
            val o=objectAt();val requested=o.strings("permissions").toSet();val hosts=o.strings("origins").toSet()
            return when(method) {
                "contains"->e.grantedPermissions.containsAll(requested) && e.grantedHosts.containsAll(hosts)
                "getAll"->JSONObject().put("permissions",JSONArray(e.grantedPermissions.toList())).put("origins",JSONArray(e.grantedHosts.toList()))
                "remove"->{val removable=requested-e.manifest.permissions;val removableHosts=hosts-e.manifest.hosts;io.execute {repository.save(e.copy(grantedPermissions=e.grantedPermissions-removable,grantedHosts=e.grantedHosts-removableHosts));post { emit(id,"permissions.onRemoved",o);refresh() }};true}
                else->error("不支持 $api")
            }
        }
        if(ns=="scripting") {
            val scripts=apiState.section(id,"scripts")
            val filter=objectAt().strings("ids").toSet()
            when(method) {
                "getRegisteredContentScripts" -> return JSONArray(scripts.keys().asSequence().filter {filter.isEmpty() || it in filter}.map {scripts.getJSONObject(it)}.toList())
                "unregisterContentScripts" -> scripts.keys().asSequence().toList().filter {filter.isEmpty() || it in filter}.forEach(scripts::remove)
                "registerContentScripts","updateContentScripts" -> {
                    val changes=args.getJSONArray(0).values().map {it as JSONObject};val copy=JSONObject(scripts.toString())
                    changes.forEach {s->val key=s.getString("id");require(key.isNotBlank() && !key.startsWith('_'));if(method=="registerContentScripts")require(!copy.has(key)) else require(copy.has(key));val item=if(method=="updateContentScripts")JSONObject(copy.getJSONObject(key).toString()) else JSONObject();s.keys().forEach {item.put(it,s.get(it))};ExtensionManifest.validateContentScript(item,e.root);copy.put(key,item)}
                    apiState.data(id).put("scripts",copy)
                }
            };apiState.save(id);main.post { rebuildContentBindings() };return null
        }
        if(ns=="declarativeNetRequest") {val result=dnr.call(e,method,args);if(method.startsWith("update"))dnr.rebuild(extensions);return result}
        if(ns=="notifications") return notifications.call(e,method,args)
        if(ns=="management")return JSONObject().put("id",id).put("name",e.manifest.name).put("version",e.manifest.version).put("enabled",e.enabled).put("type","extension").put("installType",if(e.source=="store")"normal" else "development").put("permissions",JSONArray(e.grantedPermissions.toList())).put("hostPermissions",JSONArray(e.grantedHosts.toList()))
        if(ns=="offscreen")return when(method) {
            "hasDocument"->offscreenPaths.containsKey(id)
            "closeDocument"->{closeOffscreen(id);null}
            else->null
        }
        if(ns=="webNavigation") {val o=objectAt();val matches=frameInfo.values.filter {it.extensionId==id && it.tabId==o.getInt("tabId")}.distinctBy {it.frameId}.map {JSONObject().put("frameId",it.frameId).put("parentFrameId",if(it.frameId==0)-1 else 0).put("documentId",it.documentId).put("url",it.url).put("errorOccurred",false)};return if(method=="getAllFrames")JSONArray(matches) else matches.firstOrNull {it.getInt("frameId")==o.optInt("frameId")}}
        if(ns=="sidePanel") {
            val value=apiState.section(id,"sidePanel")
            when(method){"setOptions"->{val o=objectAt();o.keys().forEach {value.put(it,o.get(it))};apiState.save(id)};"open"->{require(value.optBoolean("enabled",true));val path=value.optString("path",e.manifest.json.optJSONObject("side_panel")?.optString("default_path") ?: "");require(path.isNotEmpty());popup=id to e.manifest.url(path)};"getOptions"->return JSONObject(value.toString()).put("path",value.optString("path",e.manifest.json.optJSONObject("side_panel")?.optString("default_path") ?: "")).put("enabled",value.optBoolean("enabled",true))};return null
        }
        if(ns=="userScripts") {
            val scripts=apiState.section(id,"userScripts")
            when(method) {
                "getScripts"->{val ids=objectAt().strings("ids");return JSONArray(scripts.keys().asSequence().filter {ids.isEmpty() || it in ids}.map {scripts.getJSONObject(it)}.toList())}
                "unregister"->{val ids=objectAt().strings("ids");scripts.keys().asSequence().toList().filter {ids.isEmpty() || it in ids}.forEach(scripts::remove)}
                "register","update"->{val copy=JSONObject(scripts.toString());args.getJSONArray(0).values().forEach {raw->val s=raw as JSONObject;val key=s.getString("id");require(key.isNotBlank());if(method=="register")require(!copy.has(key));val value=if(method=="update")copy.optJSONObject(key) ?: error("未知用户脚本") else JSONObject();s.keys().forEach {value.put(it,s.get(it))};require(value.strings("matches").isNotEmpty());value.objects("js").forEach {js->require(js.has("file") xor js.has("code"));if(js.has("file"))require(SafeZip.path(e.root,js.getString("file").trimStart('/')).isFile)};copy.put(key,value)};apiState.data(id).put("userScripts",copy)}
                "configureWorld"->{apiState.data(id).put("userScriptWorld",objectAt())}
                "getWorldConfigurations"->return JSONArray().put(apiState.data(id).optJSONObject("userScriptWorld") ?: JSONObject())
                "resetWorldConfiguration"->apiState.data(id).remove("userScriptWorld")
            };apiState.save(id);main.post {rebuildContentBindings()};return null
        }
        if(ns=="cookies") {
            val o=objectAt();val url=o.optString("url");require(url.isNotEmpty() && e.grantedHosts.any {MatchPattern.matches(it,url,true)}){"缺少 Cookie 主机权限；getAll 目前需要 url"}
            val cookieManager=CookieManager.getInstance();val cookies=(cookieManager.getCookie(url) ?: "").split(';').mapNotNull {c->val parts=c.trim().split('=',limit=2);if(parts.size==2)parts[0] to parts[1] else null}.associate {it}
            fun cookie(name:String,value:String)=JSONObject().put("name",name).put("value",value).put("domain",java.net.URI(url).host).put("path","/").put("secure",url.startsWith("https:")).put("httpOnly",false).put("session",true).put("storeId","0").put("hostOnly",true)
            return when(method) {
                "get"->cookies[o.getString("name")]?.let {cookie(o.getString("name"),it)}
                "getAll"->JSONArray(cookies.filterKeys { !o.has("name") || it==o.getString("name") }.map {(k,v)->cookie(k,v)})
                "set"->{val name=o.getString("name");val value=o.optString("value");require('\r' !in name && '\n' !in name && ';' !in name && '\r' !in value && '\n' !in value && ';' !in value);val header="$name=$value; Path=${o.optString("path","/")}"+(if(o.optBoolean("secure"))"; Secure" else "")+(if(o.optBoolean("httpOnly"))"; HttpOnly" else "");cookieManager.setCookie(url,header);cookie(name,value)}
                "remove"->{val name=o.getString("name");require(name in cookies);cookieManager.setCookie(url,"$name=; Max-Age=0; Path=/");JSONObject().put("url",url).put("name",name).put("storeId","0")}
                else->null
            }
        }
        if(ns=="downloads") {
            val manager=context.getSystemService(android.app.DownloadManager::class.java);val records=apiState.section(id,"downloads")
            return when(method) {
                "download"->{val o=objectAt();val url=o.getString("url");require(MatchPattern.allowedPage(url));val request=android.app.DownloadManager.Request(Uri.parse(url));val name=o.optString("filename").substringAfterLast('/').replace(Regex("[\\\\:*?\"<>|\\p{Cntrl}]"),"_");if(name.isNotBlank())request.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS,name);request.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);CookieManager.getInstance().getCookie(url)?.let {request.addRequestHeader("Cookie",it)};val downloadId=manager.enqueue(request);records.put(downloadId.toString(),JSONObject().put("url",url));apiState.save(id);downloadId}
                "search"->{val q=objectAt();val ids=records.keys().asSequence().map {it.toLong()}.filter {!q.has("id") || it==q.getLong("id")}.toList();val rows=JSONArray();if(ids.isNotEmpty())manager.query(android.app.DownloadManager.Query().setFilterById(*ids.toLongArray())).use {cursor->while(cursor.moveToNext()){val downloadId=cursor.getLong(cursor.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_ID));rows.put(JSONObject().put("id",downloadId).put("url",records.getJSONObject(downloadId.toString()).getString("url")).put("bytesReceived",cursor.getLong(cursor.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))).put("totalBytes",cursor.getLong(cursor.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_TOTAL_SIZE_BYTES))).put("state",when(cursor.getInt(cursor.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_STATUS))){android.app.DownloadManager.STATUS_SUCCESSFUL->"complete";android.app.DownloadManager.STATUS_FAILED->"interrupted";else->"in_progress"}))}};rows}
                else->null
            }
        }
        error("空境尚不支持 $api")
    }
    private fun validateTabUrl(e:InstalledExtension,url:String):String {
        val mapped=if(url.startsWith("chrome-extension://${e.id}/")) e.manifest.url(url.substringAfter("chrome-extension://${e.id}/")) else if(!url.contains(":") ) e.manifest.url(url) else url
        require(mapped=="about:blank" || runCatching {java.net.URI(mapped).let {it.scheme in setOf("http","https") && it.host!=null && it.rawUserInfo==null && it.host!="appassets.androidplatform.net" && (!ResourceGate.reserved(mapped) || ResourceGate.extensionId(mapped)==e.id)}}.getOrDefault(false)) { "禁止打开此扩展 URL" };return mapped
    }
    private fun requestPermissions(e:InstalledExtension,o:JSONObject,done:(Result<Any?>)->Unit) {
        val perms=o.strings("permissions").toSet();val hosts=o.strings("origins").toSet()
        require((e.manifest.optionalPermissions+e.manifest.permissions).containsAll(perms) && (e.manifest.optionalHosts+e.manifest.hosts).containsAll(hosts)) {"未在 manifest 声明的可选权限"}
        require(permissionPrompt==null) {"另一个权限请求正在等待处理"}
        permissionPrompt=PermissionPrompt(e.id,perms,hosts) { approved ->
            permissionPrompt=null
            if(!approved)done(Result.success(false)) else io.execute { repository.save(e.copy(grantedPermissions=e.grantedPermissions+perms,grantedHosts=e.grantedHosts+hosts));post {emit(e.id,"permissions.onAdded",o);refresh {done(Result.success(true))} } }
        }
    }
    private fun inject(e:InstalledExtension,source:MessageRouter.Endpoint,api:String,args:JSONArray,done:(Result<Any?>)->Unit) {
        val legacy=api.startsWith("tabs.");val details=if(legacy)args.optJSONObject(1) ?: args.getJSONObject(0) else args.getJSONObject(0)
        val target=if(legacy)JSONObject().put("tabId",if(args.opt(0) is Number)args.getInt(0) else tabs.currentTabId).put("allFrames",details.optBoolean("allFrames")) else details.getJSONObject("target")
        val tabId=target.getInt("tabId");val tab=tabs.query().firstOrNull {it.id==tabId} ?: error("No tab with id: $tabId")
        require(MatchPattern.allowedPage(tab.url) && (mayAccess(e,tabId,tab.url) || e.id to tabId in grants)) {"无法访问此网页"}
        val frames=target.optJSONArray("frameIds")?.values()?.map {(it as Number).toInt()}?.toSet()
        require(!(target.optBoolean("allFrames") && frames!=null))
        val endpoints=frameInfo.filter {(_,s)->s.extensionId==e.id && s.type=="content" && s.tabId==tabId && mayAccess(e,tabId,s.url) && (target.optBoolean("allFrames") || if(frames!=null)s.frameId in frames else s.frameId==0)}
        if(endpoints.isEmpty()) {done(Result.failure(IllegalStateException("Could not establish connection. Receiving end does not exist. Reload the page after enabling the extension.")));return}
        val isCss=api.endsWith("CSS"); val op=if(api.endsWith("removeCSS"))"removeCSS" else if(isCss)"insertCSS" else "executeScript"
        val files=details.strings("files")+details.optString("file").takeIf {it.isNotEmpty()}.let {if(it==null)emptyList() else listOf(it)}
        val code=if(files.isNotEmpty())files.joinToString("\n") {SafeZip.path(e.root,it.trimStart('/')).readText()} else if(details.has("func")) "return ("+details.getString("func")+")(..."+(details.optJSONArray("args") ?: JSONArray())+");" else details.optString(if(isCss)"css" else "code")
        val results=mutableListOf<JSONObject>();var waiting=endpoints.size;var finished=false
        val injectionId=UUID.randomUUID().toString()
        val timeout=Runnable {if(!finished){finished=true;endpoints.keys.forEach {injectionWaiters.remove("$it:$injectionId")};done(Result.failure(IllegalStateException("Script injection timed out")))}}
        main.postDelayed(timeout,30000)
        endpoints.entries.sortedBy {it.value.frameId}.forEach { (key,sender) ->
            injectionWaiters["$key:$injectionId"]={result->
                if(!finished)result.fold({value->results+=JSONObject().put("frameId",sender.frameId).put("documentId",sender.documentId).put("result",value ?: JSONObject.NULL);if(--waiting==0){finished=true;main.removeCallbacks(timeout);done(Result.success(if(legacy)JSONArray(results.sortedBy {it.getInt("frameId")}.map {it.opt("result")}) else JSONArray(results.sortedBy {it.getInt("frameId")}))) }},{finished=true;main.removeCallbacks(timeout);done(Result.failure(it))})
            }
            router.endpoint(key)?.send?.invoke(JSONObject().put("v",1).put("kind","inject").put("id",injectionId).put("op",op).put("code",code).put("functionBody",details.has("func")).put("world",details.optString("world","ISOLATED")).put("cssKey",code.hashCode().toString()))
        }
    }
    override fun intercept(tab:TabHandle,request:WebResourceRequest):WebResourceResponse? {
        interceptResource(request,ResourceGate.extensionId(request.url.toString())==extensionTabs[tab.id] && extensionTabs[tab.id]!=null)?.let {return it}
        val url=request.url.toString();if(!MatchPattern.allowedPage(url))return null
        val initiator=request.requestHeaders.entries.firstOrNull {it.key.equals("Referer",true)}?.value ?: ""
        val match=dnr.engine?.match(DnrRequest(url,initiator,DnrEngine.resourceType(request.isForMainFrame,request.requestHeaders),request.method,tab.id),if(request.isForMainFrame)emptyMap()else inheritedAllows[tab.id] ?: emptyMap()) ?: return null
        if(request.isForMainFrame && match.action=="allowAllRequests")inheritedAllows[tab.id]=mapOf(match.extensionId to match.priority)
        return when(match.action) {
            "block" -> {val body=if(request.isForMainFrame)"<!doctype html><meta charset=utf-8><h2>此网页已被扩展拦截</h2><p>${get(match.extensionId)?.manifest?.name?.replace("<","&lt;") ?: "扩展"}</p>" else "";WebResourceResponse(if(request.isForMainFrame)"text/html" else "text/plain","utf-8",200,"OK",mapOf("Cache-Control" to "no-store"),ByteArrayInputStream(body.toByteArray()))}
            // Android WebResourceResponse forbids 3xx statuses. Reissue safe GET redirects through native,
            // preserving host permission checks instead of passing an invalid 302 to WebView.
            "redirect","upgradeScheme" -> match.redirectUrl?.takeIf {request.method=="GET"}?.let { target ->
                if(ResourceGate.reserved(target)) resourceResponse(get(match.extensionId)?.let {ResourceGate.resolve(it,target,initiator) } ?: ResourceGate.Resource(404,"text/plain",byteArrayOf()))
                else runCatching {val r=network.request(target,headers=request.requestHeaders,allowed={MatchPattern.allowedPage(it)});WebResourceResponse(r.headers.entries.firstOrNull {it.key.equals("Content-Type",true)}?.value?.substringBefore(';') ?: "application/octet-stream","utf-8",r.status.takeUnless {it in 300..399} ?: 502,"Response",r.headers,ByteArrayInputStream(r.body))}.getOrNull()
            }
            else -> null
        }
    }
    private fun interceptResource(request:WebResourceRequest,trusted:Boolean):WebResourceResponse? {
        val url=request.url.toString();if(!ResourceGate.reserved(url))return null
        val e=ResourceGate.extensionId(url)?.let(::get) ?: return resourceResponse(ResourceGate.Resource(404,"text/plain",byteArrayOf()))
        val ref=request.requestHeaders.entries.firstOrNull {it.key.equals("Referer",true)}?.value
        val path=request.url.path
        if(trusted && path in setOf("/_kj/background.html","/_kj/worker-shim.js")) {
            val text=if(path!!.endsWith(".html"))ScriptBuilder.background(e) else ScriptBuilder.workerShim
            return resourceResponse(ResourceGate.Resource(200,if(path.endsWith(".html"))"text/html" else "application/javascript",text.toByteArray()))
        }
        return resourceResponse(ResourceGate.resolve(e,url,ref,trusted))
    }
    private fun resourceResponse(r:ResourceGate.Resource)=WebResourceResponse(r.mime,"utf-8",r.status,if(r.status==200)"OK" else "Not Found",r.headers,ByteArrayInputStream(r.bytes))
    override fun onNavigationStarted(tab:TabHandle,url:String,frame:ExtensionFrame) {
        if(frame.frameId==0) {inheritedAllows.remove(tab.id);grants.removeAll {it.second==tab.id};bindings.filter {it.tab==tab}.forEach {b->b.documents.values.forEach {router.unregister(it);frameInfo.remove(it)};b.documents.clear()} }
        navigation("onBeforeNavigate",tab,url,frame)
    }
    override fun onNavigationCommitted(tab:TabHandle,url:String,frame:ExtensionFrame)=navigation("onCommitted",tab,url,frame)
    override fun onNavigationDomContentLoaded(tab:TabHandle,url:String,frame:ExtensionFrame)=navigation("onDOMContentLoaded",tab,url,frame)
    override fun onNavigationCompleted(tab:TabHandle,url:String,frame:ExtensionFrame)=navigation("onCompleted",tab,url,frame)
    override fun onNavigationHistoryStateUpdated(tab:TabHandle,url:String,frame:ExtensionFrame)=navigation("onHistoryStateUpdated",tab,url,frame)
    private fun navigation(name:String,tab:TabHandle,url:String,frame:ExtensionFrame) {extensions.filter {it.enabled && "webNavigation" in it.grantedPermissions}.forEach {emit(it.id,"webNavigation.$name",JSONObject().put("tabId",tab.id).put("url",url).put("frameId",frame.frameId).put("parentFrameId",frame.parentFrameId).put("timeStamp",System.currentTimeMillis()))} }
    private fun readableTab(e:InstalledExtension,tab:ExtensionTab):JSONObject = tabJson(tab)!!.also {json->if("tabs" !in e.grantedPermissions && !mayAccess(e,tab.id,tab.url)) {json.remove("url");json.remove("title");json.remove("favIconUrl")}}
    override fun onTabCreated(tab:ExtensionTab) {extensions.filter {it.enabled}.forEach {emit(it.id,"tabs.onCreated",readableTab(it,tab))} }
    override fun onTabActivated(tab:TabHandle) {extensions.filter {it.enabled}.forEach {emit(it.id,"tabs.onActivated",JSONObject().put("tabId",tab.id).put("windowId",1))} }
    override fun onTabRemoved(tab:TabHandle) {detach(tab);grants.removeAll {it.second==tab.id};extensions.filter {it.enabled}.forEach {emit(it.id,"tabs.onRemoved",tab.id,JSONObject().put("windowId",1).put("isWindowClosing",false))} }
    override fun onTabUpdated(tab:ExtensionTab,changed:Set<String>) {extensions.filter {it.enabled}.forEach {e->val all=readableTab(e,tab);val diff=JSONObject();changed.forEach {if(all.has(it))diff.put(it,all.get(it))};emit(e.id,"tabs.onUpdated",tab.id,diff,all)} }
    override fun contextMenuItems(target:ExtensionContextTarget):List<ExtensionMenuItem> = extensions.filter {it.enabled}.flatMap {e->
        val menus=apiState.section(e.id,"menus");menus.keys().asSequence().map {menus.getJSONObject(it)}.filter {m->
            val contexts=m.strings("contexts").ifEmpty {listOf("page")};val kind=when {target.selectionText!=null->"selection";target.srcUrl!=null->"image";target.linkUrl!=null->"link";else->"page"}
            (kind in contexts || "all" in contexts) && m.optBoolean("visible",true) && (m.strings("documentUrlPatterns").isEmpty() || m.strings("documentUrlPatterns").any {MatchPattern.matches(it,target.pageUrl)})
        }.map {m->ExtensionMenuItem(e.id,m.get("id").toString(),m.optString("title").replace("%s",target.selectionText ?: ""),m.optBoolean("enabled",true),m.optBoolean("checked").takeIf {m.has("checked")})}.toList()
    }
    override fun clickContextMenu(item:ExtensionMenuItem,target:ExtensionContextTarget) {if(item.enabled)emit(item.extensionId,"contextMenus.onClicked",JSONObject().put("menuItemId",item.id).put("pageUrl",target.pageUrl).put("linkUrl",target.linkUrl).put("srcUrl",target.srcUrl).put("selectionText",target.selectionText).put("frameId",target.frame.frameId),tabJson(tabs.query().firstOrNull {it.id==target.tab.id}))}
    override fun setForeground(foreground:Boolean) {this.foreground=foreground;main.removeCallbacks(tick);extensions.filter {it.enabled}.forEach {emit(it.id,"_host.visibility",foreground)};if(foreground){hostView?.onResume();if(extensions.isNotEmpty())notifications.drain();if(hostView!=null)main.post(tick)}else hostView?.onPause()}
    private fun closeOffscreen(id:String) {offscreenPaths.remove(id);offscreenReady.remove(id)?.invoke(Result.failure(IllegalStateException("Offscreen document closed")));hostView?.evaluateJavascript("document.getElementById("+JSONObject.quote("offscreen-$id")+")?.remove()",null)}
    override fun destroy() {alive=false;main.removeCallbacksAndMessages(null);bindings.toList().forEach(::unbind);offscreenPaths.clear();offscreenReady.clear();hostView?.destroy();hostView=null;if(notificationService.isInitialized())notifications.destroy();io.shutdown();networkIo.shutdownNow()}
}
