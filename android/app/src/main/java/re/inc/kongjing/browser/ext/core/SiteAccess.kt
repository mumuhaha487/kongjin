package re.inc.kongjing.browser.ext.core

import java.net.URI

/** Manifest content matches grant DOM access, never cross-origin network access. */
object SiteAccess {
    fun declared(e: InstalledExtension, url: String): Boolean =
        (e.grantedHosts + e.manifest.contentScripts.flatMap { it.strings("matches") }).any { MatchPattern.matches(it,url,true) }
    fun policy(e: InstalledExtension, url: String, clicked: Boolean): Boolean = when(e.access) {
        "click" -> clicked
        "specific" -> e.sites.any { site -> runCatching { URI(site).host?.lowercase()==URI(url).host?.lowercase() && URI(site).host!=null }.getOrDefault(false) }
        else -> true
    }
    fun allowed(e: InstalledExtension, url: String, clicked: Boolean=false): Boolean = MatchPattern.allowedPage(url) &&
        policy(e,url,clicked) && (declared(e,url) || clicked && "activeTab" in e.grantedPermissions)
}
