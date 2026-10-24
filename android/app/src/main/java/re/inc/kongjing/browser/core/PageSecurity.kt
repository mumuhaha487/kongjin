package re.inc.kongjing.browser.core

import java.net.URI

/** A URL alone never proves TLS. Confirm only the completed, current navigation. */
object PageSecurity {
    fun confirmed(pageUrl: String, finishedUrl: String?, currentUrl: String?,
                  hasCertificate: Boolean, failed: Boolean): Boolean =
        !failed && hasCertificate && pageUrl == finishedUrl && pageUrl == currentUrl &&
            runCatching { URI(pageUrl).scheme.equals("https", ignoreCase = true) }.getOrDefault(false)
}
