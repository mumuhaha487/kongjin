package re.inc.kongjing.browser.core

import org.junit.Assert.*
import org.junit.Test

class MobileUiPolicyTest {
    @Test fun searchEngineBrandTracksTemplateAndRejectsLookalikeHosts() {
        for ((url, key) in listOf("https://www.bing.com/search?q=%s" to "bing", "https://www.baidu.com/s?wd=%s" to "baidu", "https://google.co.uk/search?q=%s" to "google", "https://duckduckgo.com/?q=%s" to "duckduckgo"))
            assertEquals(key, MobileUiPolicy.searchIcon(url).key)
        assertEquals("custom", MobileUiPolicy.searchIcon("https://bing.com.evil.test/?q=%s").key)
        assertEquals("E", MobileUiPolicy.searchIcon("https://example.org/?q=%s").letter)
    }
    @Test fun menuKeepsElevenSpUnlessThatLabelExceedsItsCell() {
        assertEquals(11, MobileUiPolicy.menuLabelSp(63f,64f))
        assertEquals(11, MobileUiPolicy.menuLabelSp(64f,64f))
        assertEquals(10, MobileUiPolicy.menuLabelSp(65f,64f))
    }
    @Test fun accumulatesSmallScrollsInDp() {
        val p = ToolbarScrollPolicy()
        for (i in 1..6) assertNull(p.update(i * 4f, (i - 1) * 4f, false, false))
        assertEquals(true, p.update(25f, 24f, false, false))
    }
    @Test fun upwardScrollImmediatelyShowsAndResetsThreshold() {
        val p = ToolbarScrollPolicy()
        assertEquals(true, p.update(100f, 0f, false, false))
        assertEquals(false, p.update(99f, 100f, false, false))
        assertNull(p.update(109f, 99f, false, false))
    }
    @Test fun topHomeAndPanelsAlwaysShowToolbar() {
        for ((home, panel, y) in listOf(Triple(true, false, 100f), Triple(false, true, 100f), Triple(false, false, 0f)))
            assertEquals(false, ToolbarScrollPolicy().update(y, 0f, home, panel))
    }
    @Test fun domainKeepsMeaningfulSubdomainAndRemovesOnlyWww() {
        assertEquals("m.example.com", MobileUiPolicy.domain("https://m.example.com/a?q=1"))
        assertEquals("example.com", MobileUiPolicy.domain("https://www.example.com/a"))
        assertEquals("127.0.0.1", MobileUiPolicy.domain("http://127.0.0.1:8765/a"))
    }
    @Test fun subtitlePreservesPathAndQuery() { assertEquals("example.com/a?q=1", MobileUiPolicy.subtitle("https://www.example.com/a?q=1#section")) }
    @Test fun landscapeUsesThreeColumns() {
        assertEquals(3, MobileUiPolicy.tabColumns(800, 450))
        assertEquals(2, MobileUiPolicy.tabColumns(360, 640))
    }
    @Test fun searchesAreTrimmedDeduplicatedAndBounded() {
        assertEquals(listOf("B", "a", "c", "d", "e"), MobileUiPolicy.recentSearches(listOf("a", "b", "c", "d", "e"), " B "))
        assertEquals(listOf("a"), MobileUiPolicy.recentSearches(listOf("a"), " "))
    }
    @Test fun tabIdsSurviveViewEvictionButAreNotReusedAfterRemoval() {
        val ids = ExtensionTabIds(); val first = ids.id("uuid-a")
        assertEquals(first, ids.id("uuid-a")); assertEquals("uuid-a", ids.native(first))
        assertEquals(first, ids.remove("uuid-a")); assertNull(ids.native(first))
        assertTrue(ids.id("uuid-a") > first); assertTrue(ids.id("uuid-b") > first)
    }
    @Test fun tabQueriesEscapeRegexAndMatchWildcards() {
        assertTrue(MobileUiPolicy.matches("https://*.example.com/*", "https://m.example.com/a"))
        assertFalse(MobileUiPolicy.matches("https://example.com/*", "https://exampleXcom/a"))
        assertFalse(MobileUiPolicy.matches("https://example.com/*", "https://evil.test/"))
    }
}
