package re.inc.kongjing.browser.ext

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.ext.core.*
import java.io.File

class DnrTest {
    private val id="ddkjiahejlhfcafbddmgiahcphecmpfh"
    private fun rule(n:Int,action:String="block",condition:String="{}",priority:Int=1,extra:String="")=JSONObject("""{"id":$n,"priority":$priority,"action":{"type":"$action"$extra},"condition":$condition}""")
    private fun engine(vararg rules:JSONObject)=DnrEngine.compile(mapOf(id to JSONArray(rules.toList())))
    private fun q(url:String,origin:String="https://publisher.test/",type:String="script",method:String="GET")=DnrRequest(url,origin,type,method)
    @Test fun anchorsSeparatorsAndDomainBoundaries() { val e=engine(rule(1,condition="""{"urlFilter":"||ads.test^"}"""));assertEquals("block",e.match(q("https://cdn.ads.test/a.js"))?.action);assertNull(e.match(q("https://ads.test.evil/a")));assertNull(e.match(q("https://good.test/ads.test/a"))) }
    @Test fun wildcardAndCaseSensitivity() { val e=engine(rule(1,condition="""{"urlFilter":"|https://example.test/AD*end|","isUrlFilterCaseSensitive":true}"""));assertNotNull(e.match(q("https://example.test/AD/path/end")));assertNull(e.match(q("https://example.test/ad/path/end")));assertNull(e.match(q("https://example.test/AD/path/end?query"))) }
    @Test fun domainsInitiatorExclusionsAndResourceTypes() { val e=engine(rule(1,condition="""{"requestDomains":["ads.test"],"excludedRequestDomains":["safe.ads.test"],"initiatorDomains":["news.test"],"excludedInitiatorDomains":["safe.news.test"],"resourceTypes":["script"],"excludedResourceTypes":["image"]}"""));assertNotNull(e.match(q("https://ads.test/a","https://news.test/")));assertNull(e.match(q("https://safe.ads.test/a","https://news.test/")));assertNull(e.match(q("https://ads.test/a","https://safe.news.test/")));assertNull(e.match(q("https://ads.test/a","https://news.test/","image"))) }
    @Test fun methodAndDomainType() { val e=engine(rule(1,condition="""{"requestMethods":["post"],"domainType":"thirdParty"}"""));assertNotNull(e.match(q("https://ads.test/a",method="POST")));assertNull(e.match(q("https://ads.test/a",method="GET")));assertNull(e.match(q("https://static.publisher.test/a",method="POST"))) }
    @Test fun allowWinsEqualPriorityButHigherPriorityBlockWins() {assertEquals("allow",engine(rule(1),rule(2,"allow")).match(q("https://a.test/"))?.action);assertEquals("block",engine(rule(1,priority=2),rule(2,"allow")).match(q("https://a.test/"))?.action)}
    @Test fun crossExtensionBlockBeatsOtherExtensionAllow() { val e=DnrEngine.compile(mapOf(id to JSONArray().put(rule(1,"allow",priority=100)),"a".repeat(32) to JSONArray().put(rule(1))));assertEquals("block",e.match(q("https://a.test/"))?.action) }
    @Test fun allowAllRequestsIsFrameOnlyAndPriorityPropagates() { val r=rule(1,"allowAllRequests","""{"resourceTypes":["main_frame"]}""");val e=engine(r,rule(2));assertEquals("allowAllRequests",e.match(q("https://a.test/",type="main_frame"))?.action);assertNull(engine(rule(2)).match(q("https://a.test/"),mapOf(id to 2)));try {engine(rule(1,"allowAllRequests"));fail()}catch(_:IllegalArgumentException){} }
    @Test fun redirectUrlExtensionAndUpgrade() { assertEquals("https://safe.test/",engine(rule(1,"redirect",extra=""", "redirect":{"url":"https://safe.test/"}""")).match(q("https://a.test/"))?.redirectUrl);assertEquals("https://$id.ext.kongjing.invalid/noop.js",engine(rule(1,"redirect",extra=""", "redirect":{"extensionPath":"/noop.js"}""")).match(q("https://a.test/"))?.redirectUrl);assertEquals("https://a.test/path?q=1",engine(rule(1,"upgradeScheme")).match(q("http://a.test/path?q=1"))?.redirectUrl) }
    @Test fun redirectTransformAndRegexSubstitution() { val e=engine(rule(1,"redirect",extra=""", "redirect":{"transform":{"scheme":"https","host":"safe.test","queryTransform":{"removeParams":["ad"],"addOrReplaceParams":[{"key":"x","value":"2"}]}}}"""));assertEquals("https://safe.test/path?keep=1&x=2",e.match(q("http://a.test/path?ad=1&keep=1"))?.redirectUrl);val regex=engine(rule(1,"redirect","""{"regexFilter":"^https://ads\\.test/(.*)"}""",extra=""", "redirect":{"regexSubstitution":"https://safe.test/\\1"}"""));assertEquals("https://safe.test/file.js",regex.match(q("https://ads.test/file.js"))?.redirectUrl) }
    @Test fun unsupportedRegexAndDuplicateIdsRejected() { assertFalse(DnrEngine.regexSupported("(?<=x)y"));assertFalse(DnrEngine.regexSupported("(x)\\1"));assertTrue(DnrEngine.regexSupported("^https?://[^/]+/ads"));try{engine(rule(1),rule(1));fail()}catch(_:IllegalArgumentException){} }
    @Test fun inferResourceTypeConservatively() {assertEquals("main_frame",DnrEngine.resourceType(true,emptyMap()));assertEquals("script",DnrEngine.resourceType(false,mapOf("Sec-Fetch-Dest" to "script")));assertEquals("image",DnrEngine.resourceType(false,mapOf("Accept" to "image/webp")));assertEquals("other",DnrEngine.resourceType(false,emptyMap()))}
    @Test fun compiledCachePreservesTrieDomainsAndPriority() {
        val e=engine(rule(1,condition="""{"urlFilter":"||ads.test^"}"""),rule(2,condition="""{"requestDomains":["tracker.test"]}"""),rule(3,"allow",priority=2,condition="""{"urlFilter":"safe"}"""))
        val file=java.nio.file.Files.createTempFile("dnr-cache-",".bin").toFile();try {e.writeCache(file);val loaded=DnrEngine.readCache(file);listOf("https://ads.test/a","https://tracker.test/a","https://ads.test/safe","https://good.test/").forEach {url->assertEquals(e.match(q(url)),loaded.match(q(url)))}}finally {file.delete()}
    }
    @Test fun realUblockThirtyThousandRulesCorrectnessAndBenchmark() {
        val dir=File("../extension-runtime/fixtures/ublock-lite/rulesets/main")
        val input=mutableListOf<JSONObject>()
        val names=(listOf("easylist","easyprivacy","ublock-filters","pgl")+dir.listFiles()!!.filter {it.extension=="json"}.sortedBy {it.name}.map {it.nameWithoutExtension}).distinct()
        for(name in names) {
            JSONArray(File(dir,"$name.json").readText()).values().map {it as JSONObject}.filter {it.getJSONObject("action").getString("type") in setOf("block","allow","allowAllRequests","upgradeScheme","redirect")}.forEach {if(input.size<30000)input+=JSONObject(it.toString()).put("id",input.size+1)}
            if(input.size==30000)break
        }
        assertEquals(30000,input.size)
        val start=System.nanoTime();val e=engine(*input.toTypedArray());val compileMs=(System.nanoTime()-start)/1e6
        val requests=listOf(q("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"),q("https://www.google-analytics.com/analytics.js"),q("https://www.example.com/main.js"),q("https://cdn.example.org/images/banner.png",type="image"),q("https://securepubads.g.doubleclick.net/tag/js/gpt.js"),q("https://000491b06a.com/ads.js"))
        val outcomes=requests.map {e.match(it)?.action}
        assertTrue("Real uBlock rules should block a known advertising/analytics request: $outcomes",outcomes.any {it=="block"})
        repeat(10000){e.match(requests[it%requests.size])}
        val ns=LongArray(20000){i->val before=System.nanoTime();e.match(requests[i%requests.size]);System.nanoTime()-before}.sorted()
        val result=JSONObject().put("rules",30000).put("samples",ns.size).put("compileMs",compileMs).put("p50Ms",ns[ns.size/2]/1e6).put("p95Ms",ns[(ns.size*.95).toInt()]/1e6).put("p99Ms",ns[(ns.size*.99).toInt()]/1e6).put("outcomes",JSONArray(outcomes))
        val output=File("../extension-runtime/test-results/dnr-benchmark.json");output.parentFile!!.mkdirs();output.writeText(result.toString(2));println("DNR_BENCHMARK=$result")
        assertTrue("P95 must be <= 0.2ms: $result",result.getDouble("p95Ms")<=0.2)
    }
}
