import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { RealHost, manifestFor } from '../real-host.mjs';
import { compileRules } from '../dnr-mirror.mjs';
import { readFile } from 'node:fs/promises';

for(const name of ['json-formatter','dark-reader','ublock-lite','google-translate','tampermonkey','immersive-translate','return-dislike'])test('real store extension '+name,{timeout:60000},async()=>{
  const extension=await manifestFor(name);const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:400,height:700},colorScheme:'light',proxy:{server:'http://127.0.0.1:10808'}});const host=new RealHost(extension);await host.attach(context);
  try {
    await host.start();if(name==='ublock-lite')await host.background.waitForFunction(()=>__runtime.chrome.storage.local.get('rulesetConfig').then(x=>!!x.rulesetConfig));
    if(name==='ublock-lite'){for(let attempt=0;host.registered.size<4&&attempt<100;attempt++)await new Promise(r=>setTimeout(r,50));assert.equal(host.registered.size,4);}
    let adCounts={requested:0,blocked:0,redirected:0,loaded:0};
    if(name==='ublock-lite') {
      const rules=(await Promise.all(extension.manifest.declarative_net_request.rule_resources.filter(r=>host.enabled.includes(r.id)).map(r=>readFile(extension.dir+'/'+r.path,'utf8').then(JSON.parse)))).flat();const match=compileRules(rules);
      await context.route(/^https:\/\/(pagead2\.googlesyndication\.com|www\.google-analytics\.com|securepubads\.g\.doubleclick\.net)\//,async route=>{adCounts.requested++;const request=route.request();const result=match(request.url(),'https://www.reddit.com/','script');if(result?.action.type==='block'){adCounts.blocked++;return route.abort('blockedbyclient')}if(result?.action.type==='redirect'&&result.action.redirect?.extensionPath){adCounts.redirected++;return route.fulfill({contentType:'application/javascript',body:await readFile(extension.dir+'/'+result.action.redirect.extensionPath.replace(/^\//,''))})}adCounts.loaded++;return route.fulfill({contentType:'application/javascript',body:'window.adLoaded=(window.adLoaded||0)+1;'})});
      await context.route('https://www.reddit.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>DNR and cosmetic fixture</title><div id=abptest class=promotedlink>AD COSMETIC FIXTURE</div><p>Visible article</p><script src=https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js></script><script src=https://www.google-analytics.com/analytics.js></script><script src=https://securepubads.g.doubleclick.net/tag/js/gpt.js></script>'}));
    }
    const {page}=await host.newTab(name==='json-formatter'?'https://fixture.kongjing.test/data.json':name==='ublock-lite'?'https://www.reddit.com/':'https://fixture.kongjing.test/');
    await page.waitForTimeout(1200);let popup=null;const behavior={};
    if(extension.manifest.action?.default_popup){popup=await host.popup();await popup.waitForTimeout(1200)}
    if(name==='dark-reader') {
      behavior.initialDark=await page.locator('style.darkreader').count();
      await popup.locator('.site-toggle').click();await page.waitForFunction(()=>document.querySelectorAll('style.darkreader').length===0);
      behavior.siteDisabled=await page.locator('style.darkreader').count()===0;
      await popup.locator('.site-toggle').click();await page.waitForFunction(()=>document.querySelectorAll('style.darkreader').length>0);
      behavior.siteEnabled=await page.locator('style.darkreader').count()>0;
      const previous=await page.evaluate(()=>getComputedStyle(document.body).backgroundColor);
      await popup.locator('.updown').first().locator('button').first().click();await page.waitForTimeout(700);
      behavior.settingBefore=previous;behavior.settingAfter=await page.evaluate(()=>getComputedStyle(document.body).backgroundColor);behavior.settingChanged=previous!==behavior.settingAfter;
      await popup.locator('.header__app-toggle .toggle__off').click();await page.waitForFunction(()=>document.querySelectorAll('style.darkreader').length===0);
      behavior.globalDisabled=true;
      await popup.locator('.header__app-toggle .toggle__on').click();await page.waitForFunction(()=>document.querySelectorAll('style.darkreader').length>0);behavior.globalEnabled=true;
    }
    if(name==='google-translate') {
      await popup.locator('#text-input').fill('Hello world');await popup.locator('#text-input').press('Enter');await popup.waitForTimeout(4500);
      behavior.translation=(await popup.locator('body').innerText()).slice(0,1500);
      assert.match(behavior.translation,/你好世界/);
      await host.event('contextMenus.onClicked',[{menuItemId:'translate',selectionText:'Hello world',pageUrl:page.url()},host.tabs.find(t=>t.url===page.url())]);
      await page.waitForTimeout(600);behavior.selectionTranslationUrl=host.tabs.find(t=>t.url.includes('translate.google.')&&t.url.includes('Hello'))?.url;
      assert.ok(behavior.selectionTranslationUrl,'Selected text should open the real Google Translate result URL');
    }
    if(name==='ublock-lite') {
      await popup.locator('#hostname').waitFor({state:'visible'});await page.waitForFunction(()=>getComputedStyle(document.getElementById('abptest')).display==='none',{},{timeout:5000}).catch(()=>{});
      behavior.adCounts=adCounts;behavior.cosmeticHidden=await page.locator('#abptest').isHidden();
      behavior.contentRuntime=await page.evaluate(()=>({type:__runtime.config.type,pending:window.__kjPendingScripts?.length,css:!!window.cssAPI,isolated:!!window.isolatedAPI,contexts:window.isolatedAPI?.contexts,adopted:document.adoptedStyleSheets.length}));
    }
    const details={behavior,background:!!host.background,contentTitle:await page.title(),contentText:(await page.locator('body').innerText()).slice(0,500),bodyClass:await page.locator('body').getAttribute('class'),contentStyles:await page.locator('style').evaluateAll(s=>s.map(x=>({class:x.className,id:x.id,text:x.textContent.slice(0,100)}))),popupText:popup?(await popup.locator('body').innerText()).slice(0,1500):null,registered:[...host.registered.values()],menus:[...host.menus.values()],injections:host.inject,local:host.stores.get('local')};
    await host.save('real-'+name,details);
    if(popup)await popup.screenshot({path:`test-results/real-${name}-popup.png`});await page.screenshot({path:`test-results/real-${name}-page.png`});
    if(name==='dark-reader') {assert.ok(details.contentStyles.some(s=>s.class.includes('darkreader')),'Dark Reader should style page');assert.equal(behavior.settingChanged,true);assert.deepEqual(host.errors,[]);}
    if(name==='json-formatter')assert.ok(details.contentStyles.some(s=>s.id==='jfStyleEl')&&details.contentText.includes('RawParsed'),'JSON must actually be formatted');
    if(name==='ublock-lite'){assert.ok(host.calls.includes('declarativeNetRequest.getEnabledRulesets'),'uBO background should reach DNR APIs');assert.equal(adCounts.requested,3);assert.equal(adCounts.blocked+adCounts.redirected,3);assert.equal(adCounts.loaded,0);assert.equal(behavior.cosmeticHidden,true);}
    if(name==='google-translate')assert.ok(details.menus.length>0,'Translate selection menu should be created');
  }finally{await context.close();await browser.close()}
});
