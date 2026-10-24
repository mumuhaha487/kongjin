package re.inc.kongjing.browser.ext.core

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.ArrayDeque

data class DnrRequest(val url: String, val initiator: String="", val type: String="other", val method: String="GET", val tabId: Int=-1, val frameId: Int=0)
data class DnrMatch(val extensionId: String, val ruleId: Int, val priority: Int, val action: String, val redirectUrl: String?=null)

/** Immutable compiled rule index. Safe to read concurrently from shouldInterceptRequest. */
class DnrEngine private constructor(private val rules: List<Rule>, buildIndex: Boolean=true) {
    private data class Rule(val ext: String,val id: Int,val priority: Int,val action: String,val condition: JSONObject,val actionData: JSONObject,
        val filter: Regex?, val keyword: String, val domains: List<String>) {
        val excludedDomains=condition.strings("excludedRequestDomains").map {it.lowercase()}.toHashSet()
        val initiators=condition.strings("initiatorDomains").map {it.lowercase()}.toHashSet()
        val excludedInitiators=condition.strings("excludedInitiatorDomains").map {it.lowercase()}.toHashSet()
        val types=condition.strings("resourceTypes").toHashSet()
        val excludedTypes=condition.strings("excludedResourceTypes").toHashSet()
        val methods=condition.strings("requestMethods").toHashSet()
        val excludedMethods=condition.strings("excludedRequestMethods").toHashSet()
        val tabs=condition.optJSONArray("tabIds")?.values()?.toHashSet() ?: emptySet<Any>()
        val excludedTabs=condition.optJSONArray("excludedTabIds")?.values()?.toHashSet() ?: emptySet<Any>()
        val domainType=condition.optString("domainType")
    }
    private class Node { val next=HashMap<Char,Int>(); var fail=0; val outputs=ArrayList<Int>() }
    private val nodes=ArrayList<Node>().also { it+=Node() }
    private val domains=HashMap<String,MutableList<Int>>()
    private val fallback=ArrayList<Int>()
    init {
        if(buildIndex) rules.forEachIndexed { i,r ->
            if(r.domains.isNotEmpty()) r.domains.forEach { domains.getOrPut(it.lowercase()) { ArrayList() }.add(i) }
            else if(r.keyword.length>=3) { var n=0; r.keyword.forEach { c -> n=nodes[n].next.getOrPut(c) { nodes.add(Node()); nodes.lastIndex } }; nodes[n].outputs.add(i) }
            else fallback.add(i)
        }
        val queue=ArrayDeque<Int>(); if(buildIndex)nodes[0].next.values.forEach(queue::add)
        while(queue.isNotEmpty()) {
            val n=queue.removeFirst()
            nodes[n].next.forEach { (c,v) ->
                queue.add(v); var f=nodes[n].fail
                while(f!=0 && c !in nodes[f].next) f=nodes[f].fail
                nodes[v].fail=nodes[f].next[c] ?: 0
                nodes[v].outputs.addAll(nodes[nodes[v].fail].outputs)
            }
        }
    }
    /** Cache stores the compiled trie/domain index; no Java object deserialization. */
    fun writeCache(file:java.io.File) {
        file.parentFile?.mkdirs();val temp=java.io.File(file.parentFile,file.name+".tmp")
        java.io.DataOutputStream(temp.outputStream().buffered()).use {out->
            fun string(s:String){val b=s.toByteArray();out.writeInt(b.size);out.write(b)}
            out.writeInt(0x4b4a4431);out.writeInt(rules.size)
            rules.forEach {r->string(r.ext);out.writeInt(r.id);out.writeInt(r.priority);string(r.action);string(r.condition.toString());string(r.actionData.toString());string(r.filter?.pattern ?: "");out.writeBoolean(r.filter?.options?.contains(RegexOption.IGNORE_CASE)==true);string(r.keyword)}
            out.writeInt(nodes.size);nodes.forEach {n->out.writeInt(n.fail);out.writeInt(n.next.size);n.next.forEach {(c,i)->out.writeChar(c.code);out.writeInt(i)};out.writeInt(n.outputs.size);n.outputs.forEach(out::writeInt)}
            out.writeInt(domains.size);domains.forEach {(domain,ids)->string(domain);out.writeInt(ids.size);ids.forEach(out::writeInt)}
            out.writeInt(fallback.size);fallback.forEach(out::writeInt)
        }
        java.nio.file.Files.move(temp.toPath(),file.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE)
    }
    fun match(request: DnrRequest, inheritedAllows: Map<String,Int> = emptyMap()): DnrMatch? {
        val uri=runCatching { URI(request.url) }.getOrNull() ?: return null
        val host=uri.host?.lowercase() ?: return null
        val initiator=runCatching { URI(request.initiator).host?.lowercase() ?: "" }.getOrDefault("")
        val candidates=HashSet<Int>(16); candidates.addAll(fallback)
        var suffix=host
        while(true) { domains[suffix]?.let(candidates::addAll); val dot=suffix.indexOf('.'); if(dot<0) break; suffix=suffix.substring(dot+1) }
        var n=0
        request.url.lowercase().forEach { c ->
            while(n!=0 && c !in nodes[n].next) n=nodes[n].fail
            n=nodes[n].next[c] ?: 0
            if(nodes[n].outputs.isNotEmpty()) candidates.addAll(nodes[n].outputs)
        }
        val perExtension=HashMap<String,Rule>()
        candidates.forEach { i ->
            val r=rules[i]
            if(r.priority <= (inheritedAllows[r.ext] ?: 0) || !matches(r,request,host,initiator)) return@forEach
            val previous=perExtension[r.ext]
            if(previous==null || compare(r,previous)>0) perExtension[r.ext]=r
        }
        // Across extensions Chrome gives block precedence over redirect/upgrade over allow.
        val winning=perExtension.values.maxWithOrNull(compareBy<Rule> { crossRank(it.action) }.thenBy { it.priority }.thenBy { it.id }) ?: return null
        val redirect=when(winning.action) {
            "upgradeScheme" -> if(uri.scheme=="http") "https"+request.url.substring(4) else null
            "redirect" -> redirect(winning,request.url)
            else -> null
        }
        return DnrMatch(winning.ext,winning.id,winning.priority,winning.action,redirect)
    }
    private fun matches(r: Rule,q: DnrRequest,host: String,initiator: String): Boolean {
        fun domain(set:Set<String>,value:String):Boolean {if(set.isEmpty())return false;var suffix=value;while(true){if(suffix in set)return true;val dot=suffix.indexOf('.');if(dot<0)return false;suffix=suffix.substring(dot+1)}}
        // A rule with requestDomains reaches this stage only via the exact domain suffix index.
        if(domain(r.excludedDomains,host) || r.initiators.isNotEmpty() && !domain(r.initiators,initiator) || domain(r.excludedInitiators,initiator))return false
        if(r.types.isNotEmpty() && q.type !in r.types || q.type in r.excludedTypes)return false
        if(r.methods.isNotEmpty() && q.method.lowercase() !in r.methods || q.method.lowercase() in r.excludedMethods)return false
        if(r.tabs.isNotEmpty() && q.tabId !in r.tabs || q.tabId in r.excludedTabs)return false
        val thirdParty=site(host)!=site(initiator)
        if(r.domainType=="thirdParty" && !thirdParty || r.domainType=="firstParty" && thirdParty) return false
        return r.filter?.containsMatchIn(q.url) ?: true
    }
    private fun redirect(r: Rule,url: String): String? = runCatching {
        val d=r.actionData.optJSONObject("redirect") ?: return null
        if(d.has("url")) return safeRedirect(d.getString("url"))
        if(d.has("extensionPath")) return "https://${r.ext}.ext.kongjing.invalid/"+d.getString("extensionPath").trimStart('/')
        if(d.has("regexSubstitution")) {
            val match=r.filter?.find(url) ?: return null
            val replacement=Regex("\\\\([0-9])").replace(d.getString("regexSubstitution")) { m -> match.groups[m.groupValues[1].toInt()]?.value ?: "" }
            return safeRedirect(url.replaceRange(match.range,replacement))
        }
        val t=d.optJSONObject("transform") ?: return null
        val u=URI(url)
        var query=if(t.has("query")) t.getString("query").removePrefix("?") else u.rawQuery
        t.optJSONObject("queryTransform")?.let { qt ->
            val params=(query ?: "").split('&').filter { it.isNotEmpty() && it.substringBefore('=') !in qt.strings("removeParams") }.toMutableList()
            qt.objects("addOrReplaceParams").forEach { p -> val key=java.net.URLEncoder.encode(p.getString("key"),"UTF-8"); val found=params.any { it.substringBefore('=')==key }; if(found || !p.optBoolean("replaceOnly")) { params.removeAll { it.substringBefore('=')==key }; params.add(key+"="+java.net.URLEncoder.encode(p.getString("value"),"UTF-8")) } }
            query=params.joinToString("&").ifEmpty { null }
        }
        val scheme=t.optString("scheme",u.scheme); val host=t.optString("host",u.host); val port=if(t.has("port")) t.optString("port").toIntOrNull() ?: -1 else u.port
        val path=t.optString("path",u.rawPath); val fragment=if(t.has("fragment")) t.getString("fragment").removePrefix("#") else u.rawFragment
        safeRedirect("$scheme://$host${if(port>=0) ":$port" else ""}${path.ifEmpty { "/" }}${query?.let { "?$it" } ?: ""}${fragment?.let { "#$it" } ?: ""}")
    }.getOrNull()
    companion object {
        fun readCache(file:java.io.File):DnrEngine = java.io.DataInputStream(file.inputStream().buffered()).use {input->
            fun count(max:Int):Int=input.readInt().also {require(it in 0..max)}
            fun string():String {val bytes=ByteArray(count(32*1024*1024));input.readFully(bytes);return bytes.toString(Charsets.UTF_8)}
            require(file.length()<=200*1024*1024 && input.readInt()==0x4b4a4431)
            val rules=List(count(500000)) {
                val ext=string();require(Regex("[a-p]{32}").matches(ext));val id=input.readInt();val priority=input.readInt();val action=string();val condition=JSONObject(string());val data=JSONObject(string());val pattern=string();val ignore=input.readBoolean();val keyword=string()
                Rule(ext,id,priority,action,condition,data,pattern.takeIf {it.isNotEmpty()}?.let {Regex(it,if(ignore)setOf(RegexOption.IGNORE_CASE)else emptySet())},keyword,condition.strings("requestDomains"))
            }
            val engine=DnrEngine(rules,false);engine.nodes.clear()
            repeat(count(3000000)) {val n=Node();n.fail=input.readInt();repeat(count(65536)){n.next[input.readChar()]=input.readInt()};repeat(count(rules.size)){n.outputs+=input.readInt().also {require(it in rules.indices)}};engine.nodes+=n}
            require(engine.nodes.isNotEmpty());engine.nodes.forEach {n->require(n.fail in engine.nodes.indices && n.next.values.all {it in engine.nodes.indices})}
            repeat(count(500000)){val domain=string();val ids=MutableList(count(rules.size)){input.readInt().also {require(it in rules.indices)}};engine.domains[domain]=ids}
            repeat(count(rules.size)){engine.fallback+=input.readInt().also {require(it in rules.indices)}}
            require(input.read()==-1);engine
        }
        private fun site(host: String): String { val parts=host.split('.'); val two=parts.takeLast(2).joinToString("."); return if(two in setOf("co.uk","com.au","co.jp","com.cn","com.sg","co.nz","com.br","co.in")) parts.takeLast(3).joinToString(".") else two }
        private fun rank(a: String)=when(a) { "allow"->5; "allowAllRequests"->4; "block"->3; "upgradeScheme"->2; "redirect"->1; else->0 }
        private fun crossRank(a: String)=when(a) { "block"->3; "redirect","upgradeScheme"->2; else->1 }
        private fun compare(a: Rule,b: Rule)=compareValuesBy(a,b,{it.priority},{rank(it.action)},{it.id})
        private fun safeRedirect(url: String): String?=url.takeIf { runCatching { URI(it).scheme in setOf("http","https") && URI(it).rawUserInfo==null }.getOrDefault(false) }
        fun regexSupported(value: String): Boolean = value.length<=2000 && !Regex("\\(\\?[=!<]|\\\\[1-9]|\\(\\?>").containsMatchIn(value) && runCatching { Regex(value) }.isSuccess
        fun compile(extensions: Map<String,JSONArray>): DnrEngine {
            val all=ArrayList<Rule>()
            extensions.forEach { (ext,array) ->
                val ids=HashSet<Int>()
                array.values().forEach { raw ->
                    val r=raw as JSONObject; val id=r.getInt("id"); require(id>0 && ids.add(id)) { "规则 ID 无效/重复" }
                    val priority=r.optInt("priority",1); require(priority>=1)
                    val a=r.getJSONObject("action"); val action=a.getString("type"); require(action in setOf("allow","allowAllRequests","block","upgradeScheme","redirect")) { "不支持 $action" }
                    val c=r.getJSONObject("condition"); require(!(c.has("urlFilter") && c.has("regexFilter")))
                    if(action=="allowAllRequests") require(c.strings("resourceTypes").isNotEmpty() && c.strings("resourceTypes").all { it in setOf("main_frame","sub_frame") })
                    val case=c.optBoolean("isUrlFilterCaseSensitive")
                    var keyword=""
                    val pattern=if(c.has("regexFilter")) { val regex=c.getString("regexFilter"); require(regexSupported(regex)) { "正则不在 RE2 支持范围" }; Regex(regex,if(case) emptySet() else setOf(RegexOption.IGNORE_CASE)) }
                    else if(c.has("urlFilter")) {
                        val filter=c.getString("urlFilter"); require(filter.isNotEmpty())
                        keyword=filter.split('*','^','|').maxByOrNull { it.length }?.lowercase() ?: ""
                        val domainAnchor=filter.startsWith("||"); val start=filter.startsWith('|') && !domainAnchor; val end=filter.endsWith('|')
                        val body=filter.removePrefix(if(domainAnchor) "||" else if(start) "|" else "").let { if(end) it.dropLast(1) else it }
                        val regex=buildString { if(domainAnchor) append("^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/@]*@)?(?:[^/:]*\\.)?") else if(start) append('^'); body.forEach { char -> append(when(char) { '*'->".*"; '^'->"(?:[^A-Za-z0-9_.%\\-]|$)"; else->Regex.escape(char.toString()) }) }; if(end) append('$') }
                        Regex(regex,if(case) emptySet() else setOf(RegexOption.IGNORE_CASE))
                    } else null
                    all+=Rule(ext,id,priority,action,c,a,pattern,keyword,c.strings("requestDomains"))
                }
            }
            return DnrEngine(all)
        }
        fun resourceType(main: Boolean,headers: Map<String,String>): String {
            if(main) return "main_frame"
            val h=headers.mapKeys { it.key.lowercase() }; val dest=h["sec-fetch-dest"]
            return when(dest) { "iframe","frame"->"sub_frame"; "script","worker","sharedworker","serviceworker"->"script"; "style"->"stylesheet"; "image"->"image"; "font"->"font"; "video","audio","track"->"media"; "empty"->"xmlhttprequest"; else-> when { h["accept"]?.startsWith("image/")==true->"image"; h["accept"]?.contains("text/css")==true->"stylesheet"; else->"other" } }
        }
    }
}
