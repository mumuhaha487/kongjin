package re.inc.kongjing.browser

import android.Manifest
import android.content.pm.PackageManager
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun QrScanner(browser: BrowserController) {
    val activity = browser.activity
    val extras = browser.extras
    var error by remember { mutableStateOf<String?>(null) }
    val preview = remember { PreviewView(activity).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE } }
    DisposableEffect(Unit) {
        val executor = Executors.newSingleThreadExecutor()
        val camera = ProcessCameraProvider.getInstance(activity)
        val last = AtomicLong(0)
        var disposed = false
        var provider: ProcessCameraProvider? = null
        var boundPreview: Preview? = null
        var boundAnalysis: ImageAnalysis? = null
        camera.addListener({
            if (!disposed) runCatching {
                check(ContextCompat.checkSelfPermission(activity,Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)
                val p = camera.get(); provider=p
                val surface = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }; boundPreview=surface
                val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build(); boundAnalysis=analysis
                analysis.setAnalyzer(executor) { image ->
                    try {
                        if (System.currentTimeMillis()-last.get()<1500) return@setAnalyzer
                        val plane=image.planes[0]; val buffer=plane.buffer.duplicate(); val data=ByteArray(image.width*image.height)
                        // CameraX Y plane row padding and pixel stride must not enter ZXing's image.
                        for(y in 0 until image.height) for(x in 0 until image.width) data[y*image.width+x]=buffer.get(y*plane.rowStride+x*plane.pixelStride)
                        re.inc.kongjing.browser.core.QrDecoder.decode(data,image.width,image.height)?.let { text -> last.set(System.currentTimeMillis()); activity.runOnUiThread { if (!disposed) extras.scanned(text) } }
                    } finally { image.close() }
                }
                val selector=if (p.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
                p.bindToLifecycle(activity,selector,surface,analysis)
            }.onFailure { error="无法打开相机，请检查相机是否可用" }
        },ContextCompat.getMainExecutor(activity))
        onDispose { disposed=true; boundAnalysis?.clearAnalyzer(); provider?.let { p -> boundAnalysis?.let { p.unbind(it) }; boundPreview?.let { p.unbind(it) } }; executor.shutdown() }
    }
    Dialog(onDismissRequest={extras.scanner=false},properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize(),color=MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().systemBarsPadding().padding(20.dp)) {
                Text("扫一扫",style=MaterialTheme.typography.titleLarge)
                Text("扫描网址或空境配对二维码",Modifier.padding(vertical=12.dp))
                AndroidView(factory={preview},modifier=Modifier.weight(1f).fillMaxWidth())
                error?.let { Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.padding(vertical=12.dp)) }
                TextButton(onClick={extras.scanner=false},modifier=Modifier.fillMaxWidth().heightIn(min=48.dp)){Text("关闭扫一扫")}
            }
        }
    }
}
