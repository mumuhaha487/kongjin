package re.inc.kongjing.browser.ext.core

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** CRX3 only. No unsigned/store fallback and no acceptance of publisher test keys. */
object Crx3 {
    // Chromium components/crx_file/crx_verifier.cc, kPublisherKeyHash (retrieved 2026-10-24).
    // https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx_verifier.cc
    // DER SPKI from a real CWS proof; SHA256 is pinned to Chromium's production key.
    const val STORE_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtAL5qRyu4QyE+NybF3KYpeAy1dsrWdhJwO++6Gv5+GJSuGo1U2wHizjU/5rdvN35vEgiacwtbKEBYLRR43vRzw=="
    const val STORE_HASH = "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf"
    data class Verified(val id: String, val zip: ByteArray, val publicKey: ByteArray)
    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)
    fun id(key: ByteArray): String = sha(key).take(16).joinToString("") {
        "${('a'.code + ((it.toInt() and 255) ushr 4)).toChar()}${('a'.code + (it.toInt() and 15)).toChar()}"
    }
    fun verify(data: ByteArray, requestedId: String? = null, fromStore: Boolean = true): Verified {
        require(data.size in 12..(200 * 1024 * 1024)) { "CRX 大小无效" }
        require(data.copyOfRange(0,4).contentEquals("Cr24".toByteArray())) { "不是 CRX 文件" }
        val b = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
        require(b.getInt(4) == 3) { "只接受 CRX3" }
        val length = b.getInt(8)
        require(length in 1..(1024 * 1024) && length <= data.size - 12) { "CRX 头无效" }
        val headerBytes = data.copyOfRange(12,12+length)
        for (tail in listOf(byteArrayOf(80,75,5,6),byteArrayOf(80,75,6,6),byteArrayOf(80,75,6,7))) {
            require((0..headerBytes.size-4).none { i -> (0..3).all { headerBytes[i+it]==tail[it] } }) { "CRX 头含 ZIP 结束记录" }
        }
        val header = proto(headerBytes)
        val signed = header.singleOrNull { it.first == 10000 }?.second ?: error("缺少 signed_header_data")
        val declared = proto(signed).singleOrNull { it.first == 1 }?.second ?: error("缺少 crx_id")
        require(declared.size == 16)
        val declaredId = declared.joinToString("") { "${('a'.code+((it.toInt() and 255) ushr 4)).toChar()}${('a'.code+(it.toInt() and 15)).toChar()}" }
        require(requestedId == null || requestedId == declaredId) { "扩展 ID 不匹配" }
        val zip = data.copyOfRange(12+length,data.size)
        require(zip.size >= 4 && zip[0] == 80.toByte() && zip[1] == 75.toByte()) { "缺少 ZIP 正文" }
        val prefix = "CRX3 SignedData\u0000".toByteArray() + ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(signed.size).array() + signed
        var developer: ByteArray? = null
        var publisher = false
        val proofs = header.filter { it.first == 2 || it.first == 3 }
        require(proofs.isNotEmpty() && proofs.size <= 32)
        proofs.forEach { (kind, raw) ->
            val fields = proto(raw)
            val key = fields.singleOrNull { it.first == 1 }?.second ?: error("缺少公钥")
            val sig = fields.singleOrNull { it.first == 2 }?.second ?: error("缺少签名")
            val rsa = kind == 2
            val verifier = Signature.getInstance(if (rsa) "SHA256withRSA" else "SHA256withECDSA")
            verifier.initVerify(KeyFactory.getInstance(if (rsa) "RSA" else "EC").generatePublic(X509EncodedKeySpec(key)))
            verifier.update(prefix); verifier.update(zip)
            require(verifier.verify(sig)) { "CRX 签名无效" }
            if (rsa && id(key) == declaredId) developer = key
            if (key.contentEquals(Base64.getDecoder().decode(STORE_KEY))) publisher = true
        }
        require(developer != null) { "缺少有效的开发者 RSA 签名" }
        require(!fromStore || publisher) { "缺少 Chrome 应用商店签名" }
        return Verified(declaredId,zip,developer!!)
    }
    /** Strict bounded protobuf wire reader (only length-delimited schema fields are retained). */
    internal fun proto(bytes: ByteArray): List<Pair<Int,ByteArray>> {
        var i = 0
        fun number(): Long {
            var out = 0L
            for (shift in 0..63 step 7) {
                require(i < bytes.size) { "截断的 protobuf" }
                val c = bytes[i++].toInt() and 255
                require(shift < 63 || c <= 1)
                out = out or ((c and 127).toLong() shl shift)
                if (c < 128) return out
            }
            error("protobuf varint 溢出")
        }
        val result = mutableListOf<Pair<Int,ByteArray>>()
        while (i < bytes.size) {
            val tag = number(); require(tag ushr 3 in 1..536870911)
            when ((tag and 7).toInt()) {
                0 -> number()
                1 -> { require(i+8 <= bytes.size); i+=8 }
                5 -> { require(i+4 <= bytes.size); i+=4 }
                2 -> { val n = number(); require(n >= 0 && n <= bytes.size-i); val end=i+n.toInt(); result += (tag ushr 3).toInt() to bytes.copyOfRange(i,end); i=end }
                else -> error("不支持的 protobuf wire type")
            }
        }
        return result
    }
}
