package re.inc.kongjing.browser.ext.core

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID

data class InstalledExtension(val manifest: ExtensionManifest, val root: File,
    val source: String, val enabled: Boolean, val pinned: Boolean=false, val access: String="all",
    val sites: Set<String> = emptySet(), val grantedPermissions: Set<String> = manifest.permissions,
    val grantedHosts: Set<String> = manifest.hosts, val needsPermission: Boolean=false) {
    val id get()=manifest.id
}
data class PendingInstall(val manifest: ExtensionManifest, val root: File, val source: String,
    val bytes: Int, val compatibility: CompatibilityReport)

class ExtensionRepository(private val root: File) {
    init { root.mkdirs() }
    fun prepare(bytes: ByteArray, requestedId: String?=null, source: String="store"): PendingInstall {
        val verified=if(bytes.take(4).toByteArray().contentEquals("Cr24".toByteArray())) Crx3.verify(bytes,requestedId,source=="store") else {
            require(source=="file") { "商店下载必须是签名 CRX3" }
            val hash=MessageDigest.getInstance("SHA-256").digest(bytes)
            val id=hash.take(16).joinToString("") { "${('a'.code+((it.toInt() and 255) ushr 4)).toChar()}${('a'.code+(it.toInt() and 15)).toChar()}" }
            Crx3.Verified(id,bytes,byteArrayOf())
        }
        val staging=File(root,".staging-${UUID.randomUUID()}")
        try {
            SafeZip.extract(verified.zip,staging)
            val m=ExtensionManifest.load(verified.id,staging)
            return PendingInstall(m,staging,source,bytes.size,Capabilities.analyze(m,staging))
        } catch(e: Exception) { staging.deleteRecursively(); throw e }
    }
    @Synchronized fun commit(pending: PendingInstall, allowNewPermissions: Boolean=true): InstalledExtension {
        require(pending.compatibility.level!=CompatibilityLevel.BLOCKED)
        val m=pending.manifest; val old=list().firstOrNull { it.id==m.id }
        val added=old!=null && (!(old.grantedPermissions.containsAll(m.permissions)) || !old.grantedHosts.containsAll(m.hosts))
        val retainedPermissions=old?.grantedPermissions?.intersect(m.permissions+m.optionalPermissions) ?: emptySet()
        val retainedHosts=old?.grantedHosts?.intersect(m.hosts+m.optionalHosts) ?: emptySet()
        val parent=File(root,m.id); parent.mkdirs()
        val dest=File(parent,m.version)
        require(!dest.exists()) { "此版本已安装" }
        check(pending.root.renameTo(dest))
        val record=InstalledExtension(m,dest,pending.source,(!added || allowNewPermissions) && (old?.enabled ?: true),old?.pinned ?: false,
            old?.access ?: "all",old?.sites ?: emptySet(),if(added && !allowNewPermissions) retainedPermissions else m.permissions+retainedPermissions,
            if(added && !allowNewPermissions) retainedHosts else m.hosts+retainedHosts,added && !allowNewPermissions)
        try { save(record) } catch(e:Exception) { dest.deleteRecursively(); throw e }
        // Keep only the previous known working version, never delete current metadata/storage.
        parent.listFiles()?.filter { it.isDirectory && it.name!=m.version && it.name!=old?.manifest?.version }?.forEach { it.deleteRecursively() }
        return record
    }
    @Synchronized fun save(e: InstalledExtension) {
        val parent=File(root,e.id); parent.mkdirs()
        val json=JSONObject().put("version",e.manifest.version).put("source",e.source).put("enabled",e.enabled).put("pinned",e.pinned)
            .put("access",e.access).put("sites",e.sites.toList()).put("permissions",e.grantedPermissions.toList()).put("hosts",e.grantedHosts.toList()).put("needsPermission",e.needsPermission)
        val file=File(parent,"installed.json"); val temp=File(parent,"installed.tmp"); temp.writeText(json.toString()); java.nio.file.Files.move(temp.toPath(),file.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE)
    }
    @Synchronized fun list(): List<InstalledExtension> = root.listFiles()?.filter { Regex("[a-p]{32}").matches(it.name) }?.mapNotNull { dir ->
        runCatching { val j=JSONObject(File(dir,"installed.json").readText()); val version=j.getString("version"); require(Regex("[0-9]+(?:\\.[0-9]+){0,3}").matches(version)); val files=File(dir,version)
            InstalledExtension(ExtensionManifest.load(dir.name,files),files,j.getString("source"),j.getBoolean("enabled"),j.optBoolean("pinned"),j.optString("access","all"),j.strings("sites").toSet(),j.strings("permissions").toSet(),j.strings("hosts").toSet(),j.optBoolean("needsPermission"))
        }.getOrNull()
    } ?: emptyList()
    @Synchronized fun remove(id: String) { require(Regex("[a-p]{32}").matches(id)); File(root,id).deleteRecursively() }
    fun discard(pending: PendingInstall) { require(pending.root.parentFile?.canonicalFile==root.canonicalFile && pending.root.name.startsWith(".staging-")); pending.root.deleteRecursively() }
}
