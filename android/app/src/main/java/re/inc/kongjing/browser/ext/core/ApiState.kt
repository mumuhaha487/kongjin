package re.inc.kongjing.browser.ext.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Persistent API metadata; session rules and activeTab grants deliberately never hit disk. */
class ApiState(private val root: File,private val persist: (()->Unit)->Unit = {it()}) {
    fun cache(name:String):File {require(Regex("[a-zA-Z0-9.-]+").matches(name));return File(root,name)}
    private val values=mutableMapOf<String,JSONObject>()
    fun data(id: String): JSONObject = values.getOrPut(id) {
        val f=File(root,"$id.json"); if(f.isFile) JSONObject(f.readText()) else JSONObject()
    }
    fun section(id: String,key: String): JSONObject { val data=data(id); return data.optJSONObject(key) ?: JSONObject().also { data.put(key,it) } }
    fun save(id: String) {val snapshot=data(id).toString();persist { root.mkdirs(); val f=File(root,"$id.json"); val tmp=File(root,"$id.tmp"); tmp.writeText(snapshot); java.nio.file.Files.move(tmp.toPath(),f.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE) } }
    fun remove(id: String) { values.remove(id); File(root,"$id.json").delete() }
}

class ExtensionAlarms(private val state: ApiState, private val emit: (String,JSONObject)->Unit) {
    fun call(id: String,method: String,args: JSONArray,now: Long=System.currentTimeMillis()): Any? {
        val alarms=state.section(id,"alarms")
        val name=if(args.opt(0) is String) args.getString(0) else ""
        return when(method) {
            "create" -> {
                val info=if(args.opt(0) is JSONObject) args.getJSONObject(0) else args.optJSONObject(1) ?: JSONObject()
                val whenAt=if(info.has("when")) info.getDouble("when").toLong() else now+(info.optDouble("delayInMinutes",info.optDouble("periodInMinutes",0.0))*60000).toLong()
                val alarm=JSONObject().put("name",name).put("scheduledTime",whenAt)
                if(info.has("periodInMinutes")) { require(info.getDouble("periodInMinutes")>0); alarm.put("periodInMinutes",info.getDouble("periodInMinutes")) }
                alarms.put(name,alarm); state.save(id); null
            }
            "get" -> alarms.optJSONObject(name)
            "getAll" -> JSONArray(alarms.keys().asSequence().map { alarms.getJSONObject(it) }.toList())
            "clear" -> (alarms.remove(name)!=null).also { state.save(id) }
            "clearAll" -> (alarms.length()>0).also { state.data(id).put("alarms",JSONObject()); state.save(id) }
            else -> error("未知 alarms 方法")
        }
    }
    fun tick(ids: Collection<String>,now: Long=System.currentTimeMillis()) {
        ids.forEach { id ->
            val alarms=state.section(id,"alarms"); var dirty=false
            alarms.keys().asSequence().toList().forEach { key ->
                val a=alarms.getJSONObject(key)
                if(a.getLong("scheduledTime")<=now) {
                    dirty=true; emit(id,JSONObject(a.toString()))
                    if(a.has("periodInMinutes")) a.put("scheduledTime",now+(a.getDouble("periodInMinutes")*60000).toLong().coerceAtLeast(1000)) else alarms.remove(key)
                }
            }
            if(dirty) state.save(id)
        }
    }
}

