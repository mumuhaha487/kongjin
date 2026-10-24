package re.inc.kongjing.browser.core

import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class AddressSuggestionsTest {
    private class Clock {
        private data class Job(val at: Long, val block: () -> Unit)
        private var now = 0L
        private val jobs = mutableListOf<Job>()
        fun schedule(delay: Long, block: () -> Unit): () -> Unit {
            val job = Job(now + delay, block)
            jobs += job
            return { jobs.remove(job); Unit }
        }
        fun advance(milliseconds: Long) {
            val until = now + milliseconds
            while (true) {
                val job = jobs.minByOrNull { it.at }?.takeIf { it.at <= until } ?: break
                jobs.remove(job); now = job.at; job.block()
            }
            now = until
        }
    }
    private class Harness(ready: Boolean = true) {
        val clock = Clock()
        val sent = mutableListOf<String>()
        val history = mutableListOf<Pair<String, (List<Suggestion>) -> Unit>>()
        val bridge = BridgeDispatcher({ sent += it }, clock::schedule).apply { if (ready) markReady() }
        val suggestions = AddressSuggestions(bridge, { query, callback -> history += query to callback }, clock::schedule)
        var displayed = emptyList<Suggestion>()
        fun query(value: String = "空境"): () -> Unit = suggestions.query(value) { displayed = it }
        fun reply(json: String, id: String = "native-1") = bridge.reply(id, json)
    }
    private val visited = Suggestion("https://history.example/", "本地历史")
    private val success = """{"ok":true,"data":[{"url":"https://bookmark.example/","title":"空境书签"}]}"""

    @Test fun bookmarksKeepHomeRankingAndReplaceDuplicateHistory() {
        val bookmarks = listOf(Suggestion("HTTPS://EXAMPLE.COM:443#bookmark", "最新书签名"), Suggestion("https://second.example/", "第二名"))
        val history = listOf(Suggestion("https://example.com/", "旧历史名"), visited)
        val result = AddressSuggestions.merge(bookmarks, history)
        assertEquals(listOf("最新书签名", "第二名", "本地历史"), result.map { it.title })
        assertEquals(listOf(true, true, false), result.map { it.bookmark })
    }
    @Test fun deduplicationKeepsDifferentPathsAndQueriesAndCapsAtSix() {
        val bookmarks = listOf("https://a.example/x/../Path#one", "https://a.example/Path#two", "https://a.example/path", "https://a.example/path?a=1", "https://a.example/path?a=2")
            .map { Suggestion(it, it) }
        val result = AddressSuggestions.merge(bookmarks, (1..6).map { Suggestion("https://h.example/$it", "$it") })
        assertEquals(6, result.size)
        assertEquals(4, result.count { it.bookmark })
    }
    @Test fun malformedBookmarkDataAndUnsafeUrlsAreIgnored() {
        val data = JSONArray("""[null,42,{}, {"url":"javascript:alert(1)","title":"bad"},
            {"url":"https://appassets.androidplatform.net/home/","title":"private"},
            {"url":"https://a.example/","title":42},
            {"url":"https://b.example/","title":"","iconDataUrl":"data:image/png;base64,ignored"}]""")
        assertEquals(listOf(Suggestion("https://b.example/", "b.example", true)), AddressSuggestions.decodeBookmarks(data))
        assertTrue(AddressSuggestions.decodeBookmarks("invalid").isEmpty())
    }
    @Test fun debounceWaits120msAndEncodesQueryAndLimit() {
        val h = Harness()
        h.query("空境\"\n'")
        h.clock.advance(119)
        assertTrue(h.sent.isEmpty()); assertTrue(h.history.isEmpty())
        h.clock.advance(1)
        assertEquals(2, h.sent.size)
        assertTrue(h.sent[1].contains("searchHistory"))
        val call = JSONArray("[" + h.sent.first().removePrefix("window.kongjing.call(").removeSuffix(")") + "]")
        assertEquals("searchBookmarks", call.getString(1))
        val args = org.json.JSONObject(call.getString(2))
        assertEquals("空境\"\n'", args.getString("query")); assertEquals(6, args.getInt("limit"))
    }
    @Test fun historyIsPublishedBeforeBookmarkReplyThenMerged() {
        val h = Harness(); h.query(); h.clock.advance(120)
        h.history.single().second(listOf(visited))
        assertEquals(listOf(visited), h.displayed)
        h.reply(success)
        assertEquals(listOf("空境书签", "本地历史"), h.displayed.map { it.title })
        h.clock.advance(5000)
        assertEquals(2, h.displayed.size) // Successful reply cancelled its timeout.
    }
    @Test fun bookmarksCanArriveBeforeHistory() {
        val h = Harness(); h.query(); h.clock.advance(120); h.reply(success)
        assertEquals(1, h.displayed.size)
        h.history.single().second(listOf(visited))
        assertEquals(listOf(true, false), h.displayed.map { it.bookmark })
    }
    @Test fun unknownMethodErrorMalformedReplyAndReloadRetainOnlyHistory() {
        for (reply in listOf("""{"ok":false,"error":"UNKNOWN_METHOD"}""", "broken", """{"ok":true,"data":{}}""")) {
            val h = Harness(); h.query(); h.clock.advance(120)
            h.history.single().second(listOf(visited)); h.reply(reply)
            assertEquals(listOf(visited), h.displayed)
        }
        val h = Harness(); h.query(); h.clock.advance(120)
        h.history.single().second(listOf(visited)); h.bridge.reset()
        assertEquals(listOf(visited), h.displayed)
    }
    @Test fun fiveSecondTimeoutStartsAfterDebounceAndLateReplyCannotReplaceHistory() {
        val h = Harness(); h.query(); h.clock.advance(120)
        h.history.single().second(listOf(visited)); h.clock.advance(4999)
        assertEquals(listOf(visited), h.displayed)
        h.clock.advance(1); h.reply(success)
        assertEquals(listOf(visited), h.displayed)
    }
    @Test fun queuedSearchAlsoExpiresBeforeHomeReady() {
        val h = Harness(ready = false); h.query(); h.clock.advance(120)
        h.history.single().second(listOf(visited)); h.clock.advance(5000); h.bridge.markReady()
        assertTrue(h.sent.isEmpty()); assertEquals(listOf(visited), h.displayed)
    }
    @Test fun rapidTypingCancelsDebounceAndClosingCancelsQueuedBridge() {
        val h = Harness(ready = false)
        val first = h.query("first"); h.clock.advance(60); first()
        val second = h.query("second"); h.clock.advance(119)
        assertTrue(h.history.isEmpty()); h.clock.advance(1)
        assertEquals("second", h.history.single().first)
        second(); h.bridge.markReady(); h.clock.advance(5000)
        h.history.single().second(listOf(visited)); h.reply(success)
        assertTrue(h.sent.isEmpty()); assertTrue(h.displayed.isEmpty())
    }
    @Test fun reopeningSameTextRejectsOldHistoryAndBridgeReplies() {
        val h = Harness(); val close = h.query("same"); h.clock.advance(120); close()
        h.query("same"); h.clock.advance(120)
        h.history.first().second(listOf(visited)); h.reply(success)
        assertTrue(h.displayed.isEmpty())
        h.history.last().second(listOf(visited)); h.reply(success, "native-3")
        assertEquals(2, h.displayed.size)
    }
    @Test fun remoteHistoryHasLowestPriorityAndDeviceLabelOnlyOnRemoteRows() {
        val result = AddressSuggestions.merge(listOf(Suggestion("https://b.example/", "书签", deviceName = "discard")),
            listOf(Suggestion("https://b.example/#local", "重复书签"), Suggestion("https://l.example/", "本地", deviceName = "discard")),
            listOf(Suggestion("https://l.example/#remote", "重复本地", deviceName = "电脑"),
                Suggestion("https://r.example/", "远端", deviceName = "MacBook")))
        assertEquals(listOf("书签", "本地", "远端"), result.map { it.title })
        assertEquals(listOf(null, null, "MacBook"), result.map { it.deviceName })
    }
    @Test fun malformedRemoteHistoryAndUnsafeUrlsAreIgnored() {
        val data = JSONArray("""[null, {}, {"u":"javascript:alert(1)","ti":"x","devName":"电脑"},
            {"u":"https://appassets.androidplatform.net/home/","ti":"x","devName":"电脑"},
            {"u":"https://x.example/","ti":4,"devName":"电脑"},
            {"u":"https://x.example/","ti":"x","devName":""},
            {"u":"https://r.example/","ti":"","devName":"电脑","dev":"id","at":1}]""")
        assertEquals(listOf(Suggestion("https://r.example/", "r.example", deviceName = "电脑")), AddressSuggestions.decodeHistory(data))
    }
    @Test fun sourcesFailIndependentlyAndRemoteLateReplyIsIgnored() {
        val remote = """{"ok":true,"data":[{"u":"https://r.example/","ti":"远端","devName":"电脑"}]}"""
        val h = Harness(); h.query(); h.clock.advance(120); h.history.single().second(listOf(visited))
        h.reply(remote, "native-2"); h.reply("""{"ok":false,"error":"no bookmarks"}""")
        assertEquals(listOf("本地历史", "远端"), h.displayed.map { it.title })
        val second = Harness(); second.query(); second.clock.advance(120); second.reply(success)
        second.history.single().second(listOf(visited)); second.clock.advance(5000); second.reply(remote, "native-2")
        assertEquals(listOf("空境书签", "本地历史"), second.displayed.map { it.title })
    }
}
