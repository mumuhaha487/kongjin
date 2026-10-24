import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { adb, shell, tap, nodes, screenshot, cdp, connect } from './device.mjs';
const out=resolve(import.meta.dirname,'../test-results');mkdirSync(out,{recursive:true});
const fixtures=JSON.parse(readFileSync(resolve(import.meta.dirname,'../fixtures/provenance.json'),'utf8'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];
for(const fixture of fixtures){
  tap('更多');tap('通过链接或 ID 安装');
  const edit=nodes().find(n=>n.class==='android.widget.EditText');if(!edit)throw new Error('Missing ID input');const b=edit.bounds.match(/\d+/g).map(Number);shell('input','tap',String((b[0]+b[2])>>1),String((b[1]+b[3])>>1));if(edit.text){shell('input','keyevent','123');shell('input','keyevent',...Array(edit.text.length).fill('67'));}shell('input','text',fixture.id);
  tap('继续');await wait(150);const visible=nodes();const reason=visible.find(n=>n.text==='需要更新 Android System WebView')?.text;
  if(!reason)throw new Error('Expected feature gate for '+fixture.name);
  screenshot('ext-'+fixture.name+'-webview91.png');results.push({...fixture,status:'blocked-before-download',reason,available:[],unavailable:['系统 WebView 91 不支持 DOCUMENT_START_SCRIPT，扩展功能按规范关闭']});tap('关闭');
}
writeFileSync(resolve(out,'device-extensions.json'),JSON.stringify({webView:'91.0.4472.114',extensions:results},null,2));
console.log(JSON.stringify(results.map(r=>({name:r.name,status:r.status,reason:r.reason})),null,2));
