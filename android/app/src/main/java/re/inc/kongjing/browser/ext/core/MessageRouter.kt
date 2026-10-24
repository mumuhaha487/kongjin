package re.inc.kongjing.browser.ext.core

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class SenderContext(val extensionId: String, val type: String, val tabId: Int?=null,
    val frameId: Int=0, val documentId: String=UUID.randomUUID().toString(), val url: String="") {
    fun json() = JSONObject().put("id",extensionId).put("url",url).put("origin",runCatching { java.net.URI(url).let { "${it.scheme}://${it.authority}" } }.getOrDefault(""))
        .put("frameId",frameId).put("documentId",documentId).also { if(tabId!=null) it.put("tab",JSONObject().put("id",tabId).put("url",url)) }
}

/** Native owned identities and exact document endpoints; no ctx identity is accepted from JS. */
class MessageRouter(private val schedule: (Long,()->Unit)->(()->Unit)) {
    data class Endpoint(val key: String, val sender: SenderContext, val send: (JSONObject)->Unit)
    private data class Pending(val senderKey: String, val callId: String, val receivers: MutableSet<String>, val cancel: ()->Unit)
    private data class Channel(val sender: String, val receivers: MutableSet<String>, val name: String)
    private val endpoints=linkedMapOf<String,Endpoint>()
    private val pending=mutableMapOf<String,Pending>()
    private val ports=mutableMapOf<String,Channel>()
    fun register(endpoint: Endpoint) { unregister(endpoint.key); endpoints[endpoint.key]=endpoint }
    fun unregister(key: String) {
        endpoints.remove(key)
        pending.toMap().forEach { (id,p) ->
            if(p.senderKey==key) { p.cancel(); pending.remove(id) }
            else if(p.receivers.remove(key) && p.receivers.isEmpty()) finish(id,null,"The message port closed before a response was received.")
        }
        ports.toMap().forEach { (id,p) -> if(p.sender==key) disconnect(id,key) else if(p.receivers.remove(key)) {
            emitPort(p.sender,id,"disconnect",error="The message port closed before a response was received.")
            if(p.receivers.isEmpty()) ports.remove(id)
        } }
    }
    private fun targets(source: Endpoint, tabId: Int?, frameId: Int?, documentId: String?): List<Endpoint> = endpoints.values.filter {
        it.key!=source.key && it.sender.extensionId==source.sender.extensionId &&
            (if(tabId==null) it.sender.type!="content" else it.sender.tabId==tabId && it.sender.type=="content") &&
            (frameId==null || it.sender.frameId==frameId) && (documentId==null || it.sender.documentId==documentId)
    }
    fun message(source: Endpoint, callId: String, message: Any?, tabId: Int?=null, frameId: Int?=null, documentId: String?=null) {
        val receivers=targets(source,tabId,frameId,documentId)
        if(receivers.isEmpty()) { reply(source.key,callId,null,"Could not establish connection. Receiving end does not exist."); return }
        val id=UUID.randomUUID().toString()
        val cancel=schedule(60000) { finish(id,null,"The message port closed before a response was received.") }
        pending[id]=Pending(source.key,callId,receivers.map { it.key }.toMutableSet(),cancel)
        receivers.forEach { it.send(JSONObject().put("v",1).put("kind","message").put("id",id).put("message",message ?: JSONObject.NULL).put("sender",source.sender.json())) }
    }
    fun response(source: Endpoint, id: String, value: Any?, handled: Boolean, error: String?=null) {
        val p=pending[id] ?: return
        if(source.key !in p.receivers) return
        if(handled) finish(id,value,error) else if(p.receivers.remove(source.key) && p.receivers.isEmpty()) finish(id,null,null)
    }
    private fun finish(id: String, value: Any?, error: String?) { val p=pending.remove(id) ?: return; p.cancel(); reply(p.senderKey,p.callId,value,error) }
    private fun reply(key: String, id: String, result: Any?, error: String?) { endpoints[key]?.send?.invoke(JSONObject().put("v",1).put("kind","reply").put("id",id).put("result",result ?: JSONObject.NULL).put("undefined",result==null).also { if(error!=null) it.put("error",error) }) }
    fun connect(source: Endpoint, portId: String, name: String, tabId: Int?=null, frameId: Int?=null, documentId: String?=null) {
        require(portId.length in 1..256 && portId !in ports)
        val targets=targets(source,tabId,frameId,documentId)
        if(targets.isEmpty()) { emitPort(source.key,portId,"disconnect",error="Could not establish connection. Receiving end does not exist."); return }
        ports[portId]=Channel(source.key,targets.map { it.key }.toMutableSet(),name)
        targets.forEach { it.send(JSONObject().put("v",1).put("kind","port").put("id",portId).put("op","connect").put("name",name).put("sender",source.sender.json())) }
    }
    fun post(source: Endpoint, id: String, value: Any?) {
        val p=ports[id] ?: error("Attempting to use a disconnected port object")
        if(p.sender==source.key) p.receivers.forEach { emitPort(it,id,"message",value) }
        else if(source.key in p.receivers) emitPort(p.sender,id,"message",value)
        else error("端口不属于当前文档")
    }
    fun disconnect(id: String, key: String) {
        val p=ports[id] ?: return
        if(key!=p.sender && key !in p.receivers) return
        ports.remove(id)
        (p.receivers+p.sender).filter { it!=key }.forEach { emitPort(it,id,"disconnect") }
    }
    private fun emitPort(key: String,id: String,op: String,value: Any?=null,error: String?=null) {
        endpoints[key]?.send?.invoke(JSONObject().put("v",1).put("kind","port").put("id",id).put("op",op).put("message",value ?: JSONObject.NULL).also { if(error!=null) it.put("error",error) })
    }
    fun event(extensionId: String, name: String, args: JSONArray, predicate: (SenderContext)->Boolean = {true}) {
        endpoints.values.filter { it.sender.extensionId==extensionId && predicate(it.sender) }.toList().forEach { it.send(JSONObject().put("v",1).put("kind","event").put("api",name).put("args",args)) }
    }
    fun endpoint(key: String) = endpoints[key]
    companion object {
        private val contentRuntime=setOf("sendMessage","connect","getURL","getManifest")
        fun check(sender: SenderContext, manifest: ExtensionManifest, api: String, granted: Set<String>) {
            val parts=api.split('.'); require(parts.size>=2 && parts.size<=3)
            val ns=Capabilities.canonical(parts[0]); val method=parts.last()
            require(sender.extensionId==manifest.id)
            if(sender.type=="content") require(ns in setOf("runtime","storage","i18n") && (ns!="runtime" || method in contentRuntime)) { "内容脚本不能调用 $api" }
            if(api=="network.fetch") { require(sender.type!="content"); return }
            require(method in (Capabilities.p0[ns] ?: Capabilities.p1Methods[ns] ?: emptySet())) { "空境尚不支持 $api" }
            val permission=when(ns) { "storage","scripting","alarms","notifications","contextMenus","declarativeNetRequest","cookies","downloads","offscreen","userScripts","webNavigation" -> ns; else -> null }
            if(permission!=null) require(permission in granted || ns=="contextMenus" && "menus" in granted || ns=="declarativeNetRequest" && "declarativeNetRequestWithHostAccess" in granted) { "缺少 $permission 权限" }
        }
    }
}
