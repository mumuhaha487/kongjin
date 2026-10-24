@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package re.inc.kongjing.browser.ext.ui

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.ext.ExtensionManager
import re.inc.kongjing.browser.ext.api.*
import re.inc.kongjing.browser.ext.core.*

// Lucide 0.468.0 / ISC; vector paths, no raster icon dependency.
private val paths=mapOf(
    "Puzzle" to "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
    "ShoppingBag" to "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z M3 6h18 M16 10a4 4 0 0 1-8 0",
    "Back" to "m12 19-7-7 7-7 M5 12h14",
    "Pin" to "M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
    "Ellipsis" to "M5 12h.01 M12 12h.01 M19 12h.01",
)
@Composable private fun ExtIcon(name:String,description:String?,modifier:Modifier=Modifier.size(22.dp),tint:Color=MaterialTheme.colorScheme.onSurface) {
    val vector=remember(name) {ImageVector.Builder(name,24.dp,24.dp,24f,24f).addPath(PathParser().parsePathString(paths.getValue(name)).toNodes(),stroke=SolidColor(Color.Black),strokeLineWidth=1.75f,strokeLineCap=StrokeCap.Round,strokeLineJoin=StrokeJoin.Round).build()}
    Icon(vector,description,modifier,tint)
}
@Composable private fun panel():Color = if(MaterialTheme.colorScheme.background.luminance()<.5f)Color(0xff0c1222) else Color(0xfff7fafe)
@Composable private fun muted()=MaterialTheme.colorScheme.onSurface.copy(alpha=.56f)
@Composable private fun ExtensionIcon(e:InstalledExtension,modifier:Modifier=Modifier.size(40.dp),override:Any?=null) {
    val bitmap by produceState<ImageBitmap?>(null,e.id,e.manifest.version,override) {
        value=withContext(Dispatchers.IO) {
            runCatching {
                val icons=e.manifest.json.optJSONObject("icons") ?: JSONObject()
                val icon=when(override) {is String->override;is JSONObject->override.keys().asSequence().maxByOrNull {it.toIntOrNull() ?: 0}?.let {override.getString(it)};else->icons.keys().asSequence().maxByOrNull {it.toIntOrNull() ?: 0}?.let {icons.getString(it)}} ?: return@runCatching null
                if(icon.startsWith("data:image/png;base64,")) {val bytes=android.util.Base64.decode(icon.substringAfter(','),android.util.Base64.DEFAULT);BitmapFactory.decodeByteArray(bytes,0,bytes.size)?.asImageBitmap()}
                else {val file=SafeZip.path(e.root,icon.trimStart('/'));BitmapFactory.decodeFile(file.path)?.asImageBitmap()}
            }.getOrNull()
        }
    }
    Box(modifier.clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceVariant),contentAlignment=Alignment.Center) {
        if(bitmap!=null)Image(bitmap!!,e.manifest.name,Modifier.fillMaxSize().padding(2.dp)) else ExtIcon("Puzzle",e.manifest.name,Modifier.fillMaxSize().padding(7.dp),muted())
    }
}
@Composable private fun Badge(state:JSONObject) {
    val text=state.optString("badgeText");if(text.isBlank())return
    val bg=runCatching {when(val c=state.opt("badgeBackgroundColor")) {is String->Color(android.graphics.Color.parseColor(c));is JSONArray->Color(c.getInt(0),c.getInt(1),c.getInt(2),if(c.length()>3)c.getInt(3) else 255);else->Color(0xff5f6368)}}.getOrDefault(Color(0xff5f6368))
    Box(Modifier.background(bg,RoundedCornerShape(4.dp)).padding(horizontal=4.dp,vertical=1.dp)) {Text(text, fontSize=10.sp,color=Color.White,maxLines=1)}
}
@Composable fun ExtensionCapsuleSlot(manager:ExtensionManager,tabId:Int) {
    manager.uiRevision
    if(!manager.supported)return
    val enabled=manager.extensions.filter {it.enabled};if(enabled.isEmpty())return
    Row(verticalAlignment=Alignment.CenterVertically) {
        enabled.firstOrNull {it.pinned}?.let {e->IconButton(onClick={manager.activate(e.id,tabId)},modifier=Modifier.size(32.dp)) {Box {ExtensionIcon(e,Modifier.size(22.dp),manager.actionState(e.id,tabId).opt("icon"));Box(Modifier.align(Alignment.TopEnd)){Badge(manager.actionState(e.id,tabId))}}}}
        IconButton(onClick={manager.actionsTabId=tabId},modifier=Modifier.size(32.dp)) {ExtIcon("Puzzle","扩展",Modifier.size(20.dp))}
    }
}
@Composable fun ContextBarSlot(manager:ExtensionManager,tab:ExtensionTab) {
    val id=MatchPattern.storeId(tab.url);val installed=manager.extensions.any {it.id==id}
    AnimatedVisibility(visible=id!=null,enter=slideInVertically(tween(220,easing=CubicBezierEasing(.2f,.8f,.2f,1f))){it}+expandVertically(tween(220)),exit=slideOutVertically(tween(220)){it}+shrinkVertically(tween(220))) {
        Surface(color=panel()) {Column {HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant);Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal=16.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)) {
            ExtIcon("ShoppingBag",null,Modifier.size(20.dp));Text(if(installed)"已添加到空境" else "可以添加到空境",Modifier.weight(1f),fontSize=14.sp,maxLines=1)
            Button(onClick={if(installed){manager.detailId=id;manager.showManagement()}else if(id!=null)manager.installFromStore(id)},enabled=!manager.busy,shape=RoundedCornerShape(18.dp),modifier=Modifier.height(36.dp),contentPadding=PaddingValues(horizontal=14.dp),colors=if(installed)ButtonDefaults.filledTonalButtonColors() else ButtonDefaults.buttonColors()) {
                if(manager.busy)CircularProgressIndicator(Modifier.size(16.dp),strokeWidth=2.dp) else Text(if(installed)"管理" else "添加到空境",maxLines=1,fontSize=14.sp)
            }
        }}}
    }
}
@Composable private fun EmptyState(manager:ExtensionManager) {
    val context=LocalContext.current
    Column(Modifier.fillMaxSize().padding(28.dp),verticalArrangement=Arrangement.Center,horizontalAlignment=Alignment.CenterHorizontally) {
        ExtIcon("Puzzle",null,Modifier.size(48.dp),muted());Spacer(Modifier.height(20.dp))
        Text(if(manager.supported)"还没有扩展" else "需要更新系统组件",fontSize=17.sp,fontWeight=FontWeight.SemiBold)
        Spacer(Modifier.height(10.dp));Text(if(manager.supported)"可以从 Chrome 应用商店添加扩展。" else "请先更新 Android System WebView，然后才能使用扩展。",fontSize=14.sp,color=muted())
        Spacer(Modifier.height(24.dp));Button(onClick={if(manager.supported)manager.tabs.create("https://chromewebstore.google.com/")else context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:com.google.android.webview")))},shape=RoundedCornerShape(20.dp)) {Text(if(manager.supported)"打开 Chrome 应用商店" else "前往更新",maxLines=1)}
    }
}
@Composable fun ExtensionManagementPage(manager:ExtensionManager,onBack:()->Unit) {
    var more by remember {mutableStateOf(false)};var input by remember {mutableStateOf(false)};var link by remember {mutableStateOf("")}
    val file=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {uri->uri?.let(manager::installFromFile)}
    Surface(Modifier.fillMaxSize(),color=panel()) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(end=8.dp),verticalAlignment=Alignment.CenterVertically) {
                IconButton(onClick=onBack){ExtIcon("Back","返回")};Text("扩展程序",Modifier.weight(1f),fontSize=20.sp,fontWeight=FontWeight.SemiBold,maxLines=1)
                TextButton(onClick={manager.tabs.create("https://chromewebstore.google.com/");onBack()}){Text("获取扩展",maxLines=1)}
                Box {IconButton(onClick={more=true}){ExtIcon("Ellipsis","更多")};DropdownMenu(more,{more=false}) {
                    DropdownMenuItem(text={Text("通过链接或 ID 安装")},onClick={more=false;input=true})
                    DropdownMenuItem(text={Text("从文件安装")},onClick={more=false;file.launch(arrayOf("application/x-chrome-extension","application/zip","application/octet-stream"))})
                    DropdownMenuItem(text={Text("检查更新")},onClick={more=false;manager.checkUpdates()})
                }}
            }
            if(manager.extensions.isEmpty() || !manager.supported)EmptyState(manager)
            else LazyColumn {items(manager.extensions,key={it.id}) {e->
                Row(Modifier.fillMaxWidth().height(64.dp).clickable {manager.detailId=e.id}.padding(horizontal=20.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    ExtensionIcon(e)
                    Column(Modifier.weight(1f)) {
                        Text(e.manifest.name,fontSize=15.sp,maxLines=1,overflow=TextOverflow.Ellipsis)
                        val report=rememberCompatibility(e)
                        Text(e.manifest.version+" · "+when {e.needsPermission->"需要新的权限 · 查看";!e.enabled->"已停用";report.level!=CompatibilityLevel.SUPPORTED->"部分功能不可用";else->"已启用"},fontSize=12.sp,color=muted(),maxLines=1,overflow=TextOverflow.Ellipsis)
                    }
                    Switch(e.enabled,{if(e.needsPermission)manager.detailId=e.id else manager.setEnabled(e.id,it)})
                }
            }}
        }
    }
    if(input)AlertDialog(onDismissRequest={input=false},title={Text("通过链接或 ID 安装")},text={OutlinedTextField(link,{link=it},label={Text("Chrome 应用商店链接或扩展 ID")},singleLine=true)},confirmButton={TextButton(onClick={input=false;manager.installFromStore(link)}){Text("继续")}},dismissButton={TextButton(onClick={input=false}){Text("取消")}})
}
@Composable private fun Label(text:String) {Text(text,Modifier.padding(top=22.dp,bottom=10.dp),fontSize=12.sp,color=muted())}
@Composable private fun Line(title:String,subtitle:String?=null,action:(()->Unit)?=null,danger:Boolean=false) {
    Column(Modifier.fillMaxWidth().then(if(action==null)Modifier else Modifier.clickable(onClick=action)).padding(vertical=12.dp)) {Text(title,fontSize=15.sp,color=if(danger)MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface);if(subtitle!=null)Text(subtitle,fontSize=12.sp,color=muted())}
}
@Composable private fun Compatibility(report:CompatibilityReport) {
    Text(when(report.level){CompatibilityLevel.SUPPORTED->"可以在空境中使用";CompatibilityLevel.PARTIAL->"大部分功能可以使用，以下功能在手机上不可用：";CompatibilityLevel.BLOCKED->"无法使用"},fontSize=14.sp,color=if(report.level==CompatibilityLevel.SUPPORTED)Color(0xff27ad7b) else MaterialTheme.colorScheme.onSurface)
    report.issues.forEach {Text("• $it",Modifier.padding(top=6.dp),fontSize=14.sp,color=muted())}
    if(report.isolationWarning)Text("在空境中，此扩展的网页脚本与网页运行在同一环境。不建议使用密码管理类扩展。",Modifier.padding(top=12.dp),fontSize=13.sp,color=muted())
}
@Composable private fun rememberCompatibility(e:InstalledExtension):CompatibilityReport {
    val report by produceState(CompatibilityReport(CompatibilityLevel.PARTIAL,listOf("正在分析兼容性"),e.manifest.contentScripts.isNotEmpty()),e.id,e.manifest.version) {
        value=withContext(Dispatchers.IO) {Capabilities.analyze(e.manifest,e.root)}
    }
    return report
}
@Composable private fun ExtensionDetail(manager:ExtensionManager,e:InstalledExtension) {
    var remove by remember {mutableStateOf(false)};var siteInput by remember {mutableStateOf(false)};var site by remember {mutableStateOf("")};var siteError by remember {mutableStateOf(false)}
    val report=rememberCompatibility(e)
    var bytes by remember(e.id) {mutableLongStateOf(0)};LaunchedEffect(e.id,manager.uiRevision){bytes=withContext(Dispatchers.IO){manager.storageBytes(e.id)}}
    Surface(Modifier.fillMaxSize(),color=panel()) {Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        Row(Modifier.height(56.dp).fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {IconButton(onClick={manager.detailId=null}){ExtIcon("Back","返回")};Text(e.manifest.name,fontSize=20.sp,fontWeight=FontWeight.SemiBold,maxLines=1,overflow=TextOverflow.Ellipsis)}
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal=20.dp)) {
            Row(Modifier.padding(vertical=16.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(14.dp)) {ExtensionIcon(e,Modifier.size(48.dp));Column {Text(e.manifest.name,fontSize=17.sp,fontWeight=FontWeight.SemiBold);Text(e.manifest.version,fontSize=12.sp,color=muted())}}
            Text(e.manifest.json.optString("description"),fontSize=14.sp,color=muted())
            if(e.needsPermission) {Line("需要新的权限",action={manager.approveUpdate(e.id)});PermissionText.describe(e.manifest.permissions,e.manifest.hosts).forEach {Text(it,fontSize=14.sp)}}
            Label("网站访问权限")
            listOf("all" to "在所有网站上","specific" to "在特定网站上","click" to "点击时").forEach {(mode,text)->Row(Modifier.fillMaxWidth().heightIn(min=48.dp).clickable {manager.setSiteAccess(e.id,mode,e.sites)},verticalAlignment=Alignment.CenterVertically) {RadioButton(e.access==mode,{manager.setSiteAccess(e.id,mode,e.sites)});Text(text,fontSize=15.sp)}}
            if(e.access=="specific") {e.sites.forEach {url->Row(verticalAlignment=Alignment.CenterVertically) {Text(url,Modifier.weight(1f),fontSize=14.sp);TextButton(onClick={manager.setSiteAccess(e.id,"specific",e.sites-url)}){Text("移除")}}};TextButton(onClick={siteInput=true}){Text("添加网站")}}
            Label("权限");PermissionText.describe(e.grantedPermissions,e.grantedHosts).ifEmpty {listOf("此扩展不需要额外权限")}.forEach {Text(it,Modifier.padding(vertical=5.dp),fontSize=14.sp)}
            Label("兼容性");Compatibility(report)
            if(e.manifest.options.isNotBlank())Line("打开选项",action={manager.openOptions(e.id);manager.managementVisible=false})
            Row(Modifier.fillMaxWidth().heightIn(min=52.dp),verticalAlignment=Alignment.CenterVertically) {Text("固定到地址栏",Modifier.weight(1f),fontSize=15.sp);Switch(e.pinned,{manager.pin(e.id)})}
            Line("检查更新",action={manager.checkUpdates(e.id)})
            Label("存储");Text("${"%.1f".format(bytes/1024.0)} KB",fontSize=14.sp);Text("sync 数据保存在本机，不跨设备同步。",fontSize=12.sp,color=muted())
            Label("来源");Text(if(e.source=="store")"Chrome 应用商店" else "文件",fontSize=14.sp)
            Line("移除扩展",action={remove=true},danger=true);Spacer(Modifier.height(32.dp))
        }
    }}
    if(remove)AlertDialog(onDismissRequest={remove=false},title={Text("移除 ${e.manifest.name}？")},text={Text("此扩展的文件、存储、规则、脚本、闹钟和通知会被删除。")},confirmButton={TextButton(onClick={remove=false;manager.remove(e.id)}){Text("移除",color=MaterialTheme.colorScheme.error)}},dismissButton={TextButton(onClick={remove=false}){Text("取消")}})
    if(siteInput)AlertDialog(onDismissRequest={siteInput=false},title={Text("添加网站")},text={OutlinedTextField(site,{site=it;siteError=false},singleLine=true,label={Text("网站域名或网址")},isError=siteError)},confirmButton={TextButton(onClick={val url=if(site.contains("://"))site else "https://$site/";if(MatchPattern.allowedPage(url)){manager.setSiteAccess(e.id,"specific",e.sites+url);siteInput=false;site=""}else siteError=true}){Text("添加")}},dismissButton={TextButton(onClick={siteInput=false}){Text("取消")}})
}
@Composable private fun InstallConfirmation(manager:ExtensionManager,p:PendingInstall) {
    ModalBottomSheet(onDismissRequest=manager::cancelInstall,sheetMaxWidth=600.dp,containerColor=panel(),shape=RoundedCornerShape(topStart=16.dp,topEnd=16.dp)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal=20.dp).navigationBarsPadding()) {
            Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(14.dp)) {ExtensionIcon(InstalledExtension(p.manifest,p.root,p.source,false),Modifier.size(48.dp));Column {Text(p.manifest.name,fontSize=17.sp,fontWeight=FontWeight.SemiBold);Text("${p.manifest.version} · ${"%.1f".format(p.bytes/1024.0)} KB",fontSize=12.sp,color=muted())}}
            Label("它可以：");PermissionText.describe(p.manifest.permissions,p.manifest.hosts).forEach {Text(it,Modifier.padding(vertical=4.dp),fontSize=14.sp)}
            Label("兼容性");Compatibility(p.compatibility)
            if(p.source=="file")Text("此扩展不是从 Chrome 应用商店安装的，请确认来源可信。",Modifier.padding(top=16.dp),fontSize=14.sp,color=MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(24.dp))
            if(p.compatibility.level!=CompatibilityLevel.BLOCKED)Button(onClick=manager::confirmInstall,modifier=Modifier.fillMaxWidth().height(48.dp),shape=RoundedCornerShape(24.dp)) {Text("添加扩展")}
            TextButton(onClick=manager::cancelInstall,modifier=Modifier.fillMaxWidth().padding(bottom=12.dp)) {Text(if(p.compatibility.level==CompatibilityLevel.BLOCKED)"关闭" else "取消")}
        }
    }
}
@Composable private fun ActionsSheet(manager:ExtensionManager,tabId:Int) {
    manager.uiRevision
    var remove by remember {mutableStateOf<String?>(null)}
    ModalBottomSheet(onDismissRequest={manager.actionsTabId=null},sheetMaxWidth=600.dp,containerColor=panel(),shape=RoundedCornerShape(topStart=16.dp,topEnd=16.dp)) {
        Column(Modifier.fillMaxWidth().padding(horizontal=20.dp).navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {Text("扩展",Modifier.weight(1f),fontSize=17.sp,fontWeight=FontWeight.SemiBold);TextButton(onClick={manager.actionsTabId=null;manager.showManagement()}){Text("管理")}}
            manager.extensions.filter {it.enabled}.forEach {e->
                var more by remember(e.id) {mutableStateOf(false)}
                Row(Modifier.fillMaxWidth().height(56.dp).clickable {manager.activate(e.id,tabId)},verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    ExtensionIcon(e,Modifier.size(32.dp),manager.actionState(e.id,tabId).opt("icon"))
                    Column(Modifier.weight(1f)) {Text(e.manifest.name,fontSize=15.sp,maxLines=1,overflow=TextOverflow.Ellipsis);if(e.access=="click")Text("点击以允许在此网站上运行",fontSize=12.sp,color=muted(),maxLines=1)}
                    Badge(manager.actionState(e.id,tabId))
                    Box {IconButton(onClick={more=true}){ExtIcon("Ellipsis","${e.manifest.name} 的操作")};DropdownMenu(more,{more=false}) {
                        DropdownMenuItem(text={Text(if(e.pinned)"取消固定" else "固定到地址栏")},leadingIcon={ExtIcon("Pin",null)},onClick={more=false;manager.pin(e.id)})
                        if(e.manifest.options.isNotBlank())DropdownMenuItem(text={Text("选项")},onClick={more=false;manager.actionsTabId=null;manager.openOptions(e.id)})
                        DropdownMenuItem(text={Text("网站访问权限")},onClick={more=false;manager.actionsTabId=null;manager.detailId=e.id;manager.showManagement()})
                        val tab=manager.tabs.query().firstOrNull {it.id==tabId}
                        if(tab!=null)manager.contextMenuItems(ExtensionContextTarget(TabHandle(tabId),tab.url)).filter {it.extensionId==e.id}.forEach {item->DropdownMenuItem(text={Text(item.title)},enabled=item.enabled,onClick={more=false;manager.clickContextMenu(item,ExtensionContextTarget(TabHandle(tabId),tab.url))})}
                        DropdownMenuItem(text={Text("移除扩展",color=MaterialTheme.colorScheme.error)},onClick={more=false;remove=e.id})
                    }}
                }
            };Spacer(Modifier.height(16.dp))
        }
    }
    remove?.let {id->AlertDialog(onDismissRequest={remove=null},title={Text("移除扩展？")},text={Text(manager.get(id)?.manifest?.name ?: "")},confirmButton={TextButton(onClick={manager.remove(id);remove=null}){Text("移除")}},dismissButton={TextButton(onClick={remove=null}){Text("取消")}})}
}
@Composable private fun PopupSheet(manager:ExtensionManager,id:String,url:String) {
    val context=LocalContext.current;val max=(LocalConfiguration.current.screenHeightDp*.85f).dp
    var measured by remember(url) {mutableStateOf(240.dp)};val height by animateDpAsState(measured.coerceIn(160.dp,max),tween(150),label="扩展弹出页高度")
    val view=remember(url) {WebView(context).also {manager.attachExtensionPage(id,it);it.loadUrl(url)}}
    DisposableEffect(view){onDispose {manager.detachExtensionPage(view)}}
    LaunchedEffect(view) {while(true){view.evaluateJavascript("Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)"){raw->raw.toFloatOrNull()?.let {measured=it.dp}};delay(500)}}
    ModalBottomSheet(onDismissRequest={manager.popup=null},sheetMaxWidth=480.dp,containerColor=panel(),shape=RoundedCornerShape(topStart=16.dp,topEnd=16.dp),dragHandle={Box(Modifier.fillMaxWidth().height(16.dp),contentAlignment=Alignment.Center){Box(Modifier.size(36.dp,4.dp).background(muted().copy(alpha=.4f),RoundedCornerShape(2.dp)))}}) {
        AndroidView(factory={view},modifier=Modifier.fillMaxWidth().height(height).navigationBarsPadding())
    }
}
@Composable fun ExtensionOverlays(manager:ExtensionManager) {
    if(manager.managementVisible)Dialog(onDismissRequest={manager.managementVisible=false},properties=DialogProperties(usePlatformDefaultWidth=false,decorFitsSystemWindows=false)) {
        BackHandler {if(manager.detailId!=null)manager.detailId=null else manager.managementVisible=false}
        val e=manager.detailId?.let(manager::get)
        if(e!=null)ExtensionDetail(manager,e) else ExtensionManagementPage(manager){manager.managementVisible=false}
    }
    manager.actionsTabId?.let {ActionsSheet(manager,it)}
    manager.popup?.let {(id,url)->PopupSheet(manager,id,url)}
    manager.pendingInstall?.let {InstallConfirmation(manager,it)}
    manager.permissionPrompt?.let {p->AlertDialog(onDismissRequest={p.complete(false)},title={Text("${manager.get(p.extensionId)?.manifest?.name ?: "扩展"} 请求权限")},text={Column {PermissionText.describe(p.permissions,p.origins).forEach {Text(it)}}},confirmButton={TextButton(onClick={p.complete(true)}){Text("允许")}},dismissButton={TextButton(onClick={p.complete(false)}){Text("取消")}})}
    manager.error?.let {message->AlertDialog(onDismissRequest={manager.error=null},title={Text("扩展程序")},text={Text(message)},confirmButton={TextButton(onClick={manager.error=null}){Text("关闭")}})}
    if(manager.busy && manager.pendingInstall==null)Dialog(onDismissRequest={}) {Surface(shape=RoundedCornerShape(16.dp),color=panel()) {Row(Modifier.padding(24.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(16.dp)){CircularProgressIndicator(Modifier.size(24.dp),strokeWidth=2.dp);Text("正在准备扩展…",fontSize=15.sp)}}}
}
