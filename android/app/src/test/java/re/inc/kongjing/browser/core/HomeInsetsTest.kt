package re.inc.kongjing.browser.core

import org.junit.Assert.*
import org.junit.Test

class HomeInsetsTest {
    @Test fun suppliesZeroEnvFallbackWithoutReplacingUnrelatedEnv() {
        val css = HomeInsets.adaptCss("padding:env(safe-area-inset-top) env(safe-area-inset-right);height:env(keyboard-inset-height);")
        assertTrue(css.contains("max(env(safe-area-inset-top), var(--kj-inset-top, 0px))"))
        assertTrue(css.contains("max(env(safe-area-inset-right), var(--kj-inset-right, 0px))"))
        assertTrue(css.contains("env(keyboard-inset-height)"))
    }
    @Test fun initialInsetsPrecedeHomepageScriptsAndAvoidDoubleBottomInset() {
        val html = HomeInsets(24f, 10f, 0f).html("<html><head><script src='home.js'></script></head></html>")
        assertTrue(html.indexOf("--kj-inset-top:24.0px") < html.indexOf("<script"))
        assertTrue(html.contains("--kj-inset-left:10.0px"))
        assertTrue(html.contains("--kj-inset-bottom:0px"))
        assertTrue(html.contains("--kj-toolbar-height:56.0px"))
    }
    @Test fun unsignedHostnameHueMatchesHomepageAndCountNeverOverflows() {
        assertEquals(157f, SiteVisuals.hue("example.com"))
        assertEquals(94f, SiteVisuals.hue("github.com"))
        assertEquals("1", SiteVisuals.tabCount(1))
        assertEquals("12", SiteVisuals.tabCount(12))
        assertEquals("99", SiteVisuals.tabCount(99))
        assertEquals("99+", SiteVisuals.tabCount(100))
        assertEquals("99+", SiteVisuals.tabCount(1000))
    }
}
