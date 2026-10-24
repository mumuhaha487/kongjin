package re.inc.kongjing.browser.core

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ContinuityPublisherTest {
    private class Harness(initial: List<Visit> = emptyList()) {
        data class Job(val at: Long, val run: () -> Unit)
        data class Call(val method: String, val args: JSONObject, val done: (Result<Any>) -> Unit)
        var now = 0L
        val jobs = mutableListOf<Job>()
        val calls = mutableListOf<Call>()
        var saved = initial
        val publisher = ContinuityPublisher({ method, args, done -> calls += Call(method, args, done) },
            { delay, run -> val job = Job(now + delay, run); jobs += job; { jobs.remove(job); Unit } }, initial, { saved = it })
        fun advance(ms: Long) {
            val target = now + ms
            while (true) {
                val job = jobs.minByOrNull { it.at }?.takeIf { it.at <= target } ?: break
                jobs.remove(job); now = job.at; job.run()
            }
            now = target
        }
    }
    private fun visit(i: Int = 1) = Visit("https://example.com/$i", "页面 $i", i.toLong())
    @Test fun lateTitleSurvivesAnInFlightOriginalVisitWithoutChangingAt() {
        val h = Harness(); h.publisher.markReady()
        val first = Visit("https://example.com/late", "", 1234)
        h.publisher.record(first); h.advance(2000)
        val update = first.copy(ti = "迟到标题")
        h.publisher.record(update); h.advance(2000)
        h.calls[0].done(Result.success(JSONObject())); h.advance(0)
        assertEquals(2, h.calls.size)
        val sent = h.calls[1].args.getJSONArray("visits").getJSONObject(0)
        assertEquals(first.u, sent.getString("u"))
        assertEquals(first.at, sent.getLong("at"))
        assertEquals(update.ti, sent.getString("ti"))
        h.calls[1].done(Result.success(JSONObject())); assertTrue(h.saved.isEmpty())
    }
    @Test fun outboxSurvivesSlowReadyAndDebouncesTwoSecondsAfterLastVisit() {
        val h = Harness(); h.publisher.record(visit()); h.advance(1999); h.publisher.record(visit(2))
        h.advance(10000); assertTrue(h.calls.isEmpty()); assertEquals(2, h.saved.size)
        h.publisher.markReady(); assertEquals(2, h.calls.single().args.getJSONArray("visits").length())
        h.calls.single().done(Result.success(JSONObject())); assertTrue(h.saved.isEmpty())
        val ready = Harness(); ready.publisher.markReady(); ready.publisher.record(visit()); ready.advance(1999)
        assertTrue(ready.calls.isEmpty()); ready.advance(1); assertEquals("recordVisits", ready.calls.single().method)
    }
    @Test fun batchesAreAtMostFiftyAndNoLossWhileFirstBatchIsInFlight() {
        val h = Harness(); (1..121).forEach { h.publisher.record(visit(it)) }; h.advance(2000); h.publisher.markReady()
        assertEquals(50, h.calls[0].args.getJSONArray("visits").length())
        h.publisher.record(visit(122)); h.advance(2000)
        h.calls[0].done(Result.success(JSONObject())); h.advance(0)
        assertEquals(50, h.calls[1].args.getJSONArray("visits").length())
        h.calls[1].done(Result.success(JSONObject())); h.advance(0)
        assertEquals(22, h.calls[2].args.getJSONArray("visits").length())
        h.calls[2].done(Result.success(JSONObject())); h.advance(0)
        assertEquals(3, h.calls.size); assertTrue(h.saved.isEmpty())
    }
    @Test fun errorsRetainDurableOutboxAndReloadRetriesWithoutSpinning() {
        val h = Harness(listOf(visit())); h.publisher.markReady()
        h.calls[0].done(Result.failure(IllegalStateException("timeout"))); h.advance(20000)
        assertEquals(1, h.calls.size); assertEquals(listOf(visit()), h.saved)
        h.publisher.resetReady(); h.publisher.markReady(); assertEquals(2, h.calls.size)
        h.publisher.clearVisits(); h.calls[1].done(Result.success(JSONObject())); h.advance(0)
        assertTrue(h.saved.isEmpty())
    }
    @Test fun nativeExcludesIncognitoAndNonWebButLeavesPrivacyFilteringToHome() {
        val h = Harness(); h.publisher.markReady()
        listOf(Visit("https://private.example/", "秘密", 1, true), Visit("file:///x", "file", 1),
            Visit("https://appassets.androidplatform.net/home/", "主页", 1)).forEach(h.publisher::record)
        val raw = Visit("http://192.168.1.2/?token=raw#fragment", "原始记录", 1)
        h.publisher.record(raw); h.advance(2000)
        assertEquals(raw.u, h.calls.single().args.getJSONArray("visits").getJSONObject(0).getString("u"))
        assertEquals(1, h.calls.single().args.getJSONArray("visits").length())
    }
    @Test fun tabsDebounceThreeSecondsQueueUntilReadyAndPreserveLastWebFocus() {
        val h = Harness()
        h.publisher.tabsChanged(listOf(OpenTab("https://a.example/", "A", true)), Visit("https://a.example/", "A", 1))
        h.advance(2999); h.publisher.markReady(); assertTrue(h.calls.isEmpty())
        h.publisher.tabsChanged(listOf(OpenTab("https://a.example/", "A", false), OpenTab("https://b.example/", "B", true)), Visit("https://b.example/", "B", 2))
        h.advance(2999); assertTrue(h.calls.isEmpty()); h.advance(1)
        val args = h.calls.single().args; assertEquals("setOpenTabs", h.calls.single().method)
        assertEquals("https://b.example/", args.getJSONObject("last").getString("u"))
        assertTrue(args.getJSONArray("tabs").getJSONObject(1).getBoolean("active"))
    }
    @Test fun tabSnapshotsExcludePrivateTabsCapAt200AndIncludeFocusedTail() {
        val h = Harness(); val tabs = (1..205).map { OpenTab("https://example.com/$it", "$it", it == 205) } +
            listOf(OpenTab("https://secret.example/", "secret", false, true), OpenTab("about:blank", "blank", false))
        h.publisher.tabsChanged(tabs, visit(205)); h.advance(5000); h.publisher.markReady()
        val args = h.calls.single().args; val array = args.getJSONArray("tabs")
        assertEquals(200, array.length()); assertEquals("https://example.com/205", array.getJSONObject(199).getString("u"))
        assertEquals(205, args.getJSONObject("last").getLong("at"))
        h.publisher.tabsChanged(emptyList(), null); h.advance(3000)
        assertEquals(0, h.calls.last().args.getJSONArray("tabs").length()); assertEquals("", h.calls.last().args.getJSONObject("last").getString("u"))
    }
    @Test fun unchangedTabsDoNotKeepResettingDebounceAndFailureIsRetriedOnReady() {
        val h = Harness(); val tabs = listOf(OpenTab("https://a.example/", "A", true))
        h.publisher.markReady(); h.publisher.tabsChanged(tabs, null); h.advance(2999)
        h.publisher.tabsChanged(tabs, null); h.advance(1); assertEquals(1, h.calls.size)
        h.calls[0].done(Result.failure(Exception())); h.publisher.resetReady(); h.publisher.markReady(); assertEquals(2, h.calls.size)
    }
    @Test fun focusedWebpageBeyondCapIsKeptWhenHomepageIsCurrentlyActive() {
        val h = Harness(); h.publisher.tabsChanged((1..205).map { OpenTab("https://example.com/$it", "$it", false) }, visit(205))
        h.advance(3000); h.publisher.markReady()
        val args = h.calls.single().args
        assertEquals("https://example.com/205", args.getJSONArray("tabs").getJSONObject(199).getString("u"))
        assertEquals("https://example.com/205", args.getJSONObject("last").getString("u"))
    }
}
