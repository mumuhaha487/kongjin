@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
package re.inc.kongjing.browser

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.focus.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.*
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.*
import androidx.compose.ui.text.style.*
import androidx.compose.ui.unit.*
import re.inc.kongjing.browser.core.*
import kotlin.math.*

val PanelEase = CubicBezierEasing(.2f,.8f,.2f,1f)

@Composable internal fun Toolbar(browser: BrowserController, editing: Boolean, edit: (Boolean)->Unit) {
    val colors=MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().background(colors.surface).navigationBarsPadding(),horizontalAlignment=Alignment.CenterHorizontally) {
        HorizontalDivider(color=colors.outlineVariant,thickness=.5.dp)
        Row(Modifier.widthIn(max=600.dp).fillMaxWidth().height(56.dp).padding(horizontal=4.dp),verticalAlignment=Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).combinedClickable(onClick=browser::back,onLongClick=browser.extras::backHistory).semantics{contentDescription="后退"},contentAlignment=Alignment.Center){LineIcon(R.drawable.ic_back,null)}
            ToolButton(R.drawable.ic_home,"主页",action=browser::goHome)
            Box(Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(20.dp)).background(colors.surfaceVariant).clickable{edit(true)}.semantics{contentDescription="地址栏"}) {
                Row(Modifier.fillMaxSize().padding(start=8.dp,end=2.dp),verticalAlignment=Alignment.CenterVertically) {
                    if(browser.active.home) {
                        Icon(painterResource(R.drawable.ic_search),null,Modifier.size(18.dp),colors.onSurfaceVariant)
                        Spacer(Modifier.width(6.dp))
                        Text("搜索或输入网址",Modifier.weight(1f),fontSize=15.sp,maxLines=1,overflow=TextOverflow.Ellipsis,color=colors.onSurfaceVariant)
                    } else {
                        Row(Modifier.weight(1f),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.Center) {
                            val extensionName=browser.extensions.extensionName(browser.active.url)
                            IconButton(onClick={if(extensionName!=null)browser.extensions.showManagement()else browser.sheet="siteInfo"},modifier=Modifier.size(28.dp)){Icon(painterResource(if(extensionName!=null)R.drawable.ic_puzzle else if(browser.active.secure)R.drawable.ic_lock else R.drawable.ic_site_info),if(extensionName!=null)"扩展程序"else"网页信息",Modifier.size(16.dp))}
                            Text(extensionName?:MobileUiPolicy.domain(browser.active.url),fontSize=15.sp,maxLines=1,overflow=TextOverflow.Ellipsis,modifier=Modifier.weight(1f,false))
                        }
                        NativeExtensionCapsule(browser)
                        IconButton(onClick=browser::refresh,modifier=Modifier.size(32.dp)){Icon(painterResource(if(browser.active.progress<1f)R.drawable.ic_close else R.drawable.ic_refresh),if(browser.active.progress<1f)"停止加载" else "刷新",Modifier.size(18.dp))}
                    }
                }
                val alpha by animateFloatAsState(if(browser.active.progress<1f)1f else 0f,tween(200),label="加载进度淡出")
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(browser.active.progress.coerceIn(0f,1f)).height(2.dp).alpha(alpha).background(colors.primary))
            }
            IconButton(onClick=browser::openTabSwitcher,modifier=Modifier.size(40.dp)){
                Box(Modifier.height(22.dp).widthIn(min=22.dp).border(1.75.dp,colors.onSurface,RoundedCornerShape(4.dp)).padding(horizontal=3.dp).semantics{contentDescription="${browser.tabs.size} 个标签页"},contentAlignment=Alignment.Center){Text(SiteVisuals.tabCount(browser.tabs.size),fontSize=11.sp,lineHeight=14.sp,maxLines=1)}
            }
            ToolButton(R.drawable.ic_menu,"菜单",action=browser::openMenu)
        }
    }
}

private data class AddressRow(val title:String,val subtitle:String,val value:String,val icon:Int,val navigate:String?=null)

