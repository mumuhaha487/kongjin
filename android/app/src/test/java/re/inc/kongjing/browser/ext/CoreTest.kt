package re.inc.kongjing.browser.ext

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject
import re.inc.kongjing.browser.ext.core.*
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import java.io.ByteArrayOutputStream

class CoreTest {
    private val fixtures=File("../extension-runtime/fixtures")
    private val id="bcjindcccaagfpapjjmafapmmgkkhgoa"
    private fun temp()=Files.createTempDirectory("ext-test-").toFile().also { it.deleteOnExit() }
    private fun rejects(block: ()->Unit) { try { block(); fail("Expected rejection") } catch(e:IllegalArgumentException) { } catch(e:IllegalStateException) { } }
    private fun zip(vararg entries: Pair<String,String>): ByteArray = ByteArrayOutputStream().also { out -> ZipOutputStream(out).use { z -> entries.forEach { (k,v) -> z.putNextEntry(ZipEntry(k)); z.write(v.toByteArray()); z.closeEntry() } } }.toByteArray()
    private fun update(root:File, version:String, permissions:Set<String> = setOf("storage"), hosts:Set<String> = setOf("https://required.test/*"),
        optionalPermissions:Set<String> = emptySet(), optionalHosts:Set<String> = emptySet()): PendingInstall {
        val staging=File(root,".staging-$version").also {it.mkdirs()}
        val json=JSONObject().put("manifest_version",3).put("name","Update test").put("version",version)
            .put("permissions",JSONArray(permissions.toList())).put("host_permissions",JSONArray(hosts.toList()))
            .put("optional_permissions",JSONArray(optionalPermissions.toList())).put("optional_host_permissions",JSONArray(optionalHosts.toList()))
        File(staging,"manifest.json").writeText(json.toString())
        val manifest=ExtensionManifest.load(id,staging)
        return PendingInstall(manifest,staging,"file",0,Capabilities.analyze(manifest,staging))
    }
    @Test fun realStoreCrxAllSevenValidate() {
        val files=fixtures.listFiles()!!.filter { it.extension=="crx" }; assertEquals(7,files.size)
        files.forEach { f -> val v=Crx3.verify(f.readBytes()); assertEquals(32,v.id.length); assertTrue(v.zip.size>100) }
    }
    @Test fun tamperedStorePayloadIsRejected() { val b=File(fixtures,"json-formatter.crx").readBytes(); b[b.size-30]=(b[b.size-30].toInt() xor 1).toByte(); rejects { Crx3.verify(b,id) } }
    @Test fun requestedIdCannotBeSubstituted() { rejects { Crx3.verify(File(fixtures,"json-formatter.crx").readBytes(),"a".repeat(32)) } }
    @Test fun crx2AndTruncatedHeadersRejected() { val b=File(fixtures,"json-formatter.crx").readBytes(); b[4]=2; rejects { Crx3.verify(b) }; rejects { Crx3.verify(b.copyOf(20)) } }
    @Test fun realStoreKeyIsPinned() { val b=java.util.Base64.getDecoder().decode(Crx3.STORE_KEY); assertEquals(Crx3.STORE_HASH,java.security.MessageDigest.getInstance("SHA-256").digest(b).joinToString(""){"%02x".format(it)}) }
    @Test fun safeZipRejectsTraversalAbsoluteBackslashReserved() { listOf("../outside","/absolute","a/../../outside","a\\b","C:/x","_kj/background.html").forEach { n -> rejects { SafeZip.extract(zip("manifest.json" to "{}",n to "x"),temp()) } } }
    @Test fun safeZipEnforcesActualBytesAndFileCount() { rejects { SafeZip.extract(zip("manifest.json" to "{}","big" to "x".repeat(100)),temp(),10) }; rejects { SafeZip.extract(zip("manifest.json" to "{}","two" to "x"),temp(),maxFiles=1) } }
    @Test fun safeZipRequiresManifestAndCleansPartialWrites() { val root=temp(); rejects { SafeZip.extract(zip("file" to "x"),root) }; assertFalse(root.exists()) }
    @Test fun safeZipRejectsUnixSymlink() { val b=zip("manifest.json" to "{}","link" to "../../outside"); val data=java.nio.ByteBuffer.wrap(b).order(java.nio.ByteOrder.LITTLE_ENDIAN); for(i in 0..b.size-46) if(data.getInt(i)==0x02014b50 && (data.getShort(i+28).toInt() and 65535)==4) data.putInt(i+38,0xa1ff0000.toInt()); rejects { SafeZip.extract(b,temp()) } }
    @Test fun localeFallbackPlaceholdersAndManifestResolution() { val root=temp(); File(root,"manifest.json").writeText("""{"manifest_version":3,"name":"__MSG_name__","version":"1.0","default_locale":"en"}"""); File(root,"_locales/en").mkdirs(); File(root,"_locales/en/messages.json").writeText("""{"name":{"message":"English"},"hi":{"message":"Hello ${'$'}WHO${'$'}!","placeholders":{"who":{"content":"${'$'}1"}}}}"""); File(root,"_locales/zh").mkdirs(); File(root,"_locales/zh/messages.json").writeText("""{"name":{"message":"中文"}}"""); val m=ExtensionManifest.load(id,root); assertEquals("中文",m.name); assertEquals("Hello 世界!",m.message("hi",listOf("世界"))) }
    @Test fun manifestOnlyAcceptsV2V3() { val root=temp(); File(root,"manifest.json").writeText("""{"manifest_version":4,"name":"bad","version":"1"}"""); rejects { ExtensionManifest.load(id,root) } }
    @Test fun matchPatternRespectsSchemeHostAndPath() { assertTrue(MatchPattern.matches("*://*.example.com/foo*","https://sub.example.com/foobar?q=1")); assertFalse(MatchPattern.matches("https://*.example.com/*","https://example.com.evil/x")); assertFalse(MatchPattern.matches("https://example.com/*","http://example.com/")); assertTrue(MatchPattern.matches("<all_urls>","https://example.com/")) }
    @Test fun restrictedPagesAreExcluded() { listOf("https://chromewebstore.google.com/detail/a/$id","https://chrome.google.com/webstore/detail/a/$id","https://appassets.androidplatform.net/home/","https://$id.ext.kongjing.invalid/x","file:///x","data:text/html,hi","javascript:alert(1)").forEach { assertFalse(it,MatchPattern.allowedPage(it)) } }
    @Test fun storeUrlsAreStrict() { assertEquals(id,MatchPattern.storeId("https://chromewebstore.google.com/detail/formatter/$id")); assertEquals(id,MatchPattern.storeId("https://chrome.google.com/webstore/detail/formatter/$id")); assertNull(MatchPattern.storeId("https://evil.com/detail/foo/$id")); assertNull(MatchPattern.storeId("http://chromewebstore.google.com/detail/foo/$id")) }
    @Test fun storageDefaultsChangesPersistenceAndIsolation() { val root=temp(); val events=mutableListOf<JSONObject>(); val s=ExtensionStorage(root){_,_,c->events+=c}; s.call(id,"local","set",JSONArray().put(JSONObject().put("a",1))); assertEquals(1,events.size); s.call(id,"local","set",JSONArray().put(JSONObject().put("a",1))); assertEquals(1,events.size); assertEquals(1,(ExtensionStorage(root).call(id,"local","get",JSONArray().put("a")) as JSONObject).getInt("a")); assertEquals(9,(s.call(id,"local","get",JSONArray().put(JSONObject().put("missing",9))) as JSONObject).getInt("missing")); assertEquals(0,(s.call("a".repeat(32),"local","get",JSONArray()) as JSONObject).length()); s.call(id,"local","remove",JSONArray().put("a")); assertFalse(events.last().getJSONObject("a").has("newValue")) }
    @Test fun storageSessionDoesNotPersistAndIsTrustedByDefault() { val root=temp(); val s=ExtensionStorage(root); s.call(id,"session","set",JSONArray().put(JSONObject().put("a",1))); rejects { s.call(id,"session","get",JSONArray(),content=true) }; assertEquals(0,(ExtensionStorage(root).call(id,"session","get",JSONArray()) as JSONObject).length()); s.call(id,"session","setAccessLevel",JSONArray().put(JSONObject().put("accessLevel","TRUSTED_AND_UNTRUSTED_CONTEXTS"))); assertEquals(1,(s.call(id,"session","get",JSONArray(),content=true) as JSONObject).getInt("a")) }
    @Test fun storageSyncQuotasManagedAndBytes() { val s=ExtensionStorage(temp()); rejects { s.call(id,"sync","set",JSONArray().put(JSONObject().put("a","x".repeat(8192)))) }; rejects { s.call(id,"managed","set",JSONArray().put(JSONObject())) }; s.call(id,"local","set",JSONArray().put(JSONObject().put("字","好"))); assertEquals(8,s.call(id,"local","getBytesInUse",JSONArray())) }
    @Test fun permissionWarningsMergeHostsAndSilentPermissions() { val p=PermissionText.describe(setOf("tabs","webNavigation","storage","alarms"),setOf("<all_urls>")); assertEquals(2,p.size); assertTrue(p[0].contains("所有网站")) }
    @Test fun compatibilityBlocksNativeMessagingAndWarnsContent() { val root=File(fixtures,"json-formatter"); val m=ExtensionManifest.load(id,root); val modified=m.copy(json=JSONObject(m.json.toString()).put("permissions",JSONArray().put("nativeMessaging"))); assertEquals(CompatibilityLevel.BLOCKED,Capabilities.analyze(modified,root).level); assertTrue(Capabilities.analyze(m,root).isolationWarning); assertEquals(CompatibilityLevel.BLOCKED,Capabilities.analyze(m,root,listOf("unsupported syntax")).level) }
    @Test fun resourcesRequireWarAndNeverAllowPrivatePaths() { val root=temp(); File(root,"public.js").writeText("ok"); File(root,"private.js").writeText("secret"); val m=ExtensionManifest(id,JSONObject("""{"name":"x","version":"1","manifest_version":3,"web_accessible_resources":[{"resources":["public.js"],"matches":["https://allowed.test/*"]}]}"""),JSONObject()); val e=InstalledExtension(m,root,"file",true); assertEquals(200,ResourceGate.resolve(e,m.url("public.js"),"https://allowed.test/page").status); assertEquals(404,ResourceGate.resolve(e,m.url("private.js"),"https://allowed.test/").status); assertEquals(404,ResourceGate.resolve(e,m.url("public.js"),"https://evil.test/").status); assertEquals(404,ResourceGate.resolve(e,m.url("%2e%2e/private.js"),m.url()).status); assertEquals(200,ResourceGate.resolve(e,m.url("private.js"),m.url()).status) }
    @Test fun repositoryCommitsOnlyVerifiedAndRemovesSafely() { val repo=ExtensionRepository(temp()); val p=repo.prepare(File(fixtures,"json-formatter.crx").readBytes(),id); val e=repo.commit(p); assertEquals(id,e.id); assertEquals(1,repo.list().size); repo.remove(id); assertTrue(repo.list().isEmpty()) }
    @Test fun ordinaryUpdatesRetainApprovedOptionalGrantsAndDropRemovedDeclarations() {
        val root=temp();val repo=ExtensionRepository(root)
        val original=repo.commit(update(root,"1",optionalPermissions=setOf("tabs","notifications"),optionalHosts=setOf("https://optional.test/*","https://removed.test/*")))
        repo.save(original.copy(grantedPermissions=original.grantedPermissions+setOf("tabs","notifications"),grantedHosts=original.grantedHosts+setOf("https://optional.test/*","https://removed.test/*"),pinned=true,access="specific",sites=setOf("https://required.test")))
        val next=repo.commit(update(root,"2",optionalPermissions=setOf("tabs","downloads"),optionalHosts=setOf("https://optional.test/*","https://new.test/*")),allowNewPermissions=false)
        assertEquals(setOf("storage","tabs"),next.grantedPermissions)
        assertEquals(setOf("https://required.test/*","https://optional.test/*"),next.grantedHosts)
        assertTrue(next.enabled);assertFalse(next.needsPermission);assertTrue(next.pinned);assertEquals("specific",next.access);assertEquals(setOf("https://required.test"),next.sites)
        assertEquals(next.grantedPermissions,repo.list().single().grantedPermissions);assertEquals(next.grantedHosts,repo.list().single().grantedHosts)
        val approved=repo.commit(update(root,"3",permissions=setOf("storage","downloads"),optionalPermissions=setOf("tabs"),optionalHosts=setOf("https://optional.test/*")),allowNewPermissions=true)
        assertEquals(setOf("storage","tabs","downloads"),approved.grantedPermissions);assertTrue(approved.grantedHosts.contains("https://optional.test/*"))
    }
    @Test fun automaticUpdatesKeepOptionalApprovalsWithoutApprovingNewRequiredRights() {
        val root=temp();val repo=ExtensionRepository(root)
        val original=repo.commit(update(root,"1",optionalPermissions=setOf("tabs"),optionalHosts=setOf("https://optional.test/*")))
        repo.save(original.copy(grantedPermissions=original.grantedPermissions+"tabs",grantedHosts=original.grantedHosts+"https://optional.test/*"))
        val next=repo.commit(update(root,"2",permissions=setOf("storage","tabs","downloads"),hosts=setOf("https://required.test/*","https://new-required.test/*"),optionalHosts=setOf("https://optional.test/*")),allowNewPermissions=false)
        assertEquals(setOf("storage","tabs"),next.grantedPermissions)
        assertEquals(setOf("https://required.test/*","https://optional.test/*"),next.grantedHosts)
        assertFalse(next.enabled);assertTrue(next.needsPermission)
        val again=repo.commit(update(root,"3",permissions=setOf("storage","tabs","downloads"),hosts=setOf("https://required.test/*","https://new-required.test/*"),optionalHosts=setOf("https://optional.test/*")),allowNewPermissions=false)
        assertFalse(again.enabled);assertTrue(again.needsPermission);assertEquals(next.grantedPermissions,again.grantedPermissions);assertEquals(next.grantedHosts,again.grantedHosts)
    }
    @Test fun messageIdentityAndAsyncFirstResponseWins() { val r=MessageRouter { _,_->{} }; val out=mutableListOf<JSONObject>(); val a=MessageRouter.Endpoint("a",SenderContext(id,"content",1),out::add); val b=MessageRouter.Endpoint("b",SenderContext(id,"background"),out::add); r.register(a);r.register(b);r.message(a,"call",JSONObject().put("hello",1)); val message=out.last(); assertEquals(id,message.getJSONObject("sender").getString("id")); r.response(b,message.getString("id"),42,true); r.response(b,message.getString("id"),43,true); assertEquals(42,out.last().getInt("result")); assertEquals(2,out.size) }
    @Test fun noReceiverIsAnErrorAndCrossExtensionCannotReply() { val r=MessageRouter { _,_->{} }; val out=mutableListOf<JSONObject>(); val a=MessageRouter.Endpoint("a",SenderContext(id,"content",1),out::add);r.register(a);r.message(a,"call","hi");assertTrue(out.last().getString("error").contains("Receiving end")) }
    @Test fun contentCannotForgePrivilegedApi() { val m=ExtensionManifest.load(id,File(fixtures,"json-formatter")); rejects { MessageRouter.check(SenderContext(id,"content",1),m,"tabs.create",setOf("tabs")) }; rejects { MessageRouter.check(SenderContext("a".repeat(32),"background"),m,"tabs.query",emptySet()) } }
    @Test fun removedStoreProofCannotPassAsStoreButDeveloperFileStillValid() {
        val data=File(fixtures,"json-formatter.crx").readBytes();val b=java.nio.ByteBuffer.wrap(data).order(java.nio.ByteOrder.LITTLE_ENDIAN);val length=b.getInt(8)
        fun varint(number:Int):ByteArray {var n=number;val out=ByteArrayOutputStream();do {out.write((n and 127) or if(n ushr 7!=0)128 else 0);n=n ushr 7}while(n!=0);return out.toByteArray()}
        val fields=Crx3.proto(data.copyOfRange(12,12+length)).filterNot {(kind,value)->kind==3 && Crx3.proto(value).any {it.first==1 && it.second.contentEquals(java.util.Base64.getDecoder().decode(Crx3.STORE_KEY))}}
        val header=fields.fold(byteArrayOf()){out,(kind,value)->out+varint(kind*8+2)+varint(value.size)+value}
        val changed=data.copyOfRange(0,8)+java.nio.ByteBuffer.allocate(4).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(header.size).array()+header+data.copyOfRange(12+length,data.size)
        assertEquals(id,Crx3.verify(changed,id,false).id);rejects {Crx3.verify(changed,id,true)}
    }
    @Test fun sitePolicyCannotBeBypassedByManifestOrActiveTabDeclaration() {
        val m=ExtensionManifest.load(id,File(fixtures,"json-formatter"));val e=InstalledExtension(m,temp(),"file",true,access="specific",sites=setOf("https://allowed.test"))
        assertTrue(SiteAccess.allowed(e,"https://allowed.test/json"));assertFalse(SiteAccess.allowed(e,"https://evil.test/json"))
        val click=e.copy(access="click");assertFalse(SiteAccess.allowed(click,"https://allowed.test/"));assertTrue(SiteAccess.allowed(click,"https://allowed.test/",true))
        assertFalse(SiteAccess.allowed(click,"https://chromewebstore.google.com/",true))
    }
    @Test fun updateParserRejectsExternalEntitiesAndOnlyReturnsOfferedVersions() {
        val xml="""<gupdate><app appid="$id"><updatecheck status="ok" version="2.0"/></app><app appid="${"a".repeat(32)}"><updatecheck status="noupdate"/></app></gupdate>"""
        assertEquals(mapOf(id to "2.0"),NetworkClient.parseUpdates(xml.toByteArray()))
        rejects {NetworkClient.parseUpdates("""<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><gupdate>&x;</gupdate>""".toByteArray())}
    }
    @Test fun invalidScriptCannotInstallAndLaterBreakEveryTabAttachment() {
        val root=temp();File(root,"manifest.json").writeText("""{"manifest_version":3,"name":"bad","version":"1","content_scripts":[{"matches":["<all_urls>"],"js":["missing.js"]}]}""")
        rejects {ExtensionManifest.load(id,root)}
        File(root,"missing.js").writeText("void 0")
        assertEquals("bad",ExtensionManifest.load(id,root).name)
        rejects {ExtensionManifest.validateContentScript(JSONObject("""{"matches":["garbage"],"js":["missing.js"]}"""),root)}
    }
}
