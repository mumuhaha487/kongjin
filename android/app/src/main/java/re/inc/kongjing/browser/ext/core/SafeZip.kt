package re.inc.kongjing.browser.ext.core

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipInputStream

object SafeZip {
    const val MAX_BYTES = 200L * 1024 * 1024
    const val MAX_FILES = 20000
    fun path(root: File, name: String): File {
        require(name.isNotEmpty() && name.length <= 1024 && !name.startsWith('/') && '\\' !in name && ':' !in name && '\u0000' !in name)
        require(name.split('/').none { it == ".." || it == "." }) { "不安全的扩展路径" }
        require(!name.startsWith("_kj/")) { "扩展使用了保留路径" }
        val target = File(root,name).canonicalFile
        require(target.path.startsWith(root.canonicalPath + File.separator)) { "路径穿越" }
        return target
    }
    fun extract(zip: ByteArray, root: File, maxBytes: Long = MAX_BYTES, maxFiles: Int = MAX_FILES): Long {
        require(!root.exists() || root.listFiles().isNullOrEmpty()) { "只能解包到空目录" }
        // Check central directory Unix file types; ZipInputStream alone loses symlink metadata.
        val b = ByteBuffer.wrap(zip).order(ByteOrder.LITTLE_ENDIAN)
        var end = -1
        for (i in zip.size-22 downTo (zip.size-65557).coerceAtLeast(0)) {
            if (b.getInt(i) == 0x06054b50 && i+22+(b.getShort(i+20).toInt() and 65535) == zip.size) { end=i; break }
        }
        require(end >= 0) { "缺少 ZIP 目录" }
        require(b.getShort(end+4).toInt() == 0 && b.getShort(end+6).toInt() == 0) { "拒绝多卷 ZIP" }
        val count = b.getShort(end+10).toInt() and 65535
        require(count <= maxFiles && count == (b.getShort(end+8).toInt() and 65535))
        val centralSize = b.getInt(end+12); var offset = b.getInt(end+16)
        require(centralSize >= 0 && offset >= 0 && offset.toLong()+centralSize == end.toLong()) { "ZIP64/目录异常" }
        val expected = mutableSetOf<String>()
        repeat(count) {
            require(offset+46 <= end && b.getInt(offset) == 0x02014b50)
            val flags = b.getShort(offset+8).toInt() and 65535; require(flags and 1 == 0) { "不接受加密 ZIP" }
            val mode = (b.getInt(offset+38) ushr 16) and 0xf000
            require(mode == 0 || mode == 0x8000 || mode == 0x4000) { "不接受符号链接/特殊文件" }
            val n = b.getShort(offset+28).toInt() and 65535
            val extra = b.getShort(offset+30).toInt() and 65535
            val comment = b.getShort(offset+32).toInt() and 65535
            require(offset+46+n+extra+comment <= end)
            val name = zip.copyOfRange(offset+46,offset+46+n).toString(Charsets.UTF_8)
            path(root,name); require(expected.add(name)) { "重复 ZIP 路径" }
            offset += 46+n+extra+comment
        }
        require(offset == end)
        root.mkdirs()
        var total = 0L
        var files = 0
        try {
            ZipInputStream(ByteArrayInputStream(zip)).use { input ->
                while (true) {
                    val e = input.nextEntry ?: break
                    require(++files <= maxFiles && expected.remove(e.name))
                    val file = path(root,e.name)
                    if (e.isDirectory) file.mkdirs() else {
                        file.parentFile!!.mkdirs()
                        file.outputStream().use { out ->
                            val buffer = ByteArray(16384)
                            while (true) { val n=input.read(buffer); if (n<0) break; total+=n; require(total<=maxBytes) { "解包超过 200MB" }; out.write(buffer,0,n) }
                        }
                    }
                    input.closeEntry()
                }
            }
            require(expected.isEmpty() && files == count && File(root,"manifest.json").isFile) { "ZIP 目录与正文不一致/缺少 manifest" }
            return total
        } catch (e: Exception) { root.deleteRecursively(); throw e }
    }
}
