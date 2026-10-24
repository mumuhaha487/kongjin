package re.inc.kongjing.browser.core

import org.junit.Assert.*
import org.junit.Test

class PageSecurityTest {
    @Test fun onlyCompletedHttpsWithCertificateIsSecure() {
        val url = "https://example.com/"
        assertTrue(PageSecurity.confirmed(url, url, url, true, false))
        assertFalse(PageSecurity.confirmed(url, url, url, false, false))
        assertFalse(PageSecurity.confirmed(url, url, url, true, true))
        assertFalse(PageSecurity.confirmed(url, null, url, true, false))
    }

    @Test fun httpAndErrorsNeverInheritPreviousTlsCertificate() {
        for (url in listOf("http://127.0.0.1:8765/", "http://example.com/", "about:blank")) {
            assertFalse(PageSecurity.confirmed(url, url, url, true, false))
            assertFalse(PageSecurity.confirmed(url, url, url, true, true))
        }
    }

    @Test fun oldCompletionCannotConfirmNewNavigation() {
        val old = "https://example.com/old"
        val next = "https://example.com/next"
        assertFalse(PageSecurity.confirmed(next, old, next, true, false))
        assertFalse(PageSecurity.confirmed(next, next, old, true, false))
    }
}
