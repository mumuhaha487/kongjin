package re.inc.kongjing.browser

import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import re.inc.kongjing.browser.core.ExtensionTabIds
import re.inc.kongjing.browser.core.MobileUiPolicy
import re.inc.kongjing.browser.core.UrlRules
import re.inc.kongjing.browser.ext.api.*
import re.inc.kongjing.browser.ext.ExtensionManager

/** Native ownership boundary. The extension package owns runtime and all extension screens. */
class NativeExtensions(private val browser:BrowserController) {
    private val ids=ExtensionTabIds()
    private val snapshots=mutableMapOf<Int,ExtensionTab>()
    val tabs=object:TabController {
        override val currentTabId:Int? get()=browser.tabs.firstOrNull{it.id==browser.activeId&&!it.home}?.let{ids.id(it.id)}
        override fun query(query:TabQuery):List<ExtensionTab> = browser.tabs.filterNot{it.home}.map(::snapshot).filter{
            (query.active==null||query.active==it.active)&&(query.currentWindow!=false)&&(query.windowId==null||query.windowId in setOf(1,-2))&&
            (query.status==null||query.status==it.status)&&(query.title==null||MobileUiPolicy.matches(query.title,it.title))&&
            (query.urls.isEmpty()||query.urls.any{pattern->MobileUiPolicy.matches(pattern,it.url)})
        }
        override fun create(url:String,active:Boolean):ExtensionTab {
            require(url=="about:blank"||UrlRules.webUrl(url)!=null&&!UrlRules.isAssetOrigin(url)){"URL not allowed"}
            return snapshot(browser.createExtensionPage(url,active))
        }
        override fun update(tabId:Int,url:String?,active:Boolean?):ExtensionTab {
            val tab=resolve(tabId)
            if(url!=null){require(UrlRules.webUrl(url)!=null&&!UrlRules.isAssetOrigin(url)){"URL not allowed"};browser.loadExtensionTab(tab,url)}
            if(active==true)browser.select(tab.id)
            return snapshot(tab)
        }
        override fun remove(tabId:Int){browser.closeTab(resolve(tabId).id)}
        override fun reload(tabId:Int,bypassCache:Boolean){browser.reloadExtensionTab(resolve(tabId),bypassCache)}
    }
    val manager by lazy { ExtensionManager(browser.activity,tabs) }
    val host:ExtensionHost get()=manager
    private fun resolve(id:Int)=browser.tabs.firstOrNull{it.id==ids.native(id)&&!it.home}?:error("Unknown tab")
    fun handle(tab:BrowserTab)=TabHandle(ids.id(tab.id))
    fun snapshot(tab:BrowserTab)=ExtensionTab(ids.id(tab.id),tab.url,tab.title,tab.id==browser.activeId,if(tab.progress<1f)"loading"else"complete",tab.faviconUrl,browser.tabs.filterNot{it.home}.indexOf(tab),incognito=tab.incognito)
    fun created(tab:BrowserTab){if(tab.home)return;val data=snapshot(tab);if(snapshots.putIfAbsent(data.id,data)==null)host.onTabCreated(data)}
    fun updated(tab:BrowserTab){if(tab.home)return;created(tab);val data=snapshot(tab);val before=snapshots.put(data.id,data);val changed=buildSet{if(before?.url!=data.url)add("url");if(before?.title!=data.title)add("title");if(before?.favIconUrl!=data.favIconUrl)add("favIconUrl");if(before?.status!=data.status)add("status")};if(changed.isNotEmpty())host.onTabUpdated(data,changed)}
    fun activated(tab:BrowserTab){if(!tab.home){created(tab);host.onTabActivated(handle(tab))}}
    fun attach(tab:BrowserTab,view:WebView){created(tab);host.attach(handle(tab),view)}
    fun detach(tab:BrowserTab){ids.existing(tab.id)?.let{host.detach(TabHandle(it))}}
    fun removed(tab:BrowserTab){val id=ids.existing(tab.id)?:return;host.onTabRemoved(TabHandle(id));snapshots.remove(id);ids.remove(tab.id)}
    fun showManagement(){manager.showManagement()}
    fun extensionName(url:String):String? {
        val host=android.net.Uri.parse(url).host?:return null
        if(!host.endsWith(".ext.kongjing.invalid"))return null
        return manager.get(host.removeSuffix(".ext.kongjing.invalid"))?.manifest?.name
    }
}

@Composable internal fun NativeExtensionCapsule(browser:BrowserController) {
    if(!browser.active.home) re.inc.kongjing.browser.ext.ui.ExtensionCapsuleSlot(browser.extensions.manager,browser.extensions.handle(browser.active).id)
}
@Composable internal fun NativeExtensionContextBar(browser:BrowserController) {
    if(!browser.active.home) Surface(color=MaterialTheme.colorScheme.surface) {
        Box(Modifier.fillMaxWidth(),contentAlignment=Alignment.Center) {
            Box(Modifier.widthIn(max=600.dp).fillMaxWidth()) {
                re.inc.kongjing.browser.ext.ui.ContextBarSlot(browser.extensions.manager,browser.extensions.snapshot(browser.active))
            }
        }
    }
}
@Composable internal fun NativeExtensionOverlays(browser:BrowserController) {
    val manager=browser.extensions.manager
    val open=manager.managementVisible || manager.detailId!=null || manager.actionsTabId!=null || manager.popup!=null || manager.pendingInstall!=null || manager.permissionPrompt!=null
    SideEffect { if(open) browser.toolbarHidden=false }
    re.inc.kongjing.browser.ext.ui.ExtensionOverlays(manager)
}
