import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {nativeMock} from './android-fixtures.mjs';
import {singleLineAudit} from './single-line-audit.mjs';

export async function singleLineCaptures(desktopDirectory,androidDirectory,output){
  const screenshots=resolve(output,'../screenshots');await mkdir(screenshots,{recursive:true});
  const desktop=await homeServer(desktopDirectory,0),android=await homeServer(androidDirectory,0);
  const browser=await chromium.launch({executablePath:resolve('tests/.browser/chrome-win/chrome.exe'),args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND,MAP sync.example.com ~NOTFOUND']});
  const results=[],errors=[];
  try{
    for(const config of [
      {name:'android-360',android:true,width:360,height:640,dpr:2.625},
      {name:'android-412',android:true,width:412,height:915,dpr:2.625},
      {name:'desktop',width:1440,height:900,dpr:2},
      {name:'popup',popup:true,width:360,height:560,dpr:2},
    ])for(const theme of ['light','dark']){
      const context=await browser.newContext({viewport:{width:config.width,height:config.height},deviceScaleFactor:config.dpr,isMobile:!!config.android,hasTouch:!!config.android,reducedMotion:'reduce',locale:'zh-CN'});
      try{
        if(config.android)await nativeMock(context);
        await setup(context,fixture(theme),{'kj:mock':{paired:true,extraDevices:['非常长的设备名称 · 空境 Android 测试机']},'kj:popup':{id:1,url:'https://github.com/',title:'GitHub'}});
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
        await page.clock.setFixedTime(new Date('2026-10-24T06:00:00+08:00'));
        await page.goto(config.android?android.base:config.popup?desktop.base.replace('index.html','popup.html'):desktop.base);
        if(config.popup)await page.locator('.relay-send-pill').first().waitFor();
        else{
          await page.waitForFunction(()=>window.kjTest?.relayState?.getState().status.paired);
          await page.evaluate(()=>window.kjTest.openRelay('devices'));
          await page.locator('.relay-device-card').first().waitFor();
        }
        await page.waitForTimeout(500);
        if(!config.popup){
          // Opening the desktop panel refreshes host status. Install the
          // screenshot-only state after that refresh, in both subscribers.
          await page.evaluate(()=>{
            const store=window.kjTest.relayState,state=store.getState();
            const status={...state.status,devices:state.status.devices.map((d,i)=>({...d,name:d.self?d.name:i===1?'本地桌面 A · Chrome':'非常长的设备名称 · 空境 Android 测试机',online:d.self,transport:'offline',lastSeenAt:Date.now()}))};
            window.kjTest.setState({status});store.setState({status});
          });
          await page.waitForFunction(()=>document.querySelectorAll('.relay-device-card .transport-pill.offline').length===3);
        }
        await page.evaluate(()=>{
          const nodes=[...document.querySelectorAll('body *')].filter(el=>el instanceof HTMLElement&&!el.closest('.background,[aria-hidden="true"],.theme-snapshot'));
          const sizes=nodes.map(el=>parseFloat(getComputedStyle(el).fontSize));
          nodes.forEach((el,i)=>{if(el.matches('input,textarea')||[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim()))el.style.fontSize=sizes[i]*1.3+'px';});
        });
        await page.waitForTimeout(250);
        const audit=await page.evaluate(singleLineAudit);assert.deepEqual(audit.issues,[]);
        let headers;
        if(!config.popup){
          assert.equal(await page.locator('.relay-device-card .transport-pill.offline').count(),3);
          headers=await page.locator('.relay-device-card > header').evaluateAll(elements=>elements.map(el=>({nameMinWidth:getComputedStyle(el.querySelector('strong')).minWidth,atoms:[...el.querySelectorAll('.transport-pill,small,button')].map(atom=>({text:atom.textContent,whiteSpace:getComputedStyle(atom).whiteSpace,shrink:getComputedStyle(atom).flexShrink}))})));
          for(const header of headers){assert.equal(header.nameMinWidth,'0px');for(const atom of header.atoms){assert.equal(atom.whiteSpace,'nowrap');assert.equal(atom.shrink,'0');}}
        }
        const name=`single-line-${config.name}-130-${theme}.png`;
        await page.screenshot({path:resolve(screenshots,name),fullPage:!!config.popup});
        results.push({name,config,theme,font:130,audit,headers});
      }finally{await context.close();}
    }
    assert.deepEqual(errors,[]);
    await writeFile(output+'/captures.json',JSON.stringify({passed:true,results,errors},null,2));
  }finally{await browser.close();await desktop.close();await android.close();}
}