@Composable internal fun AddressEditor(browser:BrowserController,onClose:()->Unit) {
    val colors=MaterialTheme.colorScheme
    var input by remember{mutableStateOf(TextFieldValue(""))}
    var suggestions by remember{mutableStateOf<List<Suggestion>>(emptyList())}
    var recent by remember{mutableStateOf(browser.store.recentSearches())}
    var sites by remember{mutableStateOf<List<Suggestion>>(emptyList())}
    val requester=remember{FocusRequester()};val keyboard=LocalSoftwareKeyboardController.current
    fun fill(value:String){input=TextFieldValue(value,TextRange(value.length))}
    fun navigate(url:String,search:String?=null){search?.let(browser.store::rememberSearch);browser.navigate(url);onClose()}
    LaunchedEffect(Unit){browser.toolbarHidden=false;browser.extras.readClipboard();browser.store.historySuggestions(""){rows->browser.activity.runOnUiThread{sites=rows.distinctBy{MobileUiPolicy.domain(it.url)}.take(5)}};requester.requestFocus();keyboard?.show()}
    DisposableEffect(input.text){val cancel=browser.addressSuggestions.query(input.text){suggestions=it};onDispose{cancel()}}
    DisposableEffect(Unit){onDispose{keyboard?.hide()}}
    Surface(Modifier.fillMaxSize(),color=colors.surface){
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding(),horizontalAlignment=Alignment.CenterHorizontally){
            Column(Modifier.weight(1f).widthIn(max=600.dp).fillMaxWidth().verticalScroll(rememberScrollState(),reverseScrolling=true),verticalArrangement=Arrangement.Bottom){
                if(input.text.isEmpty()){
                    recent.asReversed().forEach{query->
                        AddressSuggestion(AddressRow(query,"最近搜索",query,R.drawable.ic_history),"",{navigate(UrlRules.searchUrl(query,browser.searchTemplate),query)},{fill(query)},trailing={IconButton(onClick={browser.store.removeSearch(query);recent=browser.store.recentSearches()},modifier=Modifier.size(40.dp)){LineIcon(R.drawable.ic_close,"删除搜索 $query")}})
                    }
                    if(sites.isNotEmpty()){
                        Text("最近访问",Modifier.padding(start=20.dp,top=12.dp,bottom=8.dp),fontSize=12.sp,color=colors.onSurfaceVariant)
                        Row(Modifier.fillMaxWidth().padding(start=16.dp,end=16.dp,bottom=12.dp)){
                            sites.forEach{site->Column(Modifier.weight(1f).clickable{navigate(site.url)},horizontalAlignment=Alignment.CenterHorizontally){
                                Box(Modifier.size(40.dp).clip(CircleShape).background(colors.surfaceVariant),contentAlignment=Alignment.Center){Text(MobileUiPolicy.domain(site.url).take(1).uppercase(),fontSize=20.sp,color=colors.primary)}
                                Text(site.title,Modifier.padding(top=5.dp),fontSize=11.sp,maxLines=1,overflow=TextOverflow.Ellipsis)
                            }}
                            repeat(5-sites.size){Spacer(Modifier.weight(1f))}
                        }
                    }
                    browser.extras.clipboard?.let{url->AddressSuggestion(AddressRow("复制的链接",MobileUiPolicy.subtitle(url),url,R.drawable.ic_clipboard),"",{navigate(url)},{fill(url)})}
                }else{
                    val opened=browser.tabs.filter{!it.home&&(it.url.contains(input.text,true)||it.title.contains(input.text,true))}.take(2)
                    val rows=suggestions.filterNot{item->opened.any{it.url==item.url}}.map{AddressRow(it.title,MobileUiPolicy.subtitle(it.url)+(it.deviceName?.let{n->" · $n"}?:""),it.url,if(it.bookmark)R.drawable.ic_star else R.drawable.ic_history,it.url)}+
                        opened.map{AddressRow(it.title,"已打开 · "+MobileUiPolicy.subtitle(it.url),it.url,R.drawable.ic_layers,it.url)}
                    rows.take(6).asReversed().forEach{row->AddressSuggestion(row,input.text,{val tab=opened.firstOrNull{it.url==row.navigate};if(tab!=null){browser.select(tab.id);onClose()}else navigate(row.navigate!!)},{fill(row.value)})}
                    UrlRules.addressActions(input.text,browser.searchTemplate).asReversed().forEachIndexed{_,a->
                        val isSearch=a.label.startsWith("搜索：")
                        AddressSuggestion(AddressRow(a.label,if(isSearch)"使用当前搜索引擎" else MobileUiPolicy.subtitle(a.url),if(isSearch)input.text else a.url,if(isSearch)R.drawable.ic_search else R.drawable.ic_external),input.text,{navigate(a.url,if(isSearch)input.text else null)},{fill(if(isSearch)input.text else a.url)})
                    }
                }
                if(!browser.active.home)AddressSuggestion(AddressRow("编辑当前网址",browser.active.url,browser.active.url,R.drawable.ic_pencil),"",{fill(browser.active.url)},{fill(browser.active.url)},trailing={IconButton(onClick={browser.copy(browser.active.url)},modifier=Modifier.size(40.dp)){LineIcon(R.drawable.ic_copy,"复制当前网址")}})
            }
            Row(Modifier.widthIn(max=600.dp).fillMaxWidth().padding(start=12.dp,end=4.dp,top=8.dp,bottom=8.dp),verticalAlignment=Alignment.CenterVertically){
                Row(Modifier.weight(1f).height(48.dp).clip(RoundedCornerShape(24.dp)).background(colors.surfaceVariant).padding(start=12.dp),verticalAlignment=Alignment.CenterVertically){
                    AddressEngineIcon(browser.searchTemplate,input.text);Spacer(Modifier.width(8.dp))
                    BasicTextField(input,{input=it},Modifier.weight(1f).focusRequester(requester).semantics{contentDescription="搜索或输入网址"},singleLine=true,textStyle=LocalTextStyle.current.copy(fontSize=15.sp,color=colors.onSurface),cursorBrush=SolidColor(colors.primary),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Uri,imeAction=ImeAction.Go),keyboardActions=KeyboardActions(onGo={browser.submit(input.text);onClose()}),decorationBox={inner->Box{if(input.text.isEmpty())Text("搜索或输入网址",fontSize=15.sp,color=colors.onSurfaceVariant,maxLines=1);inner()}})
                    if(input.text.isNotEmpty())IconButton(onClick={fill("")},modifier=Modifier.size(36.dp)){LineIcon(R.drawable.ic_close,"清空")}
                    IconButton(onClick={onClose();browser.extras.scan()},modifier=Modifier.size(40.dp)){Icon(painterResource(R.drawable.ic_scan),"扫一扫",Modifier.size(20.dp))}
                }
                TextButton(onClick=onClose,contentPadding=PaddingValues(horizontal=10.dp)){Text("取消",fontSize=15.sp,maxLines=1)}
            }
        }
    }
}

