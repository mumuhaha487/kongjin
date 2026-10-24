package re.inc.kongjing.browser.ext

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import re.inc.kongjing.browser.ext.core.NetworkClient
import java.net.ServerSocket
import java.util.Base64
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

class NetworkTest {
    private data class Received(val method: String, val path: String, val headers: Map<String,String>, val body: String)
    private data class Reply(val status: Int=200, val headers: Map<String,String> = emptyMap(), val body: String="ok")
    private class HttpFixture(private val handler: (Received)->Reply): AutoCloseable {
        private val socket=ServerSocket(0,10,java.net.InetAddress.getByName("127.0.0.1"))
        val base="http://127.0.0.1:${socket.localPort}"
        val received: MutableList<Received> = Collections.synchronizedList(mutableListOf())
        private val server=Thread {
            while(!socket.isClosed) runCatching { socket.accept().use { client ->
                val input=client.getInputStream().bufferedReader()
                val request=input.readLine().split(' ');val headers=mutableMapOf<String,String>()
                while(true) { val line=input.readLine() ?: break;if(line.isEmpty())break;headers[line.substringBefore(':').lowercase()]=line.substringAfter(':').trim() }
                val body=CharArray(headers["content-length"]?.toInt() ?: 0);var read=0
                while(read<body.size) { val count=input.read(body,read,body.size-read);if(count<0)break;read+=count }
                val receivedRequest=Received(request[0],request[1],headers,String(body,0,read));received+=receivedRequest
                val reply=handler(receivedRequest);val bytes=if(request[0]=="HEAD") ByteArray(0) else reply.body.toByteArray()
                val response="HTTP/1.1 ${reply.status} Test\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n"+reply.headers.entries.joinToString("") {"${it.key}: ${it.value}\r\n"}+"\r\n"
                client.getOutputStream().write(response.toByteArray()+bytes)
            } }
        }.apply {isDaemon=true;start()}
        override fun close() { socket.close();server.join(1000) }
    }

    @Test fun redirectPermissionCookiesAndResponseLimitAreEnforced() {
        val socket=ServerSocket(0,10,java.net.InetAddress.getByName("127.0.0.1"));val targetHits=AtomicInteger();val saved=mutableListOf<String>()
        val server=Thread {
            while(!socket.isClosed)runCatching {socket.accept().use {client->
                val reader=client.getInputStream().bufferedReader();val path=reader.readLine().split(' ')[1];val headers=mutableMapOf<String,String>()
                while(true){val line=reader.readLine() ?: break;if(line.isEmpty())break;headers[line.substringBefore(':').lowercase()]=line.substringAfter(':').trim()}
                val (status,extra,body)=when(path){
                    "/redirect"->Triple("302 Found","Location: /target\r\n","")
                    "/large"->Triple("200 OK","","x".repeat(100))
                    else->{targetHits.incrementAndGet();Triple("200 OK","Set-Cookie: server=yes; Path=/\r\n",headers["cookie"] ?: "missing")}
                }
                val bytes=body.toByteArray();client.getOutputStream().write(("HTTP/1.1 $status\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n$extra\r\n").toByteArray()+bytes)
            }}
        }.apply {isDaemon=true;start()}
        try {
            val base="http://127.0.0.1:${socket.localPort}";val client=NetworkClient({"session=yes"},{_,cookie->saved+=cookie})
            val response=client.request("$base/redirect",allowed={it.startsWith(base)})
            assertEquals("$base/target",response.url);assertEquals("session=yes",response.body.toString(Charsets.UTF_8));assertTrue(saved.any {it.startsWith("server=yes")})
            val before=targetHits.get()
            try {client.request("$base/redirect",allowed={it.endsWith("/redirect")});fail("Redirect must recheck permissions")}catch(_:IllegalArgumentException){}
            assertEquals(before,targetHits.get())
            try {client.request("$base/large",maxBytes=10);fail("Declared response length must be bounded")}catch(_:IllegalArgumentException){}
        } finally {socket.close();server.join(1000)}
    }

    @Test fun credentialsControlCookieReadAndWriteAndFetchDefaultsToSameOrigin() {
        val reads=AtomicInteger();val saved=mutableListOf<String>()
        val client=NetworkClient({reads.incrementAndGet();"session=yes"},{_,cookie->saved+=cookie})
        HttpFixture { Reply(headers=mapOf("Set-Cookie" to "server=yes; Path=/"),body=it.headers["cookie"] ?: "missing") }.use { server ->
            fun body(credentials:String,origin:String?=null)=client.request("${server.base}/cookie",credentials=credentials,initiatorOrigin=origin).body.toString(Charsets.UTF_8)
            assertEquals("session=yes",body("include"))
            assertEquals("session=yes",body("same-origin",server.base))
            assertEquals("missing",body("omit",server.base))
            assertEquals("missing",body("same-origin","${server.base}0")) // Same host, different port.
            assertEquals("missing",body("same-origin"))
            assertEquals(2,reads.get());assertEquals(2,saved.size)

            val hosts=setOf("http://127.0.0.1/*")
            val default=client.fetchJson("${server.base}/default",JSONObject(),hosts)
            assertEquals("missing",String(Base64.getDecoder().decode(default.getString("bodyBase64")),Charsets.UTF_8))
            val included=client.fetchJson("${server.base}/include",JSONObject().put("credentials","include"),hosts)
            assertEquals("session=yes",String(Base64.getDecoder().decode(included.getString("bodyBase64")),Charsets.UTF_8))
            assertFalse(included.getJSONObject("headers").keys().asSequence().any {it.equals("Set-Cookie",true)})
            assertEquals(3,reads.get());assertEquals(3,saved.size)

            client.request("${server.base}/forged",headers=mapOf("Cookie" to "forged=yes","Cookie2" to "forged=yes"),credentials="omit")
            assertNull(server.received.last().headers["cookie"]);assertNull(server.received.last().headers["cookie2"])
            assertEquals(3,reads.get());assertEquals(3,saved.size)
        }
    }

