package re.inc.kongjing.browser

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import re.inc.kongjing.browser.core.UrlRules
import java.util.UUID

class BrowserTab(val id: String = UUID.randomUUID().toString(), initialUrl: String = UrlRules.HOME, initialTitle: String = "空境", initialDesktop: Boolean = false, val incognito: Boolean = false) {
    var url by mutableStateOf(initialUrl)
    var title by mutableStateOf(initialTitle)
    var desktop by mutableStateOf(initialDesktop)
    var icon by mutableStateOf<Bitmap?>(null)
    var faviconUrl by mutableStateOf<String?>(null)
    var preview by mutableStateOf<Bitmap?>(null)
    var progress by mutableFloatStateOf(1f)
    var canBack by mutableStateOf(false)
    var canForward by mutableStateOf(false)
    var lastUsed by mutableLongStateOf(System.currentTimeMillis())
    var error by mutableStateOf<String?>(null)
    var secure by mutableStateOf(false)
    val home: Boolean get() = UrlRules.isHome(url)
}