@Composable private fun AddressEngineIcon(template:String,input:String){
    val c=MaterialTheme.colorScheme
    if(UrlRules.addressUrl(input)!=null){Icon(painterResource(R.drawable.ic_globe),"网址",Modifier.size(18.dp),c.primary);return}
    val engine=remember(template){MobileUiPolicy.searchIcon(template)}
    val icon=when(engine.key){"bing"->R.drawable.ic_engine_bing;"google"->R.drawable.ic_engine_google;"baidu"->R.drawable.ic_engine_baidu;"duckduckgo"->R.drawable.ic_engine_duckduckgo;else->null}
    if(icon!=null)Icon(painterResource(icon),"搜索引擎：${engine.name}",Modifier.size(18.dp),c.primary)
    else Box(Modifier.size(18.dp).semantics{contentDescription="搜索引擎：${engine.name}"},contentAlignment=Alignment.Center){Text(engine.letter,fontSize=16.sp,color=c.primary,maxLines=1)}
}

@Composable private fun AddressSuggestion(row:AddressRow,query:String,open:()->Unit,fill:()->Unit,trailing:(@Composable ()->Unit)?=null){
    val c=MaterialTheme.colorScheme
    val annotated=remember(row.title,query){buildAnnotatedString{val i=if(query.isBlank())-1 else row.title.indexOf(query,ignoreCase=true);if(i<0)append(row.title)else{append(row.title.substring(0,i));withStyle(SpanStyle(fontWeight=FontWeight.SemiBold)){append(row.title.substring(i,i+query.length))};append(row.title.substring(i+query.length))}}}
    Row(Modifier.fillMaxWidth().height(56.dp).clickable(onClick=open).padding(start=20.dp,end=12.dp),verticalAlignment=Alignment.CenterVertically){
        Box(Modifier.size(36.dp).background(c.surfaceVariant,CircleShape),contentAlignment=Alignment.Center){Icon(painterResource(row.icon),null,Modifier.size(20.dp),c.onSurfaceVariant)};Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)){Text(annotated,fontSize=15.sp,maxLines=1,overflow=TextOverflow.Ellipsis);Text(row.subtitle,fontSize=12.sp,maxLines=1,overflow=TextOverflow.Ellipsis,color=c.onSurfaceVariant)}
        if(trailing!=null)trailing()else IconButton(onClick=fill,modifier=Modifier.size(40.dp)){Icon(painterResource(R.drawable.ic_arrow_up_left),"填入 ${row.value}",Modifier.size(20.dp))}
    }
}