    @Test fun redirectsRecheckCredentialOriginAndStripAuthorizationAcrossPorts() {
        val saved=mutableListOf<String>();val client=NetworkClient({"session=yes"},{url,_->saved+=url})
        lateinit var origin: HttpFixture
        HttpFixture { Reply(headers=mapOf("Location" to "${origin.base}/back","Set-Cookie" to "cross=yes"),status=302) }.use { cross ->
            HttpFixture { request ->
                if(request.path=="/redirect") Reply(302,mapOf("Location" to "${cross.base}/cross","Set-Cookie" to "origin=yes"))
                else Reply(headers=mapOf("Set-Cookie" to "back=yes"))
            }.use { first ->
                origin=first
                val response=client.request("${first.base}/redirect",headers=mapOf("Authorization" to "Bearer private"),credentials="same-origin",initiatorOrigin=first.base)
                assertEquals("${first.base}/back",response.url);assertTrue(response.redirected)
                assertEquals("session=yes",first.received.first().headers["cookie"])
                assertEquals("Bearer private",first.received.first().headers["authorization"])
                assertNull(cross.received.single().headers["cookie"]);assertNull(cross.received.single().headers["authorization"])
                assertNull(first.received.last().headers["cookie"]);assertNull(first.received.last().headers["authorization"])
                assertEquals(listOf("${first.base}/redirect"),saved)

                saved.clear()
                client.request("${first.base}/redirect",credentials="include")
                assertEquals("session=yes",cross.received.last().headers["cookie"]);assertEquals("session=yes",first.received.last().headers["cookie"])
                assertEquals(listOf("${first.base}/redirect","${cross.base}/cross","${first.base}/back"),saved)
                saved.clear()
                client.request("${first.base}/redirect",credentials="omit",initiatorOrigin=first.base)
                assertNull(first.received[first.received.size-2].headers["cookie"]);assertNull(cross.received.last().headers["cookie"]);assertNull(first.received.last().headers["cookie"])
                assertTrue(saved.isEmpty())
            }
        }
    }

    @Test fun redirectModesDoNotContactTargetAndCannotBypassHostPermissions() {
        HttpFixture { Reply(302,mapOf("Location" to "/target","Set-Cookie" to "redirect=yes")) }.use { server ->
            val client=NetworkClient()
            val response=client.request("${server.base}/redirect",redirect="manual")
            assertEquals(0,response.status);assertEquals("${server.base}/redirect",response.url);assertTrue(response.headers.isEmpty());assertTrue(response.body.isEmpty())
            try {client.request("${server.base}/redirect",redirect="error");fail("Redirect error mode must reject")}catch(_:IllegalArgumentException){}
            assertEquals(listOf("/redirect","/redirect"),server.received.map {it.path})
            try {client.fetchJson("${server.base}/redirect",JSONObject().put("credentials","include"),setOf("https://ungranted.test/*"));fail("Credentials must not bypass host permissions")}catch(_:IllegalArgumentException){}
            assertEquals(2,server.received.size)
        }
    }

    @Test fun redirectMethodsPreserveHeadAnd307BodiesButRemoveRewrittenBodyHeaders() {
        HttpFixture { request ->
            when(request.path) {
                "/301","/303","/307","/308" -> Reply(request.path.drop(1).toInt(),mapOf("Location" to "/target"))
                else -> Reply()
            }
        }.use { server ->
            val client=NetworkClient();val headers=mapOf("Content-Type" to "text/plain","Content-Language" to "en","Content-Location" to "/source")
            client.request("${server.base}/303",method="HEAD")
            assertEquals("HEAD",server.received.last().method)
            for(status in listOf(301,303)) {
                client.request("${server.base}/$status",method="POST",headers=headers,body="payload".toByteArray())
                val request=server.received.last();assertEquals("GET",request.method);assertEquals("",request.body)
                headers.keys.forEach {assertNull(request.headers[it.lowercase()])}
            }
            for(status in listOf(307,308)) {
                client.request("${server.base}/$status",method="POST",headers=headers,body="payload".toByteArray())
                val request=server.received.last();assertEquals("POST",request.method);assertEquals("payload",request.body);assertEquals("text/plain",request.headers["content-type"])
            }
        }
    }
}
