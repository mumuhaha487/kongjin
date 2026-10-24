package re.inc.kongjing.browser.core

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer

object QrDecoder {
    /** Compact Y plane; camera padding is stripped by the caller. QR format only. */
    fun decode(bytes: ByteArray, width: Int, height: Int): String? {
        if (width <= 0 || height <= 0 || width.toLong()*height != bytes.size.toLong()) return null
        val reader=MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(com.google.zxing.BarcodeFormat.QR_CODE),DecodeHintType.TRY_HARDER to true)) }
        return runCatching { reader.decodeWithState(BinaryBitmap(HybridBinarizer(PlanarYUVLuminanceSource(bytes,width,height,0,0,width,height,false)))).text }.getOrNull()
    }
}
