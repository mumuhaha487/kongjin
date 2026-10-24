import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { bundle } from './bridge.mjs';
import { literalGroups } from './literal.mjs';

export const root = resolve(import.meta.dirname, '../fixtures');
export async function manifestFor(name) {
  const dir=resolve(root,name); const m=JSON.parse(await readFile(dir+'/manifest.json','utf8'));
  const provenance=JSON.parse(await readFile(root+'/provenance.json','utf8')).find(e=>e.name===name);
  const messages={};for(const lang of [m.default_locale,'zh','zh_CN'])if(lang&&existsSync(`${dir}/_locales/${lang}/messages.json`)){const map=JSON.parse(await readFile(`${dir}/_locales/${lang}/messages.json`,'utf8'));for(const [k,v]of Object.entries(map))messages[k.toLowerCase()]=v;}
  const resolved=JSON.parse(JSON.stringify(m).replace(/__MSG_(\w+)__/g,(_,key)=>JSON.stringify(messages[key.toLowerCase()]?.message||'').slice(1,-1)));
  return {name,dir,id:provenance.id,manifest:resolved,messages};
}
/** Real extension files are unmodified. This mirrors native tab/storage/message plumbing. */
export class RealHost {
  endpoints=new Map();pending=new Map();ports=new Map();stores=new Map();states=new Map();registered=new Map();menus=new Map();alarms=new Map();rules=new Map();enabled=[];errors=[];calls=[];next=0;tabs=[];pages=new Map();inject=[];lastUrls=new Map();
  constructor(extension){this.e=extension;this.enabled=(extension.manifest.declarative_net_request?.rule_resources||[]).filter(r=>r.enabled).map(r=>r.id);}
  async attach(context){
    this.context=context;
    await context.exposeBinding('__kjTransport',async({frame},raw)=>{try{return await this.receive(frame,JSON.parse(raw))}catch(e){this.errors.push('bridge: '+e.stack)}});
    await context.route(`https://${this.e.id}.ext.kongjing.invalid/**`,async route=>{
      const u=new URL(route.request().url());let path=decodeURIComponent(u.pathname).replace(/^\//,'');let contentType='text/html',body;
      if(path==='_kj/background.html'){
        const bg=this.e.manifest.background||{};const scripts=bg.service_worker?[bg.service_worker]:bg.scripts||[];
        body='<!doctype html><meta charset=utf-8>'+scripts.map(p=>`<script ${bg.type==='module'?'type="module"':''} src="/${p.replace(/^\//,'')}"></script>`).join('');
      }else {
        const f=resolve(this.e.dir,path);if(!f.startsWith(this.e.dir+'\\')&&!f.startsWith(this.e.dir+'/'))return route.fulfill({status:404,body:''});
        try{body=await readFile(f);contentType=({'.js':'application/javascript','.json':'application/json','.html':'text/html','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'})[extname(f)]||'application/octet-stream'}catch{return route.fulfill({status:404,body:''})}
      }
      return route.fulfill({status:200,contentType,body,headers:{'Access-Control-Allow-Origin':'*'}});
    });
    await context.route('https://fixture.kongjing.test/**',route=>route.request().url().endsWith('.json')?route.fulfill({contentType:'application/json',body:'{"hello":"world","nested":{"answer":42},"list":[1,2,3]}' }):route.fulfill({contentType:'text/html',body:'<!doctype html><title>Extension test page</title><style>body{background:#ffffff;color:#000000;font-size:18px}</style><h1>Extension test page</h1><p id=selection>Hello world, this is a translation test.</p>'}));
    const scripts=[];for(const s of this.e.manifest.content_scripts||[])scripts.push({...s,jsText:(await Promise.all((s.js||[]).map(f=>readFile(resolve(this.e.dir,f.replace(/^\//,'')),'utf8')))).join('\n;\n'),cssText:(await Promise.all((s.css||[]).map(f=>readFile(resolve(this.e.dir,f.replace(/^\//,'')),'utf8')))).join('\n')});
    this.scripts=scripts;
    const config={id:this.e.id,manifest:this.e.manifest,messages:this.e.messages,hosts:this.e.manifest.host_permissions||(this.e.manifest.permissions||[]).filter(p=>p.includes('://')||p==='<all_urls>')};
    await context.addInitScript({content:`(()=>{${bundle};const config=${JSON.stringify(config)};const own=location.hostname===config.id+'.ext.kongjing.invalid';if(!own&&!KJRuntime.allowedPage(location.href))return;config.type=own?(location.pathname==='/_kj/background.html'?'background':'page'):'content';const transport={postMessage(raw){const m=JSON.parse(raw);m.testConfig=config;__kjTransport(JSON.stringify(m))}};const r=KJRuntime.createRuntime(config,transport);window.__runtime=r;window.__kjAPI=KJRuntime;if(own){window.chrome=r.chrome;window.browser=r.browser;KJRuntime.installNetwork(r);KJRuntime.installBackground(r);if(config.type==='background'){self.registration={scope:location.origin+'/',active:{state:'activated'}};self.ServiceWorkerGlobalScope=Window;self.clients={matchAll:()=>Promise.resolve([]),claim:()=>Promise.resolve()};self.skipWaiting=()=>Promise.resolve();self.importScripts=(...urls)=>{for(const url of urls){const x=new XMLHttpRequest();x.open('GET',new URL(url,chrome.runtime.getURL(config.manifest.background.service_worker||'')).href,false);x.send();(0,eval)(x.responseText)}};}window.close=()=>r.call('_ui.close',[]);}else [...${literalGroups(scripts)},...(window.__kjPendingGroups||[])].forEach(g=>KJRuntime.runContent(r,g.scripts,window,g.execute).catch(e=>console.error(e)));})();`});
    context.on('page',page=>{page.on('pageerror',e=>this.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error')this.errors.push(m.text())});});
  }
  url(path){return `https://${this.e.id}.ext.kongjing.invalid/${path.replace(/^\//,'')}`}
  async send(frame,m){return frame.evaluate(m=>window.__runtime?.receive({v:1,...m}),m).catch(e=>{if(!/closed|destroyed|navigation/.test(e.message))this.errors.push(e.message)})}
  async event(name,args){await Promise.all([...this.endpoints.values()].map(e=>this.send(e.frame,{kind:'event',api:name,args})))}
  async start(){const bg=this.e.manifest.background;if(!bg)return;this.background=await this.context.newPage();await this.background.goto(this.url(bg.page||'_kj/background.html'));await this.event('runtime.onInstalled',[{reason:'install'}]);}
  async newTab(url='https://fixture.kongjing.test/'){const registrationSnapshot=[...this.registered.values()];const page=await this.context.newPage();const id=this.tabs.length+1;const tab={id,url,active:true,status:'loading',title:'',windowId:1,index:id-1};this.tabs.forEach(t=>t.active=false);this.tabs.push(tab);this.pages.set(id,page);await this.event('tabs.onCreated',[tab]);
    const registered=[];for(const s of registrationSnapshot)if(!s.user)registered.push({...s,jsText:(await Promise.all((s.js||[]).map(f=>readFile(resolve(this.e.dir,f.replace(/^\//,'')),'utf8')))).join('\n;\n'),cssText:(await Promise.all((s.css||[]).map(f=>readFile(resolve(this.e.dir,f.replace(/^\//,'')),'utf8')))).join('\n')});
    if(registered.length)await page.addInitScript({content:`(()=>{const groups=${literalGroups(registered)};if(window.__runtime&&__runtime.config.type==='content')groups.forEach(g=>window.__kjAPI.runContent(__runtime,g.scripts,window,g.execute).catch(console.error));else window.__kjPendingGroups=groups;})()`});
    await page.goto(url,{waitUntil:'domcontentloaded'});tab.status='complete';tab.title=await page.title();await this.event('tabs.onUpdated',[id,{status:'complete',url},tab]);await this.event('tabs.onActivated',[{tabId:id,windowId:1}]);return {page,tab}}
  async popup(){const action=this.e.manifest.action||this.e.manifest.browser_action||{};const page=await this.context.newPage();await page.goto(this.url(action.default_popup));return page}
  async receive(frame,m){
    const reply=(result,error)=>this.send(frame,{kind:'reply',id:m.id,result:result??null,undefined:result===undefined,error});
    if(m.kind==='hello'){for(const [key,e]of this.endpoints)if(e.frame===frame)this.endpoints.delete(key);this.endpoints.set(m.documentId,{frame,key:m.documentId,type:m.testConfig.type});return this.send(frame,{kind:'hello',endpoint:m.documentId})}
    const source=this.endpoints.get(m.documentId);if(!source)return;
    if(m.kind==='response'){const p=this.pending.get(m.id);if(!p)return;if(m.handled){this.pending.delete(m.id);return this.send(p.frame,{kind:'reply',id:p.call,result:m.value,undefined:!('value'in m),error:m.error})}if(--p.waiting===0){this.pending.delete(m.id);return this.send(p.frame,{kind:'reply',id:p.call,undefined:true})}return;}
    if(m.kind==='port'){
      if(m.op==='connect'){const targets=[...this.endpoints.values()].filter(e=>e!==source&&e.type!=='content');this.ports.set(m.id,{source,targets});if(!targets.length)return this.send(frame,{kind:'port',id:m.id,op:'disconnect',error:'Could not establish connection. Receiving end does not exist.'});return Promise.all(targets.map(e=>this.send(e.frame,{kind:'port',id:m.id,op:'connect',name:m.args.at(-1)?.name||'',sender:this.sender(frame)})))}
      const p=this.ports.get(m.id);if(!p)return;const targets=p.source===source?p.targets:[p.source];if(m.op==='disconnect')this.ports.delete(m.id);return Promise.all(targets.map(e=>this.send(e.frame,m)));
    }
    if(m.kind!=='call')return;
    this.calls.push(m.api);const args=m.args||[],api=m.api;const [ns,method]=api.split('.');
    if(api==='runtime.sendMessage'||api==='tabs.sendMessage'){
      const targetTab=api==='tabs.sendMessage'?args[0]:null;const targetFrame=targetTab!=null?this.pages.get(targetTab)?.mainFrame():null;
      const targets=[...this.endpoints.values()].filter(e=>e!==source&&(targetTab==null?e.type!=='content':e.frame===targetFrame));
      if(!targets.length)return reply(undefined,'Could not establish connection. Receiving end does not exist.');const id=String(++this.next);this.pending.set(id,{frame,call:m.id,waiting:targets.length});return Promise.all(targets.map(e=>this.send(e.frame,{kind:'message',id,message:args[targetTab==null?0:1],sender:this.sender(frame)})));
    }
    try {
      if(ns==='storage'){
        const area=api.split('.')[1],method=api.split('.')[2],data=this.stores.get(area)||{},keys=args[0];this.stores.set(area,data);
        if(method==='get')return reply(keys==null?data:Object.fromEntries((typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys)).filter(k=>k in data||typeof keys==='object'&&!Array.isArray(keys)).map(k=>[k,k in data?data[k]:keys[k]])));
        if(method==='getBytesInUse')return reply(Buffer.byteLength(JSON.stringify(data)));
        if(method==='setAccessLevel')return reply();const old=structuredClone(data);if(method==='set')Object.assign(data,keys);if(method==='remove')(Array.isArray(keys)?keys:[keys]).forEach(k=>delete data[k]);if(method==='clear')Object.keys(data).forEach(k=>delete data[k]);
        const changes=Object.fromEntries([...new Set([...Object.keys(old),...Object.keys(data)])].filter(k=>JSON.stringify(old[k])!==JSON.stringify(data[k])).map(k=>[k,{...(k in old?{oldValue:old[k]}:{}),...(k in data?{newValue:data[k]}:{})}]));if(Object.keys(changes).length)await this.event('storage.onChanged',[changes,area]);return reply();
      }
      if(ns==='runtime') {if(method==='getPlatformInfo')return reply({os:'android',arch:'arm',nacl_arch:'arm'});if(method==='setUninstallURL'||method==='openOptionsPage')return reply();}
      if(ns==='extension')return reply(false);
      if(ns==='i18n')return reply(['zh-CN','zh','en']);
      if(ns==='tabs') {
        if(method==='query')return reply(this.tabs.filter(t=>args[0]?.active==null||args[0].active===t.active));
        if(method==='get')return reply(this.tabs.find(t=>t.id===args[0]));
        if(method==='getCurrent')return reply(this.tabs.find(t=>this.pages.get(t.id)?.mainFrame()===frame));
        if(method==='create'){const {tab}=await this.newTab(args[0].url);return reply(tab)}
        if(method==='update'){const tab=this.tabs.find(t=>t.id===args[0]);if(args[1]?.url){await this.pages.get(tab.id).goto(args[1].url);tab.url=args[1].url}return reply(tab)}
        if(method==='reload') {await this.pages.get(args[0]).reload();return reply()}
      }
      if(ns==='windows')return reply(method==='getAll'?[{id:1,type:'normal',focused:true}]:{id:1,type:'normal',focused:true});
      if(ns==='action') {const state=this.states.get(args[0]?.tabId||'default')||{};this.states.set(args[0]?.tabId||'default',state);if(method==='getBadgeText')return reply(state.badgeText||'');if(method==='getPopup')return reply(this.e.manifest.action?.default_popup||'');Object.assign(state,args[0]);return reply();}
      if(ns==='permissions'){if(method==='getAll')return reply({permissions:this.e.manifest.permissions||[],origins:this.e.manifest.host_permissions||[]});if(method==='contains'||method==='request')return reply(true);return reply(true)}
      if(ns==='alarms'){if(method==='create'){this.alarms.set(typeof args[0]==='string'?args[0]:'',args.at(-1));return reply()}if(method==='clear')return reply(this.alarms.delete(args[0]||''));if(method==='clearAll'){this.alarms.clear();return reply(true)}if(method==='getAll')return reply([...this.alarms.values()]);return reply(this.alarms.get(args[0]||''))}
      if(ns==='contextMenus'){if(method==='create')this.menus.set(args[0].id,args[0]);if(method==='removeAll')this.menus.clear();return reply()}
      if(ns==='offscreen'){if(method==='hasDocument')return reply(!!this.offscreen);if(method==='createDocument'&&!this.offscreen){this.offscreen=await this.context.newPage();await this.offscreen.goto(this.url(args[0].url));}if(method==='closeDocument'){await this.offscreen?.close();this.offscreen=null}return reply()}
      if(ns==='management')return reply({id:this.e.id,name:this.e.manifest.name,version:this.e.manifest.version,installType:'normal',enabled:true});
      if(ns==='userScripts'){if(method==='getScripts')return reply([...this.registered.values()].filter(s=>s.user));if(method==='register'||method==='update')args[0].forEach(s=>this.registered.set(s.id,{...s,user:true}));if(method==='unregister')(args[0]?.ids||[...this.registered.keys()]).forEach(id=>this.registered.delete(id));if(method==='getWorldConfigurations')return reply([]);return reply()}
      if(ns==='scripting'){
        if(method==='getRegisteredContentScripts')return reply([...this.registered.values()].filter(s=>!s.user));
        if(method==='registerContentScripts'||method==='updateContentScripts'){args[0].forEach(s=>this.registered.set(s.id,s));return reply()}
        if(method==='unregisterContentScripts'){(args[0]?.ids||[...this.registered.keys()]).forEach(id=>this.registered.delete(id));return reply()}
        const d=args[0],page=this.pages.get(d.target.tabId);if(!page)throw new Error('No tab with id '+d.target.tabId);
        if(method==='executeScript'){
          let code=d.func?'return ('+d.func+')(...'+JSON.stringify(d.args||[])+')':(await Promise.all((d.files||[]).map(f=>readFile(resolve(this.e.dir,f.replace(/^\//,'')),'utf8')))).join('\n;\n');
          const result=await page.evaluate(async({code,world})=>{if(world==='MAIN')return (0,eval)(`(async function(){${code}\n})()`);const Async=Object.getPrototypeOf(async function(){}).constructor;return new Async('chrome','browser',code)(__runtime.chrome,__runtime.browser)},{code,world:d.world});
          this.inject.push({files:d.files,world:d.world,result});return reply([{frameId:0,result:result??null}]);
        }
        const css=d.css||(await Promise.all((d.files||[]).map(f=>readFile(resolve(this.e.dir,f.replace(/^\//,'')),'utf8')))).join('\n');if(method==='insertCSS')await page.addStyleTag({content:css});return reply();
      }
      if(ns==='declarativeNetRequest'){
        if(method==='getEnabledRulesets')return reply(this.enabled);if(method==='updateEnabledRulesets'){this.enabled=this.enabled.filter(id=>!args[0].disableRulesetIds?.includes(id));this.enabled.push(...(args[0].enableRulesetIds||[]));return reply()}
        if(method==='getAvailableStaticRuleCount')return reply(300000);if(method==='isRegexSupported')return reply({isSupported:true});
        const key=method.includes('Session')?'session':'dynamic';if(method.startsWith('get'))return reply(this.rules.get(key)||[]);const current=(this.rules.get(key)||[]).filter(r=>!args[0].removeRuleIds?.includes(r.id));current.push(...(args[0].addRules||[]));this.rules.set(key,current);return reply();
      }
      if(api==='network.fetch'){
        const [url,options]=args;const response=await this.context.request.fetch(url,{method:options.method,headers:options.headers,data:options.bodyBase64?Buffer.from(options.bodyBase64,'base64'):undefined,timeout:10000});return reply({url:response.url(),status:response.status(),headers:response.headers(),bodyBase64:(await response.body()).toString('base64')});
      }
      if(api==='_ui.close')return reply();
      throw new Error('Unsupported '+api);
    } catch(e){this.errors.push(api+': '+e.message);return reply(undefined,e.message)}
  }
  sender(frame){const tab=this.tabs.find(t=>this.pages.get(t.id)?.mainFrame()===frame);return {id:this.e.id,url:frame.url(),frameId:0,...(tab?{tab}:{})}}
  async save(name,details){await mkdir(resolve(root,'../test-results'),{recursive:true});await writeFile(resolve(root,'../test-results',name+'.json'),JSON.stringify({extension:this.e.name,version:this.e.manifest.version,calls:[...new Set(this.calls)],errors:this.errors,...details},null,2))}
}