class DnrRegistry(private val state: ApiState) {
    private val session=mutableMapOf<String,JSONArray>()
    @Volatile var engine: DnrEngine?=null; private set
    fun call(e: InstalledExtension,method: String,args: JSONArray): Any? {
        val id=e.id; val data=state.data(id)
        fun current(key: String)=if(key=="sessionRules") session[id] ?: JSONArray() else data.optJSONArray(key) ?: JSONArray()
        return when(method) {
            "getDynamicRules" -> current("dynamicRules")
            "getSessionRules" -> current("sessionRules")
            "updateDynamicRules","updateSessionRules" -> {
                val key=if(method=="updateDynamicRules") "dynamicRules" else "sessionRules"
                val update=args.getJSONObject(0); val remove=update.optJSONArray("removeRuleIds")?.values()?.toSet() ?: emptySet()
                val rules=current(key).values().map { it as JSONObject }.filterNot { it.getInt("id") in remove }+update.objects("addRules")
                require(rules.size<=30000) { "规则超出配额" }; val array=JSONArray(rules)
                DnrEngine.compile(mapOf(id to array)) // Validate whole transaction before mutating state.
                if(key=="sessionRules") session[id]=array else { data.put(key,array); state.save(id) }; null
            }
            "getEnabledRulesets" -> JSONArray(enabled(e))
            "updateEnabledRulesets" -> {
                val o=args.getJSONObject(0); val available=e.manifest.json.optJSONObject("declarative_net_request")?.objects("rule_resources")?.map { it.getString("id") }?.toSet() ?: emptySet()
                require(available.containsAll(o.strings("enableRulesetIds")+o.strings("disableRulesetIds")))
                val enabled=(enabled(e).toSet()-o.strings("disableRulesetIds").toSet())+o.strings("enableRulesetIds")
                data.put("enabledRulesets",JSONArray(enabled.toList())); state.save(id); null
            }
            "isRegexSupported" -> JSONObject().put("isSupported",DnrEngine.regexSupported(args.getJSONObject(0).getString("regex")))
            "getAvailableStaticRuleCount" -> 300000
            else -> error("未知 DNR 方法")
        }
    }
    private fun enabled(e: InstalledExtension): List<String> = state.data(e.id).optJSONArray("enabledRulesets")?.values()?.map { it as String } ?: e.manifest.json.optJSONObject("declarative_net_request")?.objects("rule_resources")?.filter { it.optBoolean("enabled") }?.map { it.getString("id") } ?: emptyList()
    fun rebuild(extensions: List<InstalledExtension>) {
        val all=linkedMapOf<String,JSONArray>()
        extensions.filter { it.enabled }.forEach { e ->
            val rules=mutableListOf<JSONObject>(); var compiledId=1
            e.manifest.json.optJSONObject("declarative_net_request")?.objects("rule_resources")?.filter { it.getString("id") in enabled(e) }?.forEach { rs ->
                val f=SafeZip.path(e.root,rs.getString("path").trimStart('/'))
                if(f.isFile) JSONArray(f.readText()).values().forEach { raw ->
                    val r=JSONObject((raw as JSONObject).toString()).put("id",compiledId++)
                    // P1 headers are explicitly unavailable; do not prevent valid P0 rules loading.
                    if(r.getJSONObject("action").getString("type")!="modifyHeaders") rules+=r
                }
            }
            for(key in listOf("dynamicRules","sessionRules")) {
                val values=if(key=="sessionRules") session[e.id] else state.data(e.id).optJSONArray(key)
                values?.values()?.forEach { rules+=JSONObject((it as JSONObject).toString()).put("id",compiledId++) }
            }
            if(rules.isNotEmpty()) all[e.id]=JSONArray(rules)
        }
        if(all.isEmpty()) {engine=null;return}
        val digest=java.security.MessageDigest.getInstance("SHA-256")
        all.forEach {(id,rules)->digest.update(id.toByteArray());digest.update(rules.toString().toByteArray())}
        val key=digest.digest().joinToString(""){"%02x".format(it)}
        val cache=state.cache("compiled-$key.bin")
        engine=if(cache.isFile)runCatching {DnrEngine.readCache(cache)}.getOrElse {DnrEngine.compile(all).also {it.writeCache(cache)}} else DnrEngine.compile(all).also {it.writeCache(cache)}
        cache.parentFile?.listFiles()?.filter {it.name.startsWith("compiled-") && it!=cache}?.forEach {it.delete()}
    }
    fun remove(id: String) { session.remove(id);state.remove(id) }
}
