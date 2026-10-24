package re.inc.kongjing.browser.ext.core

import org.json.JSONArray
import org.json.JSONObject

object ScriptBuilder {
    fun config(e: InstalledExtension, type: String)=JSONObject().put("id",e.id).put("type",type).put("manifest",e.manifest.json)
        .put("messages",e.manifest.messages).put("hosts",JSONArray(e.grantedHosts.toList()))
        .put("contentHosts",JSONArray((e.grantedHosts+e.manifest.contentScripts.flatMap {it.strings("matches")}).toList()))
    /** Single asynchronous scope keeps var/let bindings shared across run_at stages. */
    fun bootstrap(e: InstalledExtension, bundle: String, bridgeName: String, registered: List<JSONObject>, users: List<JSONObject> = emptyList(), clicked: Boolean=false): String {
        val scripts=e.manifest.contentScripts+registered
        fun source(script: JSONObject,kind: String): String = script.strings(kind).joinToString("\n") { path ->
            val file=SafeZip.path(e.root,path.trimStart('/')); require(file.isFile && file.length()<=20*1024*1024)
            if(kind=="js") file.readText()+"\n//# sourceURL=${e.manifest.url(path)}\n" else file.readText()
        }
        val metadata=JSONArray(scripts.map { s -> JSONObject(s.toString()).put("cssText",source(s,"css")).put("jsText",source(s,"js")) }+users.map {s->JSONObject(s.toString()).put("world","MAIN").put("jsText",s.objects("js").joinToString("\n") {j->if(j.has("code"))j.getString("code") else SafeZip.path(e.root,j.getString("file").trimStart('/')).readText()})})
        val groups=metadata.values().map {it as JSONObject}.groupBy {s->
            listOf("matches","exclude_matches","excludeMatches","include_globs","includeGlobs","exclude_globs","excludeGlobs","all_frames","allFrames","match_about_blank","matchAboutBlank","match_origin_as_fallback","matchOriginAsFallback","world").joinToString("|"){s.opt(it)?.toString() ?: ""}
        }.values.joinToString(",") {group->
            fun phase(at:String)=group.filter {it.optString("run_at",it.optString("runAt","document_idle"))==at}.joinToString("\n;\n") {it.optString("jsText")}
            val data=JSONArray(group.map {JSONObject(it.toString()).also {copy->copy.remove("jsText")}})
            "{scripts:$data,execute:async function(chrome,browser,window,self,globalThis,document,MutationObserver,__end,__idle){\n"+phase("document_start")+"\n;await __end;\n"+phase("document_end")+"\n;await __idle;\n"+phase("document_idle")+"\n}}"
        }
        // Content scripts must not alter window.chrome; own extension pages explicitly export chrome/browser.
        return """(function(){
            $bundle
            const transport=KJRuntime.captureBridge(${JSONObject.quote(bridgeName)});
            const href=location.href, own=location.origin===${JSONObject.quote(e.manifest.url().trimEnd('/'))};
            const groups=[$groups];
            let fallback='';try{fallback=parent.location.href}catch(e){fallback=document.referrer}
            if(!own&&!KJRuntime.allowedPage(href))return;
            const config=${config(e,"content")};config.type=own?(["/_kj/background.html",${JSONObject.quote("/"+e.manifest.json.optJSONObject("background")?.optString("page","_kj/background.html"))}].includes(location.pathname)?'background':'page'):'content';
            const r=KJRuntime.createRuntime(config,transport);
            KJRuntime.installBackground(r);
            if(own){window.chrome=r.chrome;window.browser=r.browser;KJRuntime.installNetwork(r);window.close=()=>r.call('_ui.close',[]);}
            transport.listen(event=>r.receive(event.data));
            const send=(api,args)=>r.call(api,args).catch(()=>{});
            if(own)window.addEventListener('load',()=>send('_offscreen.ready',[location.pathname]),{once:true});
            if(config.type==='background')window.addEventListener('load',()=>send('_lifecycle.ready',[]),{once:true});
            let ran=false;const run=()=>{if(ran)return;ran=true;groups.forEach(g=>KJRuntime.runContent(r,g.scripts,window,g.execute).catch(console.error))};
            const policy=${JSONObject.quote(e.access)},sites=${JSONArray(e.sites.toList())};
            if(!own){r.event('_host.grant').addListener(run);if(policy==='all'||${clicked}||policy==='specific'&&sites.some(s=>{try{return new URL(s).hostname===location.hostname}catch(e){return false}}))run();}
            if(!own){document.addEventListener('DOMContentLoaded',()=>send('_navigation.dom',[location.href]),{once:true});window.addEventListener('load',()=>send('_navigation.complete',[location.href]),{once:true});
              for(const method of ['pushState','replaceState']){const original=history[method];history[method]=function(...args){const value=original.apply(this,args);send('_navigation.history',[location.href]);return value}}}
        })();""".trimIndent()
    }
    fun background(e: InstalledExtension): String {
        val bg=e.manifest.json.optJSONObject("background") ?: JSONObject()
        val files=if(bg.has("service_worker")) listOf(bg.getString("service_worker")) else bg.strings("scripts")
        val module=bg.optString("type")=="module"
        return "<!doctype html><meta charset=utf-8>"+"<script src=\"/_kj/worker-shim.js\"></script>"+files.joinToString("") { p ->
            val escaped=e.manifest.url(p).replace("&","&amp;").replace("\"","&quot;").replace("<","&lt;")
            "<script ${if(module) "type=\"module\"" else ""} src=\"$escaped\"></script>"
        }
    }
    val workerShim="""
        (function(){
          self.ServiceWorkerGlobalScope=Window;
          self.registration={scope:location.origin+'/',active:{state:'activated'},update:()=>Promise.resolve(),unregister:()=>Promise.resolve(false)};
          self.skipWaiting=()=>Promise.resolve();self.clients={matchAll:()=>Promise.resolve([]),claim:()=>Promise.resolve()};
          const original=self.addEventListener.bind(self);self.addEventListener=function(type,fn,...rest){if(type==='install'||type==='activate'){queueMicrotask(()=>fn({type,waitUntil:p=>Promise.resolve(p)}));return}return original(type,fn,...rest)};
          self.importScripts=function(...urls){const bg=chrome.runtime.getManifest().background||{};const base=bg.service_worker?chrome.runtime.getURL(bg.service_worker):location.href;for(const url of urls){const x=new XMLHttpRequest();x.open('GET',new URL(url,base).href,false);x.send();if(x.status!==200)throw new Error('importScripts failed');(0,eval)(x.responseText)}};
          window.open=function(url){chrome.tabs.create({url:new URL(url,location.href).href});return null};
        })();
    """.trimIndent()
}
