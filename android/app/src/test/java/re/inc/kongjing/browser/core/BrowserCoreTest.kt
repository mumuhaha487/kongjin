package re.inc.kongjing.browser.core

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BrowserCoreTest {
    @Test fun addressesAndSearchAreSeparated() {
        assertEquals("https://example.com/", UrlRules.resolve("example.com"))
        assertEquals("http://localhost:8080/a", UrlRules.resolve("http://localhost:8080/a"))
        assertEquals("http://127.0.0.1:8080/", UrlRules.resolve("127.0.0.1:8080"))
        assertEquals(UrlRules.searchUrl("[::1]:8080"), UrlRules.resolve("[::1]:8080"))
        assertEquals(UrlRules.searchUrl("例子.中国"), UrlRules.resolve("例子.中国"))
        assertEquals("https://www.bing.com/search?q=hello%20world", UrlRules.resolve("hello world"))
        assertNull(UrlRules.webUrl("https://good.com@evil.com"))
        assertNull(UrlRules.webUrl("https://"))
        assertNull(UrlRules.webUrl("javascript:alert(1)"))
    }
    @Test fun templatesAreValidatedAndEncoded() {
        assertTrue(UrlRules.validTemplate("https://www.baidu.com/s?wd=%s"))
        assertFalse(UrlRules.validTemplate("javascript:%s"))
        assertFalse(UrlRules.validTemplate("https://example.com/"))
        assertEquals("https://search.example/?q=a%26b%20%E7%A9%BA", UrlRules.resolve("a&b 空", "https://search.example/?q=%s"))
        assertEquals(UrlRules.resolve("test"), UrlRules.resolve("test", "file:///%s"))
    }
    @Test fun externalProtocolsNeverAcceptLocalOrScriptContent() {
        listOf("tel:123", "mailto:a@example.com", "weixin://dl/scan", "intent://scan/#Intent;scheme=zxing;end").forEach { assertTrue(it, UrlRules.externalAllowed(it)) }
        listOf("javascript:alert(1)", "file:///secret", "content://contacts", "data:text/html,evil", "blob:https://example.com/a", "https://example.com", "nonsense", "tel:12\n3").forEach { assertFalse(it, UrlRules.externalAllowed(it)) }
    }
    @Test fun homeOriginAndPathCannotBeSpoofed() {
        assertTrue(UrlRules.isHome(UrlRules.HOME))
        listOf("https://appassets.androidplatform.net.evil/home/", "http://appassets.androidplatform.net/home/", "https://appassets.androidplatform.net/home/../evil", "https://appassets.androidplatform.net:444/home/", "https://appassets.androidplatform.net/home/%2e%2e/evil", "https://evil@appassets.androidplatform.net/home/").forEach { assertFalse(it, UrlRules.isHome(it)) }
    }
    @Test fun recyclingKeepsHomeAndActiveAndUsesLru() {
        val pages = (1..13).map { TabUsage("$it", it.toLong()) } + TabUsage("home", 0, true)
        assertEquals(listOf("2", "3"), TabPolicy.victims(pages, "1"))
        assertTrue(TabPolicy.victims(pages.take(5), "1").isEmpty())
    }
    @Test fun permissionOriginsIncludeProtocolAndPort() {
        assertTrue(UrlRules.sameOrigin("https://example.com/", "https://example.com:443/path"))
        assertFalse(UrlRules.sameOrigin("https://example.com/", "https://example.com:8443/path"))
        assertFalse(UrlRules.sameOrigin("https://example.com/", "http://example.com/"))
        assertFalse(UrlRules.sameOrigin("about:blank", "about:blank"))
    }
    @Test fun codecEscapesArgumentsAndDecodesErrors() {
        val script = BridgeProtocol.script("id\"", "addBookmark", JSONObject().put("title", "');alert(1)//\n空境"))
        assertTrue(script.startsWith("window.kongjing.call(\"id\\\"\",\"addBookmark\",\""))
        assertFalse(script.contains("\n"))
        assertEquals("yes", (BridgeProtocol.decode("{\"ok\":true,\"data\":{\"id\":\"yes\"}}").getOrThrow() as JSONObject).getString("id"))
        assertTrue(BridgeProtocol.decode("{\"ok\":false,\"error\":\"no\"}").isFailure)
        assertTrue(BridgeProtocol.decode("invalid").isFailure)
    }
    @Test fun queuedCallsExpireAndLateRepliesAreIgnored() {
        val sent = mutableListOf<String>()
        val timers = mutableListOf<() -> Unit>()
        var result: Result<Any>? = null
        val bridge = BridgeDispatcher(sent::add) { delay, block ->
            assertEquals(5000L, delay)
            timers.add(block)
            val cancel: () -> Unit = { timers.remove(block); Unit }
            cancel
        }
        bridge.call("getGroups") { result = it }
        assertTrue(sent.isEmpty())
        timers.single()()
        assertTrue(result!!.isFailure)
        bridge.markReady()
        assertTrue(sent.isEmpty())
        bridge.reply("native-1", "{\"ok\":true,\"data\":[]}")
        assertTrue(result!!.isFailure)
    }
    @Test fun readyFlushesOnceAndReplyCancelsTimeout() {
        val sent = mutableListOf<String>()
        val timers = mutableListOf<() -> Unit>()
        var replies = 0
        val bridge = BridgeDispatcher(sent::add) { _, block ->
            timers.add(block)
            val cancel: () -> Unit = { timers.remove(block); Unit }
            cancel
        }
        bridge.call("getGroups") { assertTrue(it.isSuccess); replies++ }
        bridge.markReady(); bridge.markReady()
        assertEquals(1, sent.size)
        bridge.reply("native-1", "{\"ok\":true,\"data\":[]}")
        bridge.reply("native-1", "{\"ok\":true,\"data\":[]}")
        assertEquals(1, replies)
        assertTrue(timers.isEmpty())
        bridge.reset()
        bridge.call("getTheme") { }
        assertEquals(1, sent.size)
    }
}
