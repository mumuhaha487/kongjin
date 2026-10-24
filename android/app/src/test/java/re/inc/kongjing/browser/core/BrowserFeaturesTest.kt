package re.inc.kongjing.browser.core

import org.junit.Assert.*
import org.junit.Test

class BrowserFeaturesTest {
    @Test fun sectionSevenMethodsCanDispatchAndReplyWithoutCrashing() {
        val sent=mutableListOf<String>()
        val bridge=BridgeDispatcher(sent::add) { _, _ -> {} }
        bridge.markReady()
        listOf("scrollToTop","addReadLater","pairWithCode","browserPrefsChanged").forEachIndexed { i, method ->
            var completed=false
            bridge.call(method,org.json.JSONObject().put("code","KJ-ABCDE-12345")) { completed=it.isSuccess }
            assertTrue(sent.last().contains(org.json.JSONObject.quote(method)))
            bridge.reply("native-${i+1}","{\"ok\":true,\"data\":{}}")
            assertTrue(completed)
        }
    }
    @Test fun historyTargetsUseSnapshotBoundsAndRejectOverflow() {
        assertTrue(BrowserFeatures.historyTarget(2,3,-2)); assertTrue(BrowserFeatures.historyTarget(0,3,2))
        assertFalse(BrowserFeatures.historyTarget(0,3,-1)); assertFalse(BrowserFeatures.historyTarget(2,3,1))
        assertFalse(BrowserFeatures.historyTarget(0,0,1)); assertFalse(BrowserFeatures.historyTarget(1,3,0))
        assertFalse(BrowserFeatures.historyTarget(Int.MAX_VALUE-1,Int.MAX_VALUE,Int.MAX_VALUE))
    }
    @Test fun scanAcceptsOnlyWebOrExplicitPairCodes() {
        assertEquals(ScanTarget.Web("https://example.com/"), BrowserFeatures.scan("https://example.com"))
        assertEquals(ScanTarget.Pairing("KJ-ABCDE-12345"), BrowserFeatures.scan("KJ-ABCDE-12345"))
        assertEquals(ScanTarget.Pairing("KJ-ABCDE-12345"), BrowserFeatures.scan("kongjing://pair?code=KJ-ABCDE-12345"))
        listOf("javascript:alert(1)","intent://x", "file:///x", "https://appassets.androidplatform.net/home/x", "kongjing://other?code=KJ-ABCDE-12345", "KJ-AAA-12345", "example.com").forEach { assertNull(it, BrowserFeatures.scan(it)) }
    }
    @Test fun clipboardAndLocalPrefsAreValidated() {
        assertEquals("http://localhost/", BrowserFeatures.clipboard("localhost"))
        assertEquals("http://192.168.1.1/", BrowserFeatures.clipboard("192.168.1.1"))
        assertNull(BrowserFeatures.clipboard("baidu.com是什么网站"))
        assertNull(BrowserFeatures.clipboard("javascript:alert(1)"))
        assertEquals(80, BrowserFeatures.zoom(-10)); assertEquals(150, BrowserFeatures.zoom(200))
        assertNull(BrowserFeatures.dark("auto")); assertEquals("follow", BrowserFeatures.dark("follow"))
        assertTrue(BrowserFeatures.darkEnabled("on",false));assertTrue(BrowserFeatures.darkEnabled("follow",true))
        assertFalse(BrowserFeatures.darkEnabled("off",true));assertFalse(BrowserFeatures.darkEnabled("follow",false))
    }
    @Test fun recentPagesBoundedAndRestoreCorrectEntry() {
        val pages = ClosedPages()
        repeat(15) { pages.push(ClosedPage("https://example.com/$it", "Page $it", it % 2 == 0)) }
        pages.push(ClosedPage(UrlRules.HOME,"home")); pages.push(ClosedPage("file:///x","file"))
        assertEquals(10, pages.list().size); assertEquals("Page 14", pages.list().first().title)
        assertEquals("Page 14",pages.remove(0)?.title); assertNull(pages.remove(20))
        assertEquals("Page 13", ClosedPages(pages.list()).list().first().title)
    }
    @Test fun permissionsUseOriginAndNamesCannotEscapeDownloads() {
        assertEquals("https://example.com:8443", BrowserFeatures.origin("https://example.com:8443/a?b"))
        assertNull(BrowserFeatures.origin("javascript:x"))
        assertEquals(".._evil_file_.txt", BrowserFeatures.safeFileName("../evil/file?.txt"))
        assertEquals("download", BrowserFeatures.safeFileName(""))
    }
}
