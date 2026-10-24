import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adb,shell,tap,cdp,connect,screenshot } from './device.mjs';
const original=shell('settings','get','global','http_proxy');let reverse=false;
let playStore='not installed';try{playStore=shell('pm','path','com.android.vending')||playStore}catch{}
const result={originalProxy:original,webView:'91.0.4472.114',playStore,method:'adb reverse tcp:10808 tcp:10808; global http_proxy 127.0.0.1:10808'};
try{
  adb('reverse','tcp:10808','tcp:10808');reverse=true;shell('settings','put','global','http_proxy','127.0.0.1:10808');
  tap('返回');const discovery=await cdp();const home=await connect(discovery.targets.find(t=>t.url.includes('appassets.androidplatform.net')));
  await home.evaluate(`KongjingNative.open('https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh',true)`);home.close();discovery.close();
  await new Promise(r=>setTimeout(r,1500));const next=await cdp();const target=next.targets.find(t=>t.url.includes('chromewebstore'));
  if(target){const connection=await connect(target);result.before=await connection.evaluate(`({url:location.href,title:document.title,ready:document.readyState,text:document.body?.innerText?.slice(0,500)})`);await connection.send('Network.enable');const pending=[];const navigation=await connection.send('Page.reload',{ignoreCache:true});await new Promise(r=>setTimeout(r,10000));result.after=await connection.evaluate(`({url:location.href,title:document.title,ready:document.readyState,text:document.body?.innerText?.slice(0,800)})`);connection.close();}
  screenshot('ext-store-proxy.png');next.close();
}catch(e){result.error=e.message}finally{
  if(original==='null')shell('settings','delete','global','http_proxy');else shell('settings','put','global','http_proxy',original);
  if(reverse)adb('reverse','--remove','tcp:10808');result.restoredProxy=shell('settings','get','global','http_proxy');writeFileSync(resolve(import.meta.dirname,'../test-results/device-proxy.json'),JSON.stringify(result,null,2));
}
console.log(result);
