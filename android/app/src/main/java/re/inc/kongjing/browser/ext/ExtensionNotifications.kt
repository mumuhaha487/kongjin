package re.inc.kongjing.browser.ext

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.ext.core.InstalledExtension
import re.inc.kongjing.browser.ext.core.SafeZip

/** Receiver registration is documented in EXT-API.md; notification clicks survive process death. */
class ExtensionNotificationReceiver: BroadcastReceiver() {
    override fun onReceive(context:Context,intent:Intent) {
        val id=intent.getStringExtra("extensionId") ?: return
        if(!Regex("[a-p]{32}").matches(id))return
        val event=JSONObject().put("extensionId",id).put("notificationId",intent.getStringExtra("notificationId"))
            .put("closed",intent.action?.endsWith(".CLOSED")==true)
        context.getSharedPreferences("extension-events",Context.MODE_PRIVATE).edit().putString("pending",event.toString()).apply()
        if(!event.getBoolean("closed"))context.packageManager.getLaunchIntentForPackage(context.packageName)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)?.let(context::startActivity)
    }
}

class ExtensionNotifications(private val context:Context,private val emit:(String,String,JSONArray)->Unit) {
    private val manager=NotificationManagerCompat.from(context)
    private val records=mutableMapOf<String,MutableMap<String,JSONObject>>()
    init { context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("extensions","扩展通知",NotificationManager.IMPORTANCE_DEFAULT)) }
    fun call(e:InstalledExtension,method:String,args:JSONArray):Any? {
        val items=records.getOrPut(e.id){mutableMapOf()}
        val explicit=args.opt(0) is String
        val id=if(explicit)args.getString(0) else java.util.UUID.randomUUID().toString()
        return when(method) {
            "getAll" -> JSONObject(items.keys.associateWith {true})
            "clear" -> {manager.cancel(e.id+":"+id,1);items.remove(id)!=null}
            "create","update" -> {
                if(method=="update" && id !in items)return false
                val options=args.getJSONObject(if(explicit)1 else 0)
                val value=JSONObject(items[id]?.toString() ?: "{}");options.keys().forEach {value.put(it,options.get(it))}
                require(value.optString("type","basic") in setOf("basic","image"))
                if(Build.VERSION.SDK_INT>=33)require(ContextCompat.checkSelfPermission(context,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED) {"请先允许空境发送系统通知"}
                fun intent(closed:Boolean):PendingIntent {
                    val i=Intent(context,ExtensionNotificationReceiver::class.java).setAction(context.packageName+if(closed)".ext.CLOSED" else ".ext.CLICKED")
                        .putExtra("extensionId",e.id).putExtra("notificationId",id)
                        .setData(android.net.Uri.parse("kongjing-ext://${e.id}/${android.net.Uri.encode(id)}/${if(closed)"closed" else "click"}"))
                    return PendingIntent.getBroadcast(context,0,i,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                }
                val builder=NotificationCompat.Builder(context,"extensions").setSmallIcon(context.applicationInfo.icon).setContentTitle(value.optString("title",e.manifest.name))
                    .setContentText(value.optString("message")).setStyle(NotificationCompat.BigTextStyle().bigText(value.optString("message")))
                    .setContentIntent(intent(false)).setDeleteIntent(intent(true)).setAutoCancel(true)
                fun bitmap(raw:String):android.graphics.Bitmap? = runCatching {
                    val bytes=if(raw.startsWith("data:image/")) android.util.Base64.decode(raw.substringAfter(','),android.util.Base64.DEFAULT) else {
                        val path=if(raw.startsWith(e.manifest.url()))raw.removePrefix(e.manifest.url()) else raw
                        require(!path.contains("://"));val file=SafeZip.path(e.root,path.trimStart('/'));require(file.length()<=10*1024*1024);file.readBytes()
                    }
                    require(bytes.size<=10*1024*1024)
                    val bounds=android.graphics.BitmapFactory.Options().apply {inJustDecodeBounds=true};android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
                    require(bounds.outWidth in 1..4096 && bounds.outHeight in 1..4096)
                    android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size)
                }.getOrNull()
                bitmap(value.optString("iconUrl"))?.let {builder.setLargeIcon(it)}
                if(value.optString("type")=="image") bitmap(value.optString("imageUrl"))?.let {builder.setStyle(NotificationCompat.BigPictureStyle().bigPicture(it))}
                manager.notify(e.id+":"+id,1,builder.build());items[id]=value
                if(method=="create")id else true
            }
            else -> error("不支持 notifications.$method")
        }
    }
    fun drain() {
        val prefs=context.getSharedPreferences("extension-events",Context.MODE_PRIVATE)
        val data=prefs.getString("pending",null) ?: return
        prefs.edit().remove("pending").apply()
        runCatching {val j=JSONObject(data);val extension=j.getString("extensionId");val notification=j.getString("notificationId");records[extension]?.remove(notification);val args=JSONArray().put(notification);if(j.getBoolean("closed"))args.put(true);emit(extension,if(j.getBoolean("closed"))"notifications.onClosed" else "notifications.onClicked",args)}
    }
    fun remove(id:String) { records.remove(id)?.keys?.forEach { manager.cancel("$id:$it",1) } }
    fun destroy() = Unit
}
