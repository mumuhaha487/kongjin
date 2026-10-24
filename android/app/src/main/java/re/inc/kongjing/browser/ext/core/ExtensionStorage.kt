package re.inc.kongjing.browser.ext.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Serialized by monitor; persistent areas are atomically replaced before events are emitted. */
class ExtensionStorage(private val root: File, private val changed: (String,String,JSONObject)->Unit = {_,_,_->}) {
    private val session=mutableMapOf<String,JSONObject>()
    private val trustedSession=mutableMapOf<String,Boolean>()
    private val writes=mutableMapOf<String,ArrayDeque<Long>>()
    @Synchronized private fun read(id: String, area: String): JSONObject {
        require(Regex("[a-p]{32}").matches(id) && area in setOf("local","sync","session","managed"))
        if(area=="managed") return JSONObject()
        if(area=="session") return JSONObject(session[id]?.toString() ?: "{}")
        val f=File(root,"$id/$area.json")
        return if(f.isFile) JSONObject(f.readText()) else JSONObject()
    }
    @Synchronized fun call(id: String, area: String, method: String, args: JSONArray, content: Boolean=false, unlimited: Boolean=false): Any? {
        require(!(content && (area=="session" && trustedSession[id] != false))) { "storage.session 仅允许可信扩展环境" }
        val data=read(id,area)
        val keys=args.opt(0)
        fun selected(): List<String> = when(keys) {
            null,JSONObject.NULL -> data.keys().asSequence().toList()
            is String -> listOf(keys)
            is JSONArray -> keys.values().map { it as String }
            is JSONObject -> keys.keys().asSequence().toList()
            else -> error("无效的 storage keys")
        }
        if(method=="setAccessLevel") {
            require(!content && area != "managed")
            val level=args.getJSONObject(0).getString("accessLevel"); require(level in setOf("TRUSTED_CONTEXTS","TRUSTED_AND_UNTRUSTED_CONTEXTS"))
            if(area=="session") trustedSession[id]=level=="TRUSTED_CONTEXTS"
            else { val f=File(root,"$id/$area.access"); f.parentFile!!.mkdirs(); f.writeText(level) }
            return null
        }
        if(content && File(root,"$id/$area.access").takeIf { it.isFile }?.readText()=="TRUSTED_CONTEXTS") error("storage 仅允许可信扩展环境")
        if(method=="get") return JSONObject().also { out -> selected().forEach { key -> if(data.has(key)) out.put(key,data.get(key)) else if(keys is JSONObject) out.put(key,keys.get(key)) } }
        if(method=="getBytesInUse") return selected().sumOf { key -> if(data.has(key)) key.toByteArray().size + data.get(key).let { (if(it is String) JSONObject.quote(it) else it.toString()).toByteArray().size } else 0 }
        require(area!="managed") { "storage.managed 是只读的" }
        val old=JSONObject(data.toString())
        when(method) {
            "set" -> { val values=args.getJSONObject(0); values.keys().forEach { data.put(it,values.get(it)) } }
            "remove" -> selected().forEach(data::remove)
            "clear" -> data.keys().asSequence().toList().forEach(data::remove)
            else -> error("未知 storage 方法")
        }
        val size=data.keys().asSequence().sumOf { key -> key.toByteArray().size + data.get(key).let { (if(it is String) JSONObject.quote(it) else it.toString()).toByteArray().size } }
        val quota=if(area=="sync") 102400 else if(unlimited && area=="local") Int.MAX_VALUE else 10485760
        require(size<=quota) { "QUOTA_BYTES quota exceeded" }
        if(area=="sync") {
            require(data.length()<=512) { "MAX_ITEMS quota exceeded" }
            data.keys().forEach { k -> require(k.toByteArray().size + (if(data.get(k) is String) JSONObject.quote(data.getString(k)) else data.get(k).toString()).toByteArray().size <=8192) { "QUOTA_BYTES_PER_ITEM quota exceeded" } }
            val q=writes.getOrPut(id) { ArrayDeque() }; val now=System.currentTimeMillis()
            while(q.isNotEmpty() && q.first()<now-3600000) q.removeFirst()
            require(q.size<1800 && q.count { it>now-60000 }<120) { "MAX_WRITE_OPERATIONS quota exceeded" }; q.addLast(now)
        }
        val changes=JSONObject()
        (old.keys().asSequence().toSet()+data.keys().asSequence().toSet()).forEach { k ->
            if(old.has(k)!=data.has(k) || old.opt(k)?.toString()!=data.opt(k)?.toString()) changes.put(k,JSONObject().also { c -> if(old.has(k)) c.put("oldValue",old.get(k)); if(data.has(k)) c.put("newValue",data.get(k)) })
        }
        if(area=="session") session[id]=data else {
            val f=File(root,"$id/$area.json"); f.parentFile!!.mkdirs(); val temp=File(f.path+".tmp"); temp.writeText(data.toString()); java.nio.file.Files.move(temp.toPath(),f.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE)
        }
        if(changes.length()>0) changed(id,area,changes)
        return null
    }
    @Synchronized fun remove(id: String) { session.remove(id); trustedSession.remove(id); writes.remove(id); File(root,id).deleteRecursively() }
}
