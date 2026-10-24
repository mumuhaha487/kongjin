package re.inc.kongjing.browser.ext.core

import java.io.File
import java.net.URI
import java.net.URLDecoder

object ResourceGate {
    data class Resource(val status: Int, val mime: String, val bytes: ByteArray, val headers: Map<String,String> = emptyMap())
    fun extensionId(url: String): String? = runCatching {
        val u=URI(url); require(u.scheme=="https" && u.port==-1 && u.rawUserInfo==null)
        Regex("([a-p]{32})\\.ext\\.kongjing\\.invalid").matchEntire(u.host ?: "")?.groupValues?.get(1)
    }.getOrNull()
    fun reserved(url: String): Boolean = runCatching { URI(url).host?.lowercase()?.let { it=="ext.kongjing.invalid" || it.endsWith(".ext.kongjing.invalid") }==true }.getOrDefault(false)
    fun resolve(e: InstalledExtension, url: String, initiator: String?, trusted: Boolean=false): Resource {
        val notFound=Resource(404,"text/plain",ByteArray(0))
        if(!e.enabled || extensionId(url)!=e.id) return notFound
        val path=runCatching {
            // Decode once; reject encoded separators and nested encodings before canonicalization.
            val raw=URI(url).rawPath
            require(!Regex("%2f|%5c|%00|%25",RegexOption.IGNORE_CASE).containsMatchIn(raw))
            URLDecoder.decode(raw.replace("+","%2B"),"UTF-8").removePrefix("/")
        }.getOrNull() ?: return notFound
        val owner=trusted || initiator?.let { extensionId(it)==e.id }==true
        if(!owner && !accessible(e.manifest,path,initiator)) return notFound
        val file=runCatching { SafeZip.path(e.root,path) }.getOrNull() ?: return notFound
        if(!file.isFile) return notFound
        val mime=when(file.extension.lowercase()) { "html","htm"->"text/html"; "js","mjs"->"application/javascript"; "css"->"text/css"; "json"->"application/json"; "png"->"image/png"; "jpg","jpeg"->"image/jpeg"; "svg"->"image/svg+xml"; "woff2"->"font/woff2"; "wasm"->"application/wasm"; "gif"->"image/gif"; "webp"->"image/webp"; else->"application/octet-stream" }
        val csp=e.manifest.json.optJSONObject("content_security_policy")?.optString("extension_pages") ?: e.manifest.json.optString("content_security_policy").takeIf { it.isNotBlank() } ?: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
        return Resource(200,mime,file.readBytes(),mapOf("X-Content-Type-Options" to "nosniff","Access-Control-Allow-Origin" to "*","Content-Security-Policy" to csp))
    }
    private fun accessible(m: ExtensionManifest, path: String, origin: String?): Boolean {
        if(path.startsWith("_kj/") || origin==null || !MatchPattern.allowedPage(origin)) return false
        val resources=m.json.optJSONArray("web_accessible_resources") ?: return false
        return resources.values().any { entry -> when(entry) {
            is String -> m.json.optInt("manifest_version")==2 && MatchPattern.glob(entry,path)
            is org.json.JSONObject -> entry.strings("resources").any { MatchPattern.glob(it,path) } && entry.strings("matches").any { MatchPattern.matches(it,origin,true) }
            else -> false
        } }
    }
}
