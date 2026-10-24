import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {nativeMock} from './android-fixtures.mjs';
import {singleLineAudit} from './single-line-audit.mjs';

export async function joinRetryCaptures(desktopDirectory,androidDirectory,output){
  const screenshots=resolve(output,'../screenshots');await mkdir(screenshots,{recursive:true});
  const desktop=await homeServer(desktopDirectory,0),android=await homeServer(androidDirectory,0);
  const browser=await chromium.launch({executablePath:resolve('tests/.browser/chrome-win/chrome.exe'),args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND']});
  const results=[],errors=[];
  try{
    for(const mobile of [true,false])for(const theme of ['light','dark']){
      const context=await browser.newContext({viewport:{width:mobile?360:1440,height:mobile?800:900},deviceScaleFactor:mobile?2.625:2,isMobile:mobile,hasTouch:mobile,reducedMotion:'reduce',locale:'zh-CN'});
      try{
        if(mobile)await nativeMock(context);
        await setup(context,fixture(theme),{'kj:mock':{paired:true}});
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
        await page.goto(mobile?android.base:desktop.base);
        await page.waitForFunction(()=>window.kjTest?.relayState?.getState().status.paired);
        const status=await page.evaluate(()=>window.kjTest.getState().status);
        for(const scene of ['completing','failed','waiting-settings','waiting-relay']){
          await page.evaluate(()=>{window.kjTest.setState({overlay:null,settingsOpen:false});window.kjTest.relayState.setState({open:false});});
          await page.waitForTimeout(800);
          if(scene==='completing'||scene==='failed'){
            await page.evaluate(({status,scene})=>window.kjTest.setState({status:{...status,paired:false,joinPhase:scene},overlay:{type:'pairing'},pair:{view:scene==='failed'?'join-failed':'completing'}}),{status,scene});
            await page.getByRole('heading',{name:scene==='failed'?'没有完成加入':'正在完成加入…',exact:true}).waitFor();
            await page.getByRole('button',{name:'取消',exact:true}).waitFor();
            assert.equal(await page.getByRole('button',{name:'取消',exact:true}).count(),1);
            assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),scene==='failed'?1:0);
          }else{
            const waiting={...status,devices:status.devices.map((d,i)=>({...d,joining:i===1,online:i!==1,transport:i===1?'offline':'direct'}))};
            await page.evaluate(status=>window.kjTest.setState({status}),waiting);
            if(scene==='waiting-settings'){
              await page.evaluate(()=>window.kjTest.setState({settingsOpen:true}));
              await page.locator('#settings-pairing > h3').evaluate(el=>el.scrollIntoView({block:'start'}));
              const row=page.locator('.device-row').filter({has:page.getByText('等待加入',{exact:true})});
              await row.waitFor();
              assert.equal(await row.locator('.device-presence,.transport-pill').count(),0);
              assert.equal(await row.getByRole('button',{name:'移除',exact:true}).count(),1);
            }else{
              await page.evaluate(()=>window.kjTest.openRelay('devices'));
              await page.waitForTimeout(250);
              await page.evaluate(status=>window.kjTest.relayState.setState({status}),waiting);
              const card=page.locator('.relay-device-card').filter({has:page.getByText('等待加入',{exact:true})});
              await card.waitFor();
              assert.equal(await card.locator('header small,header button,.transport-pill').count(),0);
            }
          }
          await page.evaluate(()=>{
            window.__captureFonts??=new WeakMap();
            const nodes=[...document.querySelectorAll('body *')].filter(el=>el instanceof HTMLElement&&!el.closest('.background,[aria-hidden="true"],.theme-snapshot'));
            const fresh=nodes.filter(el=>!window.__captureFonts.has(el)),sizes=fresh.map(el=>parseFloat(getComputedStyle(el).fontSize));
            fresh.forEach((el,i)=>window.__captureFonts.set(el,sizes[i]));
            for(const el of nodes)if(el.matches('input,textarea')||[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim()))el.style.fontSize=window.__captureFonts.get(el)*1.3+'px';
          });
          await page.waitForTimeout(300);
          const waitingColors=await page.locator('.joining-pill').evaluateAll(elements=>{
            const probe=document.createElement('span');probe.style.color='var(--text-3)';document.body.append(probe);
            const expected=getComputedStyle(probe).color;probe.remove();
            return elements.map(el=>({actual:getComputedStyle(el).color,expected}));
          });
          for(const color of waitingColors)assert.equal(color.actual,color.expected);
          const audit=await page.evaluate(singleLineAudit);assert.deepEqual(audit.issues,[]);
          const name=`join-${scene}-${mobile?'android-360':'desktop'}-130-${theme}.png`;
          await page.screenshot({path:resolve(screenshots,name)});results.push({name,audit});
        }
      }finally{await context.close();}
    }
    assert.deepEqual(errors,[]);await writeFile(output+'/captures.json',JSON.stringify({passed:true,results,errors},null,2));
  }finally{await browser.close();await desktop.close();await android.close();}
}
