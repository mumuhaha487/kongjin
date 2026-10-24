import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
import {homeServer} from './android-server.mjs';
import {fixture,setup} from './fixtures.mjs';
const browser=await chromium.launch({executablePath:'tests/.browser/chrome-win/chrome.exe',args:['--host-resolver-rules=MAP kongjing.inc.re ~NOTFOUND, MAP sync.example.com ~NOTFOUND']}),results=[],servers=[];
async function audit(p,selector,font){return p.evaluate(({selector,font})=>{
 const root=document.querySelector(selector),elements=[root,...root.querySelectorAll('*')].filter(e=>e instanceof HTMLElement);
 const sizes=elements.map(e=>parseFloat(getComputedStyle(e).fontSize));
 elements.forEach((e,i)=>{if(e.matches('input,textarea')||[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))e.style.fontSize=sizes[i]*font/100+'px';});
 const bad=[],buttons=[];
 for(const e of elements){const css=getComputedStyle(e),r=e.getBoundingClientRect();if(css.display==='none'||css.visibility==='hidden'||!r.width||!r.height)continue;
  if(r.left<-.5||r.right>innerWidth+.5)bad.push({kind:'bounds',class:e.className,text:e.textContent.slice(0,40),left:r.left,right:r.right});
  if(!e.children.length&&e.textContent.trim()&&e.scrollWidth>e.clientWidth+1&&css.textOverflow!=='ellipsis'&&!e.matches('input,textarea'))bad.push({kind:'clip',class:e.className,text:e.textContent.slice(0,40)});
  if(e.matches('button'))buttons.push({e,r});
 }
 for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){const a=buttons[i],b=buttons[j];if(a.e.parentElement===b.e.parentElement&&Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>.5&&Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>.5)bad.push({kind:'overlap',a:a.e.textContent,b:b.e.textContent});}
 return bad;
},{selector,font});}
try{
 for(const [platform,dir,port]of [['desktop','dist-qa',4206],['store','dist-store-qa',4207]]){
  const server=await homeServer(dir,port);servers.push(server);
  for(const [width,height]of [[360,640],[360,800],[390,844],[412,915]])for(const font of [100,115,130])for(const theme of ['light','dark']){
   const c=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',locale:'zh-CN'});const d=fixture(theme);d.settings.autoClose=false;
   await setup(c,d,{'kj:popup':{url:'https://example.org/read-later',title:'稍后阅读测试'}});
   const p=await c.newPage();await p.goto(server.base);await p.waitForFunction(()=>window.kjTest);
   await p.evaluate(()=>window.kjTest.setState({overlay:{type:'pairing'},pair:{view:'invite',code:'0123456789',expiresAt:Date.now()+600000}}));await p.locator('.pair-qr-card').waitFor();await p.waitForTimeout(120);
   results.push({platform,scene:'pair-qr',width,height,font,theme,issues:await audit(p,'.pair-content',font)});
   await p.goto(server.base.replace('index.html','popup.html'));await p.getByRole('button',{name:'稍后阅读',exact:true}).waitFor();await p.waitForTimeout(120);
   results.push({platform,scene:'read-later-actions',width,height,font,theme,issues:await audit(p,'.current-actions',font)});
   await c.close();
  }
 }
}finally{await browser.close();for(const s of servers)await s.close();await writeFile((process.env.KJ_EVIDENCE || '../docs/v6/v3-evidence')+'/overflow-extra-results.json',JSON.stringify({results},null,2));}
assert.deepEqual(results.filter(r=>r.issues.length),[]);console.log('PASS',results.length,'desktop/store new-view overflow combinations');
