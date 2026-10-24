package re.inc.kongjing.browser

import android.Manifest
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import re.inc.kongjing.browser.core.UrlRules

@Composable fun BrowserMessageBar(browser: BrowserController) {
    val message=browser.extras.message ?: return
    Box(Modifier.fillMaxSize().navigationBarsPadding().padding(bottom=66.dp,start=12.dp,end=12.dp),contentAlignment=Alignment.BottomCenter) {
        Snackbar(action={message.label?.let { TextButton(onClick={browser.extras.message=null;message.action?.invoke()}){Text(it)} }}){Text(message.text,maxLines=3,overflow=TextOverflow.Ellipsis)}
    }
}
@Composable fun PageError(browser: BrowserController, reason: String) {
    Surface(Modifier.fillMaxSize(),color=MaterialTheme.colorScheme.background) {
      BoxWithConstraints(Modifier.fillMaxSize()) {
        val compact=maxHeight<400.dp
        Box(Modifier.fillMaxSize().padding(horizontal=if(compact)24.dp else 32.dp,vertical=if(compact)16.dp else 32.dp),contentAlignment=Alignment.Center) {
            Column(Modifier.verticalScroll(rememberScrollState()),horizontalAlignment=Alignment.CenterHorizontally) {
                // Native illustration, independent of network/JS and readable with large text.
                Text("☁",fontSize=if(compact)40.sp else 72.sp,color=MaterialTheme.colorScheme.primary)
                Text("暂时无法抵达",style=MaterialTheme.typography.titleLarge)
                Text(reason,Modifier.padding(vertical=if(compact)8.dp else 16.dp),style=MaterialTheme.typography.bodyMedium)
                Text(UrlRules.host(browser.active.url),maxLines=2,overflow=TextOverflow.Ellipsis,color=MaterialTheme.colorScheme.onSurfaceVariant)
                Button(onClick=browser::retryPage,modifier=Modifier.padding(top=if(compact)12.dp else 20.dp)){Text("重试")}
            }
        }
      }
    }
}
@Composable private fun FeatureRow(title: String, subtitle: String?=null, action: ()->Unit) {
    Column(Modifier.fillMaxWidth().heightIn(min=52.dp).clickable(onClick=action).padding(vertical=14.dp)) {
        Text(title,maxLines=2,overflow=TextOverflow.Ellipsis)
        subtitle?.let { Text(it,fontSize=12.sp,maxLines=2,overflow=TextOverflow.Ellipsis,color=MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
@Composable fun FeatureSheet(browser: BrowserController, sheet: String) {
    val extras=browser.extras
    when(sheet) {
        "textSize" -> {
            Text("网页文字大小",style=MaterialTheme.typography.titleLarge)
            var value by remember { mutableFloatStateOf(org.json.JSONObject(extras.prefsJson()).optInt("textZoom",100).toFloat()) }
            Text("${value.toInt()}%",Modifier.padding(top=12.dp),fontSize=15.sp)
            Slider(value,{value=it},valueRange=80f..150f,steps=13,onValueChangeFinished={extras.setZoom(value.toInt())},modifier=Modifier.semantics { contentDescription="网页文字大小 80–150%" })
        }
        "tabOptions" -> {
            Text("标签页选项",style=MaterialTheme.typography.titleLarge)
            FeatureRow("关闭全部标签页"){extras.confirmCloseAll=true}
            FeatureRow("最近关闭"){browser.sheet="recent"}
        }
        "recent" -> {
            Text("最近关闭",style=MaterialTheme.typography.titleLarge)
            if(extras.recent.isEmpty()) Text("没有最近关闭的网页",Modifier.padding(vertical=24.dp))
            extras.recent.forEachIndexed { index, page -> FeatureRow(page.title,page.url){extras.restore(index)} }
        }
        "backHistory" -> {
            Text("本标签页的历史",style=MaterialTheme.typography.titleLarge)
            if(extras.backEntries.isEmpty()) Text("没有更早的网页",Modifier.padding(vertical=24.dp))
            extras.backEntries.forEach { row->FeatureRow(row.title,row.url){extras.jumpBack(row.offset)} }
        }
        "downloads" -> {
            LaunchedEffect(Unit) { while(true) { extras.refreshDownloads(); kotlinx.coroutines.delay(1000) } }
            Text("下载",style=MaterialTheme.typography.titleLarge)
            if(extras.downloads.isEmpty()) Text("还没有下载记录",Modifier.padding(vertical=24.dp))
            extras.downloads.forEach { row ->
                var drag by remember(row.id){mutableFloatStateOf(0f)}
                Row(Modifier.fillMaxWidth().pointerInput(row.id){detectHorizontalDragGestures(onDragEnd={if(drag < -80)extras.deleteDownload=row;drag=0f},onDragCancel={drag=0f}){c,d->c.consume();drag+=d}},verticalAlignment=Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)){FeatureRow(row.name,extras.downloadDescription(row)){extras.openDownload(row.id)}}
                    TextButton(onClick={extras.deleteDownload=row}){Text("删除")}
                }
            }
        }
        "siteInfo" -> {
            Text("网页信息",style=MaterialTheme.typography.titleLarge)
            val tab=browser.active
            val secure=tab.secure
            val certificate=if (secure) browser.view().certificate else null
            Text(if(secure)"连接安全" else "连接不安全",Modifier.padding(top=16.dp),color=if(secure)MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
            Text(UrlRules.host(tab.url),Modifier.padding(vertical=8.dp))
            if(certificate!=null){
                Text("颁发给：${certificate.issuedTo.dName}",fontSize=13.sp)
                Text("颁发者：${certificate.issuedBy.dName}",fontSize=13.sp)
                Text("有效期：${certificate.validNotBeforeDate} — ${certificate.validNotAfterDate}",fontSize=13.sp,modifier=Modifier.padding(vertical=8.dp))
            }else Text("此连接没有可验证的 TLS 证书",fontSize=13.sp)
            HorizontalDivider(Modifier.padding(vertical=16.dp))
            Text("网站权限",style=MaterialTheme.typography.titleMedium)
            val grants=extras.grants(tab.url)
            val choices=listOf(Manifest.permission.ACCESS_COARSE_LOCATION to "定位",Manifest.permission.CAMERA to "摄像头",Manifest.permission.RECORD_AUDIO to "麦克风")
            choices.forEach{(permission,label)->Row(Modifier.fillMaxWidth().heightIn(min=52.dp),verticalAlignment=Alignment.CenterVertically){
                Text(label,Modifier.weight(1f));if(permission in grants)TextButton(onClick={extras.revoke(permission)}){Text("撤销")}else Text("未授权",fontSize=13.sp,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }}
        }
    }
}
@Composable fun FeatureDialogs(browser: BrowserController) {
    val extras=browser.extras
    if(extras.confirmCloseAll)BrowserDialog(onDismissRequest={extras.confirmCloseAll=false},title={Text("关闭全部标签页？")},text={Text("网页可在「最近关闭」中恢复，最多保留 10 个。")},confirmButton={TextButton(onClick=extras::closeAll){Text("关闭全部")}},dismissButton={TextButton(onClick={extras.confirmCloseAll=false}){Text("取消")}})
    extras.deleteDownload?.let{row->
        var file by remember(row.id){mutableStateOf(false)}
        BrowserDialog(onDismissRequest={extras.deleteDownload=null},title={Text("删除下载记录？")},text={Column{Text(row.name,maxLines=3,overflow=TextOverflow.Ellipsis);Row(Modifier.fillMaxWidth().clickable{file=!file},verticalAlignment=Alignment.CenterVertically){Checkbox(file,{file=it});Text("同时删除文件",Modifier.weight(1f))}}},confirmButton={TextButton(onClick={extras.removeDownload(row,file)}){Text("删除")}},dismissButton={TextButton(onClick={extras.deleteDownload=null}){Text("取消")}})
    }
}
