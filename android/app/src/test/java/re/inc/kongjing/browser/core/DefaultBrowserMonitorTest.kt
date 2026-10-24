package re.inc.kongjing.browser.core

import org.junit.Assert.assertEquals
import org.junit.Test

class DefaultBrowserMonitorTest {
    private class Fixture {
        var default = false
        val notifications = mutableListOf<Boolean>()
        val monitor = DefaultBrowserMonitor({ default }, { notifications += default })
    }
    @Test fun ordinaryResumesOnlyPublishChangedStatusIncludingExternalChanges() {
        val f = Fixture(); f.monitor.homeReady(); repeat(3) { f.monitor.resumed() }
        f.default = true; f.monitor.resumed(); f.monitor.resumed()
        f.default = false; f.monitor.resumed()
        assertEquals(listOf(false, true, false), f.notifications)
    }
    @Test fun settingsReturnPublishesEvenWhenCancelled() {
        for (granted in listOf(false, true)) {
            val f = Fixture(); f.monitor.homeReady()
            f.monitor.begin(DefaultBrowserMonitor.Flow.SETTINGS); f.default = granted
            f.monitor.resumed(); f.monitor.resumed()
            assertEquals(listOf(false, granted), f.notifications)
        }
    }
    @Test fun roleResultPublishesForGrantAndCancellationInEitherCallbackOrder() {
        for (granted in listOf(false, true)) for (resultFirst in listOf(false, true)) {
            val f = Fixture(); f.monitor.homeReady(); f.monitor.begin(DefaultBrowserMonitor.Flow.ROLE)
            f.default = granted
            if (resultFirst) { f.monitor.roleResult(); f.monitor.resumed() }
            else { f.monitor.resumed(); f.monitor.roleResult() }
            assertEquals(listOf(false, granted), f.notifications)
        }
    }
    @Test fun settingsReturnBeforeHomeReadyIsDeliveredWhenReady() {
        val f = Fixture(); f.monitor.begin(DefaultBrowserMonitor.Flow.SETTINGS)
        f.default = true; f.monitor.resumed()
        assertEquals(emptyList<Boolean>(), f.notifications)
        f.monitor.homeReady(); f.monitor.resumed()
        assertEquals(listOf(true), f.notifications)
    }
    @Test fun reloadAndPreferenceEventsCannotLoseCurrentDefaultStatus() {
        val f = Fixture(); f.monitor.homeReady(); f.monitor.homeReset()
        f.default = true; f.monitor.changed(); f.monitor.resumed()
        assertEquals(listOf(false), f.notifications)
        f.monitor.homeReady(); f.monitor.changed(); f.monitor.resumed()
        assertEquals(listOf(false, true, true), f.notifications)
    }
    @Test fun failedLaunchDoesNotForcePhantomSettingsReturn() {
        val f = Fixture(); f.monitor.homeReady(); f.monitor.begin(DefaultBrowserMonitor.Flow.SETTINGS)
        f.monitor.launchFailed(); f.monitor.resumed()
        assertEquals(listOf(false), f.notifications)
    }
}
