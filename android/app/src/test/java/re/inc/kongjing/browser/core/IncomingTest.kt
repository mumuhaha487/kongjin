package re.inc.kongjing.browser.core

import org.junit.Assert.*
import org.junit.Test

class IncomingTest {
    @Test fun roundTripUrlAndTextItems() {
        val item = IncomingItem("record-1", "mac", "https://example.com/", "标题", at = 123)
        assertEquals(item, IncomingItem.decode(item.json().toString()))
        val text = IncomingItem("record-2", "mac", null, "文字", "内容", 124)
        assertEquals(text, IncomingItem.decode(text.json().toString()))
    }
    @Test fun unsafeMalformedAndOversizedItemsCannotReachBannerOrNotification() {
        for (u in listOf("javascript:alert(1)", "file:///x", "intent://x", "https://appassets.androidplatform.net/home/"))
            assertNull(IncomingItem.decode(IncomingItem("i", "d", u, "bad").json().toString()))
        assertNull(IncomingItem.decode("{}")); assertNull(IncomingItem.decode("broken"))
        assertNull(IncomingItem.decode(IncomingItem("i", "d", null, "no payload").json().toString()))
        assertNull(IncomingItem.decode(IncomingItem("x".repeat(201), "d", "https://example.com/", "bad").json().toString()))
    }
    @Test fun notificationClickRoutesOnlyKnownPersistedIdAndCorrectAction() {
        val persisted = IncomingItem("good", "mac", "https://example.com/page", "页面")
        val lookup = { id: String -> if (id == "good") persisted else null }
        assertEquals(persisted, IncomingRoute.resolve(IncomingRoute.ACTION, "good", lookup))
        assertNull(IncomingRoute.resolve("android.intent.action.VIEW", "good", lookup))
        assertNull(IncomingRoute.resolve(IncomingRoute.ACTION, "unknown", lookup))
        assertNull(IncomingRoute.resolve(IncomingRoute.ACTION, null, lookup))
        assertNull(IncomingRoute.resolve(IncomingRoute.ACTION, "good") { persisted.copy(id = "other") })
        assertNull(IncomingRoute.resolve(IncomingRoute.ACTION, "good") { persisted.copy(u = "javascript:alert(1)") })
    }
}