@Composable internal fun TabSwitcher(browser:BrowserController,shared:@Composable (BrowserTab)->Modifier){
    val c=MaterialTheme.colorScheme;val config=LocalConfiguration.current
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding(),horizontalAlignment=Alignment.CenterHorizontally){
        Row(Modifier.widthIn(max=600.dp).fillMaxWidth().height(56.dp).padding(horizontal=16.dp),verticalAlignment=Alignment.CenterVertically){Text("标签页 · ${browser.tabs.size}",fontSize=20.sp,fontWeight=FontWeight.SemiBold)}
        LazyVerticalGrid(columns=GridCells.Fixed(MobileUiPolicy.tabColumns(config.screenWidthDp,config.screenHeightDp)),modifier=Modifier.weight(1f).widthIn(max=600.dp).fillMaxWidth(),contentPadding=PaddingValues(16.dp,8.dp,16.dp,16.dp),horizontalArrangement=Arrangement.spacedBy(12.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
            items(browser.tabs,key={it.id}){tab->
                var drag by remember(tab.id){mutableFloatStateOf(0f)};val density=LocalDensity.current.density;val offset by animateFloatAsState(drag,tween(if(drag==0f)180 else 0),label="滑动关闭")
                Box(Modifier.fillMaxWidth().aspectRatio(3f/4f).offset{IntOffset(offset.roundToInt(),0)}.alpha((1f-abs(offset)/(216*density)).coerceIn(.2f,1f)).clip(RoundedCornerShape(16.dp)).background(c.surfaceVariant).then(if(tab.id==browser.activeId)Modifier.border(2.dp,c.primary,RoundedCornerShape(16.dp))else Modifier).pointerInput(tab.id){detectHorizontalDragGestures(onDragEnd={if(abs(drag)>72*density)browser.closeTab(tab.id)else drag=0f},onDragCancel={drag=0f}){change,delta->change.consume();drag+=delta}}.clickable{browser.select(tab.id)}){
                    val preview=tab.preview
                    if(preview!=null)Image(preview.asImageBitmap(),"${tab.title} 页面缩略图",Modifier.fillMaxSize(),contentScale=ContentScale.Crop,alignment=Alignment.TopCenter)
                    else Column(Modifier.align(Alignment.Center).padding(16.dp),horizontalAlignment=Alignment.CenterHorizontally){Favicon(tab,40);Spacer(Modifier.height(8.dp));Text(if(tab.home)"空境" else MobileUiPolicy.domain(tab.url),fontSize=12.sp,maxLines=1,overflow=TextOverflow.Ellipsis,color=c.onSurfaceVariant)}
                    Row(Modifier.fillMaxWidth().height(36.dp).background(c.surface.copy(alpha=.9f)).padding(start=10.dp),verticalAlignment=Alignment.CenterVertically){Favicon(tab,16);Spacer(Modifier.width(6.dp));Text(tab.title,Modifier.weight(1f),fontSize=13.sp,maxLines=1,overflow=TextOverflow.Ellipsis);IconButton(onClick={browser.closeTab(tab.id)},modifier=Modifier.size(32.dp)){Icon(painterResource(R.drawable.ic_close),"关闭 ${tab.title}",Modifier.size(16.dp))}}
                }
            }
        }
        Row(Modifier.widthIn(max=600.dp).fillMaxWidth().height(56.dp).background(c.surface).padding(horizontal=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween){
            ToolButton(R.drawable.ic_ellipsis,"更多标签页操作"){browser.sheet="tabOptions"}
            Button(onClick=browser::newTab,modifier=Modifier.height(40.dp),shape=RoundedCornerShape(20.dp),contentPadding=PaddingValues(horizontal=16.dp)){Icon(painterResource(R.drawable.ic_plus),null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp));Text("新标签页",fontSize=15.sp,maxLines=1)}
            TextButton(onClick={browser.showTabs=false}){Text("完成",fontSize=15.sp,maxLines=1)}
        }
    }
}

