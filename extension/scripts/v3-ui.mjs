import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {launchChrome} from './browser.mjs';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
import {nativeMock,mobileOptions} from './android-fixtures.mjs';
process.env.KJ_BLOCK_ONLINE_RELAY='1';
const browser=await launchChrome({args:[]}),servers=[],checks=[],errors=[];
const output=process.env.KJ_EVIDENCE || '../docs/v6/v3-evidence';await mkdir(output,{recursive:true});
async function patch(page,status){await page.evaluate(status=>window.kjTest.setState({status}),status);}
const devices=[{deviceId:'a',name:'Windows A · Chrome',platform:'Windows',self:true,online:true,transport:'direct'},{deviceId:'b',name:'MacBook · Chrome',platform:'macOS',self:false,online:true,transport:'direct'},{deviceId:'c',name:'Pixel · 空境',platform:'Android',self:false,online:true,transport:'relay'}];
async function color(locator,token){const actual=await locator.evaluate((el,token)=>{const sample=document.createElement('i');sample.style.backgroundColor=`var(${token})`;document.body.append(sample);const expected=getComputedStyle(sample).backgroundColor;sample.remove();return {actual:getComputedStyle(el).backgroundColor,expected};},token);assert.equal(actual.actual,actual.expected);return actual;}
try{
 for(const [platform,dir,port] of [['desktop','dist-qa',4197],['android','dist-android-qa',4198]]){
  const server=await homeServer(dir,port);servers.push(server);
  for(const theme of ['light','dark']){
   const context=await browser.newContext(platform==='android'?{...mobileOptions,reducedMotion:'reduce'}:{viewport:{width:1440,height:900},deviceScaleFactor:2,reducedMotion:'reduce',locale:'zh-CN'});
   if(platform==='android')await nativeMock(context);
   await setup(context,fixture(theme));
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(server.base);await page.waitForFunction(()=>window.kjTest);await page.waitForTimeout(1500);
   const status={paired:true,connection:'online',syncing:false,devices,lastSyncAt:Date.now(),epoch:0,relayUrl:'https://sync.example.com',transport:'direct',directOnly:false};
   await patch(page,status);
   if(platform==='desktop')for(const [transport,copy,token]of [['direct','直连 · 刚刚同步','--success'],['relay','中转 · 刚刚同步','--accent'],['offline','离线','--text-3']]){
    await patch(page,{...status,transport});await page.waitForTimeout(300);assert.equal(await page.locator('.sync-status').innerText(),copy);checks.push({platform,theme,transport,...await color(page.locator('.sync-status > span'),token)});
   }
   await patch(page,status);
   await page.evaluate(()=>window.kjTest.setState({settingsOpen:true,settingsSection:'pairing'}));await page.locator('#settings-pairing .device-row').first().waitFor();await page.waitForTimeout(300);
   assert.equal(await page.locator('.device-row .transport-pill').count(),3);
   assert.deepEqual(await page.locator('.device-row .transport-pill').allTextContents(),['直连','直连','中转']);
   const line=page.locator('.status-line');assert.equal((await line.innerText()).trim(),'直连 · 刚刚同步');await color(line.locator('.status-point'),'--success');
   await page.locator('#settings-pairing h3').first().evaluate(el=>el.scrollIntoView({block:'start'}));
   await page.screenshot({path:`${output}/${platform}-${theme}-devices.png`});
   await page.locator('.sync-v3-advanced').evaluate(el=>{el.open=true;});
   await page.getByLabel('同步服务器',{exact:true}).scrollIntoViewIfNeeded();
   assert.equal(await page.getByLabel('同步服务器',{exact:true}).inputValue(),'https://sync.example.com');
   assert.equal(await page.getByRole('switch',{name:'仅直连，不在服务器保存数据'}).getAttribute('aria-checked'),'false');
   await patch(page,{...status,directOnly:true});
   await page.getByText('离线的设备要等双方同时在线才会同步',{exact:true}).waitFor();
   assert.equal(await page.getByLabel('TURN 凭证',{exact:true}).getAttribute('type'),'password');
   await page.locator('.sync-v3-advanced').evaluate(el=>el.scrollIntoView({block:'start'}));await page.waitForTimeout(200);
   await page.screenshot({path:`${output}/${platform}-${theme}-advanced.png`});
   await page.getByRole('button',{name:'同步服务器预设'}).click();
   await page.getByRole('menuitem',{name:'旧版 Cloudflare',exact:true}).waitFor();
   await page.keyboard.press('Escape');
   await patch(page,{...status,relayUrl:'https://kongjing.inc.re'});
   assert.equal(await page.getByRole('switch',{name:'仅直连，不在服务器保存数据'}).count(),0);
   checks.push({platform,theme,devices:true,advancedDefaults:true,directOnlyWarning:true,credentialMasked:true,legacyOption:true});
   await context.close();
  }
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close();for(const s of servers)await s.close();await writeFile(output+'/ui-v3.json',JSON.stringify({checks,errors},null,2));}
console.log('PASS v3 transport colors, three-device labels, advanced settings, defaults, direct-only warning and TURN privacy',checks.length);
