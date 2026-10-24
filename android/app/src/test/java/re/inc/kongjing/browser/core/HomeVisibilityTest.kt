package re.inc.kongjing.browser.core

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class HomeVisibilityTest {
    @Test fun appBackgroundAndForegroundNotifyBeforeWebViewLifecycle() {
        val calls = mutableListOf<String>()
        val state = HomeVisibility({ calls += "foreground:$it" }, { calls += "pause" }, { calls += "resume" })
        state.update(true, true, false); state.markReady(); calls.clear()
        state.update(false, true, false)
        state.update(false, true, false)
        state.update(true, true, false)
        assertEquals(listOf("foreground:false", "pause", "foreground:true", "resume"), calls)
    }
    @Test fun visibilitySignalsPrecedeLifecycleAndAreDeduplicated() {
        val calls = mutableListOf<String>()
        val state = HomeVisibility({ calls += "visible:$it" }, { calls += "pause" }, { calls += "resume" })
        state.update(true, true, false)
        state.markReady()
        state.update(true, false, false)
        state.update(true, false, false)
        state.update(true, true, false)
        state.update(true, true, true)
        state.update(false, true, false)
        assertEquals(listOf("resume", "visible:true", "visible:false", "pause", "visible:true", "resume", "visible:false", "pause"), calls)
    }

    @Test fun readyUsesLatestVisibilityAndReloadResendsIt() {
        val signals = mutableListOf<Boolean>()
        val state = HomeVisibility({ signals += it }, {}, {})
        state.update(true, true, false)
        state.update(true, false, false)
        assertTrue(signals.isEmpty())
        state.markReady(); state.markReady()
        state.resetReady(); state.update(true, true, false); state.markReady()
        assertEquals(listOf(false, true), signals)
    }

    @Test fun optionalUnsupportedSignalDoesNotGateNativeLifecycle() {
        var paused = false
        val scripts = mutableListOf<String>()
        val bridge = BridgeDispatcher({ scripts += it }, { _, _ -> {} })
        bridge.markReady()
        val state = HomeVisibility({ visible ->
            bridge.call("setVisible", JSONObject().put("visible", visible)) { /* optional transport result */ }
        }, { paused = true }, { paused = false })
        state.update(true, true, false); state.markReady()
        bridge.reply("native-1", "{\"ok\":false,\"error\":\"UNKNOWN_METHOD\"}")
        state.update(true, false, false)
        bridge.reply("native-2", "{\"ok\":false,\"error\":\"UNKNOWN_METHOD\"}")
        assertTrue(paused); assertEquals(2, scripts.size)
        state.update(true, true, false)
        assertFalse(paused)
    }

    @Test fun previewsUseOneThirdOfBothDimensionsAndRejectUnlaidOutViews() {
        assertEquals(300 to 533, TabPreviewSize.scaled(900, 1600))
        assertEquals(533 to 300, TabPreviewSize.scaled(1600, 900))
        assertEquals(1 to 1, TabPreviewSize.scaled(1, 2))
        assertNull(TabPreviewSize.scaled(0, 900)); assertNull(TabPreviewSize.scaled(900, -1))
    }
}
