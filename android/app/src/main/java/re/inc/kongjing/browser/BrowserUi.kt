@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.animation.ExperimentalSharedTransitionApi::class, androidx.compose.foundation.ExperimentalFoundationApi::class)

package re.inc.kongjing.browser

import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.ui.draw.scale
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import kotlinx.coroutines.delay
import re.inc.kongjing.browser.core.UrlRules
import re.inc.kongjing.browser.core.Suggestion
import re.inc.kongjing.browser.core.SiteVisuals
import re.inc.kongjing.browser.core.HomeInsets
import kotlin.math.abs
import kotlin.math.roundToInt

private val LightBg = Color(0xfff7fafe)
private val DarkBg = Color(0xff0c1222)
private val LightText = Color(0xff121826)
private val DarkText = Color(0xffeef2fa)

@Composable fun BrowserApp(browser: BrowserController) {
    val surface = if (browser.dark) Color(0xff172139) else Color(0xffeaf0f8)
    val text = if (browser.dark) DarkText else LightText
    val border = if (browser.dark) Color(0x33aac8ff) else Color(0x2e1e3c78)
    val scheme = if (browser.dark) darkColorScheme(primary = Color(0xff7db0ff), background = DarkBg, surface = DarkBg, onSurface = DarkText, onBackground = DarkText, scrim = Color(0x66000410),
        secondary = Color(0xff7db0ff), secondaryContainer = Color(0x24a0beff), onSecondaryContainer = text,
        surfaceVariant = surface, onSurfaceVariant = text.copy(alpha = .62f), surfaceContainerHighest = surface, surfaceContainerHigh = Color(0xff0a1020), outline = border, outlineVariant = border.copy(alpha = .1f), error = Color(0xffff6b6b))
        else lightColorScheme(primary = Color(0xff2f6ceb), background = LightBg, surface = LightBg, onSurface = LightText, onBackground = LightText, scrim = Color(0x29101c38),
            secondary = Color(0xff2f6ceb), secondaryContainer = Color(0xf2ffffff), onSecondaryContainer = text,
            surfaceVariant = surface, onSurfaceVariant = text.copy(alpha = .6f), surfaceContainerHighest = surface, surfaceContainerHigh = Color(0xfff7fafe), outline = border, outlineVariant = border.copy(alpha = .1f), error = Color(0xffe5484d))
    var editing by remember { mutableStateOf(false) }
    val density = LocalDensity.current.density
    val safe = WindowInsets.statusBars.union(WindowInsets.displayCutout)
    val direction = androidx.compose.ui.platform.LocalLayoutDirection.current
    val homeStatusBar = browser.active.home && !browser.showTabs
    val homeInsets = HomeInsets(safe.getTop(LocalDensity.current) / density,
        safe.getLeft(LocalDensity.current, direction) / density,
        safe.getRight(LocalDensity.current, direction) / density,
        56f + WindowInsets.navigationBars.getBottom(LocalDensity.current) / density)
    SideEffect { if(browser.sheet != null || editing) browser.toolbarHidden=false; browser.activity.applyBars(browser.dark, homeStatusBar); browser.updateHomeInsets(homeInsets); browser.updateHomeVisibility() }
    BackHandler { if (editing) editing = false else browser.back() }
    MaterialTheme(colorScheme = scheme, typography = Typography(titleLarge = LocalTextStyle.current.copy(fontSize=17.sp, fontWeight=androidx.compose.ui.text.font.FontWeight.SemiBold), bodyLarge=LocalTextStyle.current.copy(fontSize=15.sp))) {
        Surface(Modifier.fillMaxSize(), color = scheme.background) {
            Box(Modifier.fillMaxSize().imePadding()) {
            val hidden = browser.toolbarHidden && !browser.active.home && !editing && browser.sheet==null
            val hideFraction by animateFloatAsState(if(hidden)1f else 0f,tween(200,easing=PanelEase),label="工具栏滑出")
            var toolbarPixels by remember { mutableIntStateOf(0) }
            val toolbarHeight=with(LocalDensity.current){toolbarPixels.toDp()}
            AnimatedContent(targetState=browser.showTabs,transitionSpec={fadeIn(tween(240,easing=PanelEase)) togetherWith fadeOut(tween(240,easing=PanelEase))},label="标签页切换") { tabs ->
                if(tabs) TabSwitcher(browser) { Modifier }
                else Box(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().padding(bottom=if(browser.active.home)0.dp else toolbarHeight*(1f-hideFraction))
                        .then(if(browser.active.home)Modifier else Modifier.windowInsetsPadding(WindowInsets.statusBars.union(WindowInsets.displayCutout).only(WindowInsetsSides.Top+WindowInsetsSides.Horizontal)))) {
                        AndroidView(factory={(browser.container.parent as? ViewGroup)?.removeView(browser.container);browser.container},update={browser.display()},modifier=Modifier.fillMaxSize())
                        browser.active.error?.let { PageError(browser,it) }
                        if(browser.extras.pull>0f&&!browser.active.home) Box(Modifier.fillMaxWidth().padding(top=16.dp),contentAlignment=Alignment.TopCenter) {
                            Surface(shape=CircleShape){CircularProgressIndicator(progress={browser.extras.pull.coerceAtMost(1f)},modifier=Modifier.padding(12.dp).size(24.dp),strokeWidth=2.dp)}
                        }
                        if(browser.find)FindBar(browser)
                    }
                    Column(Modifier.align(Alignment.BottomCenter).onSizeChanged{toolbarPixels=it.height}.graphicsLayer{translationY=toolbarPixels*hideFraction}){
                        NativeExtensionContextBar(browser)
                        Toolbar(browser,editing,{editing=it})
                    }
                    if(hidden&&browser.active.progress<1f)LinearProgressIndicator(progress={browser.active.progress},modifier=Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(2.dp),trackColor=Color.Transparent)
                }
            }
                if (editing) AddressEditor(browser) { editing=false }
                IncomingBanner(browser)
                BrowserMessageBar(browser)
                NativeExtensionOverlays(browser)
            }
        }
        BrowserSheets(browser)
        FeatureDialogs(browser)
        if (browser.extras.scanner) QrScanner(browser)
        browser.externalUrl?.let { url ->
            BrowserDialog(onDismissRequest = { browser.externalUrl = null }, title = { Text("在其他应用中打开？") },
                text = { Text(url.take(300), maxLines = 5, overflow = TextOverflow.Ellipsis) },
                confirmButton = { TextButton(onClick = { browser.openExternal(url) }) { Text("打开") } },
                dismissButton = { TextButton(onClick = { browser.externalUrl = null }) { Text("取消") } })
        }
        browser.consent?.let { consent ->
            BrowserDialog(onDismissRequest = { consent.complete(false); browser.consent = null }, title = { Text("允许网页使用${consent.purpose}？") },
                text = { Text(consent.origin) }, confirmButton = {
                    TextButton(onClick = {
                        browser.activity.requestPermissionsFor(consent.permissions) {
                            if (browser.consent === consent) { consent.complete(true); browser.consent = null }
                        }
                    }) { Text("允许") }
                }, dismissButton = { TextButton(onClick = { consent.complete(false); browser.consent = null }) { Text("拒绝") } })
        }
    }
}

