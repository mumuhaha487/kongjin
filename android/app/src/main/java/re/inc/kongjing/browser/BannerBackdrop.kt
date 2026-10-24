package re.inc.kongjing.browser

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.webkit.WebView
import kotlin.math.ceil
import kotlin.math.roundToInt

/** Small transient snapshot blur for API 26+, where RenderEffect/backdrop blur is unavailable.
 * Only the WebView below the 64dp banner is sampled, once per message/layout/theme. */
object BannerBackdrop {
    fun capture(view: WebView, rect: Rect, dark: Boolean): Bitmap? = runCatching {
        require(rect.width() > 0 && rect.height() > 0 && view.width > 0)
        val scale = 4f
        val radius = (28 * view.resources.displayMetrics.density / scale).roundToInt().coerceAtLeast(1)
        val pad = radius * 3
        val width = ceil(rect.width() / scale).toInt()
        val height = ceil(rect.height() / scale).toInt()
        val bitmap = Bitmap.createBitmap(width + pad * 2, height + pad * 2, Bitmap.Config.ARGB_8888)
        val xy = IntArray(2); view.getLocationInWindow(xy)
        val canvas = Canvas(bitmap)
        canvas.drawColor(if (dark) 0xff070b16.toInt() else 0xfff3f6fa.toInt())
        canvas.scale(1 / scale, 1 / scale)
        canvas.translate(xy[0] - rect.left + pad * scale, xy[1] - rect.top + pad * scale)
        view.draw(canvas)
        var pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        repeat(3) {
            pixels = pass(pixels, bitmap.width, bitmap.height, radius, true)
            pixels = pass(pixels, bitmap.width, bitmap.height, radius, false)
        }
        bitmap.setPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        Bitmap.createBitmap(bitmap, pad, pad, width, height).also { bitmap.recycle() }
    }.getOrNull()

    private fun pass(source: IntArray, width: Int, height: Int, radius: Int, horizontal: Boolean): IntArray {
        val result = IntArray(source.size)
        val count = if (horizontal) width else height
        val lines = if (horizontal) height else width
        val diameter = 2 * radius + 1
        for (line in 0 until lines) {
            fun index(position: Int) = if (horizontal) line * width + position.coerceIn(0, count - 1) else position.coerceIn(0, count - 1) * width + line
            var red = 0; var green = 0; var blue = 0
            fun add(pixel: Int, sign: Int) { red += ((pixel ushr 16) and 255) * sign; green += ((pixel ushr 8) and 255) * sign; blue += (pixel and 255) * sign }
            for (i in -radius..radius) add(source[index(i)], 1)
            for (i in 0 until count) {
                result[index(i)] = (255 shl 24) or ((red / diameter) shl 16) or ((green / diameter) shl 8) or (blue / diameter)
                add(source[index(i - radius)], -1); add(source[index(i + radius + 1)], 1)
            }
        }
        return result
    }
}
