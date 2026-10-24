package re.inc.kongjing.browser.core

import org.junit.Assert.*
import org.junit.Test

class VisitTitleTrackerTest {
    private val url = "https://example.com/article"

    @Test fun emptyTitleIsReissuedWithTheOriginalTimestampExactlyOnce() {
        val tracker = VisitTitleTracker()
        tracker.started(url)
        val first = tracker.finished(url, 1234)!!
        assertEquals("", first.ti)
        val update = tracker.receivedTitle(url, "真实标题")!!
        assertEquals(first.copy(ti = "真实标题"), update)
        assertNull(tracker.receivedTitle(url, "真实标题"))
        assertNull(tracker.receivedTitle(url, "再次变化"))
        assertNull(tracker.finished(url, 9999))
    }

    @Test fun urlPlaceholdersAndBlankCallbacksKeepWaitingForRealTitle() {
        val tracker = VisitTitleTracker()
        tracker.started(url)
        assertNull(tracker.receivedTitle(url, url))
        val first = tracker.finished(url, 42)!!
        for (title in listOf(null, " ", url, "$url/", "example.com/article"))
            assertNull(tracker.receivedTitle(url, title))
        assertEquals(first.copy(ti = "文章"), tracker.receivedTitle(url, " 文章 "))
    }

    @Test fun realTitleBeforeFinishNeedsOnlyOneVisit() {
        val tracker = VisitTitleTracker()
        tracker.started(url)
        assertNull(tracker.receivedTitle(url, "已就绪的标题"))
        assertEquals(Visit(url, "已就绪的标题", 7), tracker.finished(url, 7))
        assertNull(tracker.receivedTitle(url, "动态标题"))
    }

    @Test fun nextNavigationDiscardsPendingVisitAndStaleCallbacks() {
        val tracker = VisitTitleTracker()
        tracker.started(url)
        tracker.finished(url, 1)
        val next = "https://other.example/next"
        tracker.started(next)
        assertNull(tracker.receivedTitle(url, "旧页标题"))
        assertNull(tracker.finished(url, 2))
        assertEquals(Visit(next, "", 3), tracker.finished(next, 3))
        assertEquals(Visit(next, "新页标题", 3), tracker.receivedTitle(next, "新页标题"))
    }

    @Test fun sameUrlReloadGetsANewTimestampAndNoPreviousTitle() {
        val tracker = VisitTitleTracker()
        tracker.started(url)
        tracker.receivedTitle(url, "原页面")
        tracker.finished(url, 100)
        tracker.started(url)
        assertEquals(Visit(url, "", 200), tracker.finished(url, 200))
        assertEquals(Visit(url, "重新加载", 200), tracker.receivedTitle(url, "重新加载"))
    }

    @Test fun clearPreventsLateCallbacksFromRestoringHistory() {
        val tracker = VisitTitleTracker()
        tracker.started(url)
        tracker.finished(url, 1)
        tracker.clear()
        assertNull(tracker.receivedTitle(url, "不应恢复"))
        assertNull(tracker.finished(url, 2))
    }

    @Test fun privateAndNonWebNavigationsNeverCreateVisits() {
        val tracker = VisitTitleTracker()
        tracker.started(url, true)
        assertNull(tracker.finished(url, 1))
        assertNull(tracker.receivedTitle(url, "私密"))
        for (excluded in listOf("file:///private", UrlRules.HOME, "about:blank")) {
            tracker.started(excluded)
            assertNull(tracker.finished(excluded, 1))
            assertNull(tracker.receivedTitle(excluded, "不记录"))
        }
    }
}