private data class GridAction(val icon:Int,val label:String,val description:String=label,val enabled:Boolean=true,val active:Boolean=false,val accentIcon:Boolean=false,val action:()->Unit)
@Composable internal fun MenuSheet(browser:BrowserController){
    val c=MaterialTheme.colorScheme;val tab=browser.active
    if(!tab.home){
        Row(Modifier.fillMaxWidth().height(64.dp),verticalAlignment=Alignment.CenterVertically){Favicon(tab,32);Spacer(Modifier.width(12.dp));Column(Modifier.weight(1f)){Text(tab.title,fontSize=15.sp,maxLines=1,overflow=TextOverflow.Ellipsis);Text(MobileUiPolicy.domain(tab.url),fontSize=12.sp,color=c.onSurfaceVariant,maxLines=1,overflow=TextOverflow.Ellipsis)};ToolButton(R.drawable.ic_site_info,"网页信息"){browser.sheet="siteInfo"}}
        HorizontalDivider(color=c.outlineVariant)
    }
    val actions=buildList{
        add(GridAction(R.drawable.ic_forward,"前进",enabled=tab.canForward&&!tab.home){browser.forward();browser.sheet=null})
        if(!tab.home){
            add(GridAction(if(browser.bookmarked)R.drawable.ic_star_filled else R.drawable.ic_star,"收藏",accentIcon=browser.bookmarked,action=browser::openBookmark))
            add(GridAction(R.drawable.ic_share,"分享"){browser.share()})
            add(GridAction(R.drawable.ic_send,"发送到设备",enabled=!tab.incognito,action=browser::openSendDevices))
            add(GridAction(R.drawable.ic_book_open,"稍后阅读",action=browser.extras::readLater))
        }
        add(GridAction(R.drawable.ic_plus,"新标签页"){browser.sheet=null;browser.newTab()})
        add(GridAction(R.drawable.ic_history,"历史记录"){browser.openRelay("history")})
        add(GridAction(R.drawable.ic_download,"下载",action=browser.extras::openDownloads))
        add(GridAction(R.drawable.ic_puzzle,"扩展程序"){browser.sheet=null;browser.extensions.showManagement()})
        add(GridAction(R.drawable.ic_scan,"扫一扫",action=browser.extras::scan))
        if(!tab.home){
            add(GridAction(R.drawable.ic_search,"页面查找"){browser.sheet=null;browser.find=true;browser.toolbarHidden=false})
            add(GridAction(R.drawable.ic_desktop,"桌面版网站",active=tab.desktop){browser.toggleDesktop();browser.sheet=null})
            add(GridAction(R.drawable.ic_square_plus,"添加到桌面",action=browser.extras::pinShortcut))
            add(GridAction(R.drawable.ic_external,"其他应用","在其他应用中打开"){browser.sheet=null;browser.externalUrl=tab.url})
            add(GridAction(R.drawable.ic_text_size,"文字大小","网页文字大小"){browser.sheet="textSize"})
        }
    }
    Column(Modifier.padding(vertical=8.dp)){
        actions.chunked(5).forEach{row->Row(Modifier.fillMaxWidth()){row.forEach{a->GridMenuItem(a,Modifier.weight(1f))};repeat(5-row.size){Spacer(Modifier.weight(1f))}}}
    }
    HorizontalDivider(color=c.outlineVariant)
    Row(Modifier.fillMaxWidth().height(56.dp),verticalAlignment=Alignment.CenterVertically){
        Row(Modifier.widthIn(max=240.dp).clip(RoundedCornerShape(18.dp)).background(c.surfaceVariant).clickable{browser.settings("pairing")}.padding(horizontal=12.dp,vertical=8.dp),verticalAlignment=Alignment.CenterVertically){Box(Modifier.size(6.dp).background(if(browser.devices.isNotEmpty())Color(0xff1f9d63)else c.onSurfaceVariant,CircleShape));Spacer(Modifier.width(7.dp));Text(if(browser.devices.isEmpty())"未配对"else"已同步 · ${browser.devices.size+1} 台设备",fontSize=12.sp,maxLines=1,overflow=TextOverflow.Ellipsis)}
        Spacer(Modifier.weight(1f));ToolButton(R.drawable.ic_settings,"设置"){browser.settings()}
    }
}
@Composable private fun GridMenuItem(a:GridAction,modifier:Modifier){
    val c=MaterialTheme.colorScheme;val interaction=remember{MutableInteractionSource()};val pressed by interaction.collectIsPressedAsState();val scale by animateFloatAsState(if(pressed).94f else 1f,tween(100),label="宫格按下")
    val measure=rememberTextMeasurer()
    val density=LocalDensity.current
    val scaledDensity=density.density*density.fontScale
    BoxWithConstraints(modifier.height(72.dp)){
      val available=constraints.maxWidth-with(density){4.dp.toPx()}
      val labelWidth=maxWidth-4.dp
      val normal=measure.measure(a.label,style=LocalTextStyle.current.copy(fontSize=11.sp),softWrap=false).size.width.toFloat()
      val labelSp=MobileUiPolicy.menuLabelSp(normal,available)
      val compact=if(labelSp==10)measure.measure(a.label,style=LocalTextStyle.current.copy(fontSize=10.sp),softWrap=false).size.width else 0
      val tracking=if(compact>available&&a.label.length>1)((available-compact-1f)/(a.label.length-1)/scaledDensity).sp else 0.sp
      Column(Modifier.fillMaxSize().scale(scale).alpha(if(a.enabled)1f else .4f).semantics(mergeDescendants=true){contentDescription=a.description}.clickable(interactionSource=interaction,indication=null,enabled=a.enabled,onClick=a.action),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.Center){
        Box(Modifier.size(44.dp).background(if(a.active)c.primary else c.surfaceVariant,CircleShape),contentAlignment=Alignment.Center){Icon(painterResource(a.icon),null,Modifier.size(22.dp),if(a.active)Color.White else if(a.accentIcon)c.primary else c.onSurface)}
        Spacer(Modifier.height(4.dp));Text(a.label,Modifier.widthIn(max=labelWidth),fontSize=labelSp.sp,letterSpacing=tracking,lineHeight=14.sp,color=c.onSurfaceVariant,maxLines=1,softWrap=false,overflow=TextOverflow.Visible,onTextLayout={if(it.hasVisualOverflow)android.util.Log.w("KongjingUi","Menu label overflow: ${a.label}")})
      }
    }
}
