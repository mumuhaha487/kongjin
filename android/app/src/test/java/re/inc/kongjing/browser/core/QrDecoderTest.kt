package re.inc.kongjing.browser.core

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.*
import org.junit.Test

class QrDecoderTest {
    @Test fun cameraLuminanceDecodesWebAndPairingQrWithoutPlayServices() {
        listOf("https://example.com/path", "kongjing://pair?code=KJ-ABCDE-12345").forEach { text ->
            val image=QRCodeWriter().encode(text,BarcodeFormat.QR_CODE,256,256)
            val bytes=ByteArray(256*256){ i->if(image[i%256,i/256])0 else 255.toByte() }
            assertEquals(text,QrDecoder.decode(bytes,256,256))
            assertNotNull(BrowserFeatures.scan(QrDecoder.decode(bytes,256,256)!!))
        }
    }
    @Test fun malformedOrEmptyFramesNeverOpenSomething() {
        assertNull(QrDecoder.decode(byteArrayOf(),0,0))
        assertNull(QrDecoder.decode(ByteArray(12),100,100))
        assertNull(QrDecoder.decode(ByteArray(256*256){-1},256,256))
    }
}
