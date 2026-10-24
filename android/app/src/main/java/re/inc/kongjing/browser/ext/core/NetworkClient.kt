package re.inc.kongjing.browser.ext.core

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.Base64

/** URLConnection uses Android's system ProxySelector; never bypasses the configured proxy. */
class NetworkClient(private val cookies: (String)->String? = {null}, private val saveCookie: (String,String)->Unit = {_,_->}) {
    data class Response(val status: Int, val headers: Map<String,String>, val body: ByteArray, val url: String, val redirected: Boolean=false)
    fun request(url: String, method: String="GET", headers: Map<String,String> = emptyMap(), body: ByteArray?=null,
        allowed: (String)->Boolean = {true}, maxBytes: Int = 50*1024*1024,
        credentials: String="include", initiatorOrigin: String?=null, redirect: String="follow"): Response {
        var current=url; var verb=method.uppercase(); var payload=body; var currentHeaders=headers
        require(verb in setOf("GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"))
        require(credentials in setOf("omit","same-origin","include"))
        require(redirect in setOf("follow","error","manual"))
        val initiator=initiatorOrigin?.let { runCatching { URI(it) }.getOrNull() }
        var sameOriginChain=true
        repeat(11) { hop ->
            val uri=URI(current)
            require(uri.scheme in setOf("http","https") && uri.host!=null && uri.rawUserInfo==null && !uri.host.lowercase().endsWith(".ext.kongjing.invalid") && !uri.host.equals("appassets.androidplatform.net",true) && allowed(current)) { "无主机权限或禁止访问的 URL" }
            // A cross-origin redirect taints the chain even if it later returns to the initiator.
            sameOriginChain=sameOriginChain && initiator!=null && sameOrigin(uri,initiator)
            val useCredentials=credentials=="include" || credentials=="same-origin" && sameOriginChain
            val connection=URL(current).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects=false; connection.connectTimeout=20000; connection.readTimeout=30000; connection.requestMethod=verb
            try {
                currentHeaders.forEach { (k,v) ->
                    require('\r' !in k && '\n' !in k && '\r' !in v && '\n' !in v)
                    if(k.lowercase() !in setOf("host","cookie","cookie2","connection","content-length","proxy-authorization","origin")) connection.setRequestProperty(k,v)
                }
                if(useCredentials) cookies(current)?.let { connection.setRequestProperty("Cookie",it) }
                if(payload!=null && verb !in setOf("GET","HEAD")) { connection.doOutput=true; connection.outputStream.use { it.write(payload) } }
                val status=connection.responseCode
                if(useCredentials) connection.headerFields.filterKeys { it?.equals("Set-Cookie",true)==true }.values.flatten().forEach { saveCookie(current,it) }
                if(status in setOf(301,302,303,307,308) && connection.getHeaderField("Location")!=null) {
                    require(redirect!="error") { "禁止重定向" }
                    if(redirect=="manual") return Response(0,emptyMap(),ByteArray(0),url)
                    require(hop<10) { "重定向过多" }
                    val next=uri.resolve(connection.getHeaderField("Location")).toString()
                    if(!sameOrigin(URI(next),uri)) currentHeaders=currentHeaders.filterKeys { !it.equals("authorization",true) }
                    if(status in setOf(301,302) && verb=="POST" || status==303 && verb !in setOf("GET","HEAD")) {
                        verb="GET"; payload=null
                        currentHeaders=currentHeaders.filterKeys { it.lowercase() !in setOf("content-encoding","content-language","content-location","content-type") }
                    }
                    current=next
                } else {
                    require(connection.contentLengthLong<=maxBytes) { "响应超过大小限制" }
                    val stream=if(status>=400) connection.errorStream else connection.inputStream
                    val bytes=stream?.use { input ->
                        val out=java.io.ByteArrayOutputStream(); val buffer=ByteArray(16384)
                        while(true) { val n=input.read(buffer); if(n<0) break; require(out.size().toLong()+n<=maxBytes); out.write(buffer,0,n) }; out.toByteArray()
                    } ?: ByteArray(0)
                    return Response(status,connection.headerFields.filterKeys { it!=null }.mapValues { it.value.joinToString(", ") },bytes,current,hop>0)
                }
            } finally { connection.disconnect() }
        }
        error("重定向过多")
    }
    fun download(id: String, webViewMajor: Int): ByteArray {
        require(Regex("[a-p]{32}").matches(id))
        val url="https://clients2.google.com/service/update2/crx?response=redirect&prodversion=$webViewMajor.0.0.0&acceptformat=crx3&x=id%3D$id%26installsource%3Dondemand%26uc"
        val result=request(url,maxBytes=200*1024*1024,allowed={ URI(it).scheme=="https" })
        require(result.status==200) { "无法连接 Chrome 应用商店，请检查网络或代理设置" }
        return result.body
    }
    fun updates(versions: Map<String,String>, webViewMajor: Int): Map<String,String> {
        if(versions.isEmpty())return emptyMap()
        require(versions.size<=100 && versions.keys.all {Regex("[a-p]{32}").matches(it)})
        val queries=versions.entries.joinToString("&") {(id,v)->"x="+java.net.URLEncoder.encode("id=$id&v=$v&uc","UTF-8")}
        val url="https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=$webViewMajor.0.0.0&acceptformat=crx3&$queries"
        val response=request(url,maxBytes=1024*1024,allowed={URI(it).scheme=="https"})
        require(response.status==200)
        return parseUpdates(response.body)
    }
    companion object {
        private fun sameOrigin(first: URI, second: URI): Boolean {
            fun port(uri: URI)=if(uri.port!=-1) uri.port else if(uri.scheme.equals("https",true)) 443 else 80
            return first.host!=null && second.host!=null && first.scheme.equals(second.scheme,true) && first.host.equals(second.host,true) && port(first)==port(second)
        }
        internal fun parseUpdates(xml:ByteArray): Map<String,String> {
            require(!String(xml,Charsets.UTF_8).contains(Regex("<!\\s*(DOCTYPE|ENTITY)",RegexOption.IGNORE_CASE))) {"禁止 XML 外部实体"}
            val factory=javax.xml.parsers.DocumentBuilderFactory.newInstance()
            runCatching {factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true)}
            runCatching {factory.setFeature("http://xml.org/sax/features/external-general-entities",false)}
            runCatching {factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false)}
            runCatching {factory.isXIncludeAware=false};factory.isExpandEntityReferences=false
            val document=factory.newDocumentBuilder().parse(xml.inputStream())
            val apps=document.getElementsByTagName("app");val updates=linkedMapOf<String,String>()
            for(i in 0 until apps.length) {
                val app=apps.item(i) as org.w3c.dom.Element;val id=app.getAttribute("appid")
                if(!Regex("[a-p]{32}").matches(id))continue
                val check=app.getElementsByTagName("updatecheck").item(0) as? org.w3c.dom.Element ?: continue
                val version=check.getAttribute("version")
                if(check.getAttribute("status")=="ok" && Regex("[0-9]+(?:\\.[0-9]+){0,3}").matches(version))updates[id]=version
            }
            return updates
        }
    }
    fun fetchJson(url: String, options: JSONObject, hosts: Set<String>): JSONObject {
        val h=options.optJSONObject("headers") ?: JSONObject()
        val response=request(url,options.optString("method","GET"),h.keys().asSequence().associateWith { h.getString(it) },
            options.optString("bodyBase64").takeIf { it.isNotEmpty() }?.let { Base64.getDecoder().decode(it) },
            allowed={ target -> hosts.any { MatchPattern.matches(it,target,true) } },
            credentials=options.optString("credentials","same-origin"),initiatorOrigin=options.optString("initiatorOrigin").takeIf { it.isNotEmpty() },redirect=options.optString("redirect","follow"))
        val headers=response.headers.filterKeys { !it.equals("Set-Cookie",true) && !it.equals("Set-Cookie2",true) }
        return JSONObject().put("status",response.status).put("headers",JSONObject(headers)).put("url",response.url).put("redirected",response.redirected).put("bodyBase64",Base64.getEncoder().encodeToString(response.body))
    }
}
