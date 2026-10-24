package re.inc.kongjing.browser

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import re.inc.kongjing.browser.core.IncomingItem
import re.inc.kongjing.browser.core.IncomingRoute
import re.inc.kongjing.browser.core.UrlRules

class IncomingNotifications(private val context: Context) {
    init {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "收到的网页", NotificationManager.IMPORTANCE_DEFAULT))
    }
    fun show(item: IncomingItem, from: String) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val intent = Intent(context, MainActivity::class.java).apply {
            action = IncomingRoute.ACTION
            data = Uri.Builder().scheme("kongjing-incoming").authority("open").appendPath(item.id).build()
            putExtra(IncomingRoute.EXTRA_ID, item.id)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.logo_monochrome)
            .setContentTitle("来自 $from").setContentText(item.ti + (item.u?.let { " · ${UrlRules.host(it)}" } ?: ""))
            .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true).build()
        // String tags avoid hashCode collisions between messages.
        NotificationManagerCompat.from(context).notify(item.id, 1, notification)
    }
    fun cancel(id: String) = NotificationManagerCompat.from(context).cancel(id, 1)
    companion object { const val CHANNEL = "incoming_webpages" }
}