@Composable internal fun LineIcon(resource: Int, label: String?, modifier: Modifier = Modifier, tint: Color = LocalContentColor.current) {
    Icon(painterResource(resource), label, modifier.size(22.dp), tint)
}
@Composable internal fun ToolButton(resource: Int, label: String, enabled: Boolean = true, action: () -> Unit) {
    val interaction=remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if(pressed).96f else 1f,tween(100),label="工具按钮按下")
    IconButton(onClick = action, enabled = enabled, interactionSource=interaction, modifier = Modifier.size(40.dp).scale(scale)) {
        LineIcon(resource, label, Modifier.alpha(if (enabled) 1f else .4f), MaterialTheme.colorScheme.onSurface)
    }
}
@Composable internal fun Favicon(tab: BrowserTab, size: Int) {
    val bitmap = tab.icon
    if (tab.home) Image(painterResource(R.drawable.logo_small), null, Modifier.size(size.dp))
    else if (bitmap != null) Image(bitmap.asImageBitmap(), null, Modifier.size(size.dp))
    else {
        val host = UrlRules.host(tab.url)
        val hue = SiteVisuals.hue(host)
        Box(Modifier.size(size.dp).clip(RoundedCornerShape((size * .22f).dp))
            .background(Color.hsl(hue, .40f, .52f, .10f)), contentAlignment = Alignment.Center) {
            Text(host.take(1).uppercase(java.util.Locale.ROOT), fontSize = (size * .6).sp,
                color = Color.hsl(hue, .42f, .38f), maxLines = 1)
        }
    }
}
@Composable private fun FindBar(browser: BrowserController) {
    var query by remember { mutableStateOf("") }
    Surface(Modifier.fillMaxWidth(), shadowElevation = 2.dp) {
        Column {
            TextField(query, { query = it; browser.searchPage(it) }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("在页面中查找", fontSize = 14.sp) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { browser.view().findNext(true) }))
            Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${browser.findIndex}/${browser.findCount}", Modifier.weight(1f), fontSize = 12.sp)
            ToolButton(R.drawable.ic_up, "上一个") { browser.view().findNext(false) }
            ToolButton(R.drawable.ic_down, "下一个") { browser.view().findNext(true) }
            ToolButton(R.drawable.ic_close, "关闭查找", action = browser::closeFind)
            }
        }
    }
}

