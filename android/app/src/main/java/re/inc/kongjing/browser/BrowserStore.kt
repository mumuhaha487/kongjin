package re.inc.kongjing.browser

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.core.Suggestion
import re.inc.kongjing.browser.core.UrlRules
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

data class SavedTab(val id: String, val url: String, val title: String, val desktop: Boolean, val lastUsed: Long = 0)

class BrowserStore(context: Context) : SQLiteOpenHelper(context, "browser.db", null, 1) {
    val prefs = context.getSharedPreferences("browser", Context.MODE_PRIVATE)
    fun recentSearches(): List<String> = runCatching {
        val rows = JSONArray(prefs.getString("recentSearches", "[]"))
        (0 until rows.length()).map { rows.getString(it) }.take(5)
    }.getOrDefault(emptyList())
    fun rememberSearch(query: String) { prefs.edit().putString("recentSearches", JSONArray(re.inc.kongjing.browser.core.MobileUiPolicy.recentSearches(recentSearches(), query)).toString()).apply() }
    fun removeSearch(query: String) { prefs.edit().putString("recentSearches", JSONArray(recentSearches().filterNot { it == query }).toString()).apply() }
    val io = Executors.newSingleThreadExecutor()
    private val icons = File(context.filesDir, "favicons").apply { mkdirs() }
    private val previews = File(context.cacheDir, "previews").apply { mkdirs() }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE history(url TEXT PRIMARY KEY,title TEXT NOT NULL,visited INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE bookmarks(url TEXT PRIMARY KEY,title TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun visit(url: String, title: String, at: Long = System.currentTimeMillis()) = io.execute {
        if (UrlRules.webUrl(url) != null && !UrlRules.isAssetOrigin(url)) {
            writableDatabase.execSQL("INSERT OR REPLACE INTO history VALUES(?,?,?)", arrayOf<Any>(url, title, at))
            writableDatabase.execSQL("DELETE FROM history WHERE url NOT IN (SELECT url FROM history ORDER BY visited DESC LIMIT 5000)")
        }
    }
    fun updateVisitTitle(url: String, title: String, at: Long) = io.execute {
        // A newer visit from another tab must not be overwritten by an older page's late title.
        writableDatabase.execSQL("UPDATE history SET title=? WHERE url=? AND visited=?", arrayOf<Any>(title, url, at))
    }
    fun bookmark(url: String, title: String, found: Boolean) = io.execute {
        if (found) writableDatabase.execSQL("INSERT OR REPLACE INTO bookmarks VALUES(?,?)", arrayOf(url, title))
        else writableDatabase.delete("bookmarks", "url=?", arrayOf(url))
    }
    fun historySuggestions(query: String, callback: (List<Suggestion>) -> Unit) = io.execute {
        val term = "%${query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")}%"
        val sql = """SELECT url,title FROM history
            WHERE url LIKE ? ESCAPE '\' OR title LIKE ? ESCAPE '\'
            ORDER BY visited DESC LIMIT 6"""
        val items = mutableListOf<Suggestion>()
        readableDatabase.rawQuery(sql, arrayOf(term, term)).use { cursor ->
            while (cursor.moveToNext()) items += Suggestion(cursor.getString(0), cursor.getString(1))
        }
        callback(items)
    }
    fun clearHistory() = io.execute { writableDatabase.delete("history", null, null) }
    fun saveSession(tabs: List<SavedTab>, active: String) {
        val json = JSONArray()
        tabs.forEach { json.put(JSONObject().put("id", it.id).put("url", it.url).put("title", it.title).put("desktop", it.desktop).put("lastUsed", it.lastUsed)) }
        prefs.edit().putString("tabs", json.toString()).putString("active", active).apply()
    }
    fun session(): List<SavedTab> = runCatching {
        val json = JSONArray(prefs.getString("tabs", "[]"))
        (0 until json.length()).mapNotNull { i ->
            val item = json.getJSONObject(i)
            val url = item.getString("url")
            if (!UrlRules.isHome(url) && (UrlRules.webUrl(url) == null || UrlRules.isAssetOrigin(url))) null
            else SavedTab(item.getString("id"), url, item.optString("title", "空境"), item.optBoolean("desktop"), item.optLong("lastUsed", 0))
        }.distinctBy { it.id }
    }.getOrDefault(emptyList())
    private fun filename(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    fun saveIcon(url: String, bitmap: Bitmap, onSaved: (String)->Unit = {}) {
        val host = UrlRules.host(url)
        if (host.isBlank()) return
        val scaled = Bitmap.createScaledBitmap(bitmap, 64, 64, true)
        io.execute { runCatching {
            val bytes=java.io.ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.PNG,100,it) }.toByteArray()
            File(icons,filename(host)).writeBytes(bytes)
            onSaved("data:image/png;base64,"+Base64.encodeToString(bytes,Base64.NO_WRAP))
        } }
    }
    fun icon(url: String): Bitmap? = runCatching { BitmapFactory.decodeFile(File(icons, filename(UrlRules.host(url))).path) }.getOrNull()
    fun iconData(url: String): String = runCatching {
        val file = File(icons, filename(UrlRules.host(url)))
        if (file.isFile && file.length() <= 131072) "data:image/png;base64," + Base64.encodeToString(file.readBytes(), Base64.NO_WRAP) else ""
    }.getOrDefault("")
    fun savePreview(id: String, bitmap: Bitmap) = io.execute {
        runCatching { File(previews, filename(id)).outputStream().use { bitmap.compress(Bitmap.CompressFormat.WEBP, 80, it) } }
    }
    fun preview(id: String): Bitmap? = runCatching { BitmapFactory.decodeFile(File(previews, filename(id)).path) }.getOrNull()
    fun deletePreview(id: String) = io.execute { File(previews, filename(id)).delete(); Unit }
    fun clearPreviews() = io.execute { previews.listFiles()?.forEach(File::delete) }
    fun clearIcons() = io.execute { icons.listFiles()?.forEach(File::delete) }
}