@Composable private fun BrowserSheets(browser: BrowserController) {
    val sheet = browser.sheet ?: return
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = { browser.sheet = null }, sheetState = state, sheetMaxWidth = 600.dp, shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
        scrimColor = MaterialTheme.colorScheme.scrim, containerColor = MaterialTheme.colorScheme.surface,
        dragHandle = { Box(Modifier.padding(top = 8.dp, bottom = 12.dp).size(36.dp, 4.dp).clip(CircleShape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = .24f))) }) {
        // Material 3 1.3's dialog otherwise derives system-bar icons from the OS theme.
        val view = LocalView.current
        val dark = browser.dark
        SideEffect { view.post {
            val window = generateSequence(view) { it.parent as? android.view.View }
                .filterIsInstance<DialogWindowProvider>().firstOrNull()?.window
            if (window != null) WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        } }
        Column(Modifier.fillMaxWidth().then(if(sheet=="menu")Modifier else Modifier.verticalScroll(rememberScrollState())).padding(start = 20.dp, end = 20.dp, bottom = if(sheet=="menu")0.dp else 20.dp)) {
            when (sheet) {
                "menu" -> MenuSheet(browser)
                "bookmark" -> BookmarkSheet(browser)
                "context" -> ContextSheet(browser)
                "devices" -> DevicesSheet(browser)
                else -> FeatureSheet(browser,sheet)
            }
        }
    }
}
@Composable private fun DevicesSheet(browser: BrowserController) {
    Text("发送到设备", fontSize = 17.sp, fontWeight=androidx.compose.ui.text.font.FontWeight.SemiBold)
    Spacer(Modifier.height(16.dp))
    if (browser.devicesLoading) {
        Box(Modifier.fillMaxWidth().height(64.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        }
    } else {
        browser.devicesError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            TextButton(onClick = browser::openSendDevices) { Text("重试") } }
        if (browser.devices.isEmpty() && browser.devicesError == null) {
            Text("与其他设备配对后，即可发送网页", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { browser.settings("pairing") }) { Text("配对设备") }
        }
        browser.devices.forEach { device ->
            Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(vertical = 8.dp).clip(RoundedCornerShape(14.dp))
                .clickable(enabled = browser.sendingDevice == null) { browser.sendToDevice(device) }, verticalAlignment = Alignment.CenterVertically) {
                LineIcon(if (device.platform.lowercase() in setOf("android", "ios", "iphone")) R.drawable.ic_smartphone else R.drawable.ic_desktop, null)
                Spacer(Modifier.width(16.dp))
                Column(Modifier.weight(1f)) {
                    Text(device.name, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                    if (device.online) Box(Modifier.padding(end = 6.dp).size(6.dp).background(if (browser.dark) Color(0xff5ee3a1) else Color(0xff1f9d63), CircleShape))
                    Text(if (device.online) "在线" else "离线 · 上线后送达", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (browser.sendingDevice == device.id) CircularProgressIndicator(Modifier.padding(end = 8.dp).size(18.dp), strokeWidth = 2.dp)
            }
        }
    }
}

@Composable private fun IncomingBanner(browser: BrowserController) {
    val item = browser.incomingBanner ?: return
    var drag by remember(item.id) { mutableFloatStateOf(0f) }
    var rect by remember { mutableStateOf<android.graphics.Rect?>(null) }
    var backdrop by remember(item.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    val density = LocalDensity.current.density
    LaunchedEffect(item.id, browser.dark, browser.activeId, rect) { rect?.let { backdrop = BannerBackdrop.capture(browser.view(), it, browser.dark) } }
    Box(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Box(Modifier.fillMaxWidth().heightIn(min = 64.dp).offset { IntOffset(0, drag.roundToInt()) }
            .onGloballyPositioned { if (drag == 0f) { val b = it.boundsInWindow(); rect = android.graphics.Rect(b.left.roundToInt(), b.top.roundToInt(), b.right.roundToInt(), b.bottom.roundToInt()) } }
            .clip(RoundedCornerShape(18.dp))
            .pointerInput(item.id) { detectVerticalDragGestures(
                onDragEnd = { if (drag < -20 * density) browser.dismissIncoming() else drag = 0f },
                onDragCancel = { drag = 0f },
                onVerticalDrag = { change, amount -> change.consume(); drag = (drag + amount).coerceAtMost(0f) }) }) {
            backdrop?.let { Image(it.asImageBitmap(), null, Modifier.matchParentSize(), contentScale = ContentScale.FillBounds,
                colorFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(1.5f) })) }
            Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).background(if (browser.dark) Color(0xb30a1020) else Color(0xbdf7fafe))
                .border(1.dp, if (browser.dark) Color(0x1aaac8ff) else Color(0x1a1e3c78), RoundedCornerShape(18.dp))
                .padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            LineIcon(R.drawable.ic_send, null)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("来自 ${browser.incomingFrom(item)}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(item.ti, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(onClick = { browser.openIncoming(item) }) { Text("打开") }
            }
        }
    }
}
@Composable private fun MenuRow(icon: Int, title: String, enabled: Boolean = true, action: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(8.dp)).clickable(enabled = enabled, onClick = action).alpha(if (enabled) 1f else .4f), verticalAlignment = Alignment.CenterVertically) {
        LineIcon(icon, null); Spacer(Modifier.width(18.dp)); Text(title, Modifier.weight(1f),fontSize = 15.sp)
    }
}
@Composable private fun BookmarkSheet(browser: BrowserController) {
    val tab = browser.active
    var title by remember(tab.id) { mutableStateOf(tab.title) }
    var group by remember(tab.id) { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    var titleFocused by remember { mutableStateOf(false) }
    LaunchedEffect(saved) { if (saved) { delay(900); browser.sheet = null } }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Favicon(tab, 32); Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            BasicTextField(title, { title = it.take(200) }, singleLine = true,
                textStyle = LocalTextStyle.current.copy(fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier.fillMaxWidth().height(48.dp).onFocusChanged { titleFocused = it.isFocused }
                    .semantics { contentDescription = "标题" }.clip(RoundedCornerShape(14.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .border(1.dp, if (titleFocused) MaterialTheme.colorScheme.primary else
                        if (browser.dark) Color(0x1aaac8ff) else Color(0x1a1e3c78), RoundedCornerShape(14.dp)),
                decorationBox = { inner -> Box(Modifier.fillMaxSize().padding(horizontal = 14.dp), contentAlignment = Alignment.CenterStart) {
                    if (title.isEmpty()) Text("标题", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    inner()
                } })
            Text(UrlRules.host(tab.url), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .4f), modifier = Modifier.padding(top = 8.dp))
        }
    }
    Spacer(Modifier.height(16.dp))
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        browser.groups.forEach { (id, name) -> FilterChip(selected = (group ?: browser.groups.firstOrNull()?.first) == id, onClick = { group = id }, label = { Text(name) }) }
    }
    Spacer(Modifier.height(16.dp))
    Button(onClick = { saving = true; browser.addBookmark(title, group ?: browser.groups.firstOrNull()?.first) { success -> saving = false; saved = success } },
        enabled = !saving && !saved && browser.groups.isNotEmpty(), modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(24.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.onSurface, contentColor = if (browser.dark) Color(0xff0a1020) else Color.White)) {
        if (saved) LineIcon(R.drawable.ic_check, "收藏成功")
        else if (saving) CircularProgressIndicator(Modifier.size(20.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
        else Text("收藏")
    }
    if (browser.bookmarked && browser.bookmarkId != null) TextButton(onClick = browser::removeBookmark, modifier = Modifier.fillMaxWidth()) { Text("移除收藏", color = if (browser.dark) Color(0xffff6b6b) else Color(0xffe5484d)) }
}
@Composable private fun ContextSheet(browser: BrowserController) {
    val target = browser.contextTarget ?: return
    val link = target.link ?: target.image ?: target.selection ?: return
    Text(link, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .6f))
    Spacer(Modifier.height(12.dp))
    if(target.selection==null) MenuRow(R.drawable.ic_plus, "在新标签页打开") { browser.navigate(link, true) }
    MenuRow(R.drawable.ic_copy, "复制链接") { browser.copy(link) }
    MenuRow(R.drawable.ic_share, "分享链接") { browser.share(link) }
    target.image?.let { image -> MenuRow(R.drawable.ic_download, "保存图片") { browser.download(image, browser.view().settings.userAgentString) } }
    if(!browser.active.home) {
        val extTarget=re.inc.kongjing.browser.ext.api.ExtensionContextTarget(browser.extensions.handle(browser.active),browser.active.url,target.link,target.image,target.selection)
        val items=browser.extensions.host.contextMenuItems(extTarget)
        if(items.isNotEmpty()) {
            HorizontalDivider(Modifier.padding(vertical=12.dp));Text("扩展",fontSize=12.sp,color=MaterialTheme.colorScheme.onSurfaceVariant)
            items.forEach { item -> MenuRow(R.drawable.ic_puzzle,item.title,enabled=item.enabled){browser.sheet=null;browser.extensions.host.clickContextMenu(item,extTarget)} }
        }
    }
}
