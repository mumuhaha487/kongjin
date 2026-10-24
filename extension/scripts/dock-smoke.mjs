import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { launchExtension } from "./browser.mjs";
import { fixture } from "./fixtures.mjs";

const temp = await mkdtemp(resolve("tests/.dock-smoke-"));
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html;charset=utf-8");
  res.end("<!doctype html><title>Dock interaction fixture</title><p>Bookmark dock test</p>");
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
const errors = [];
try {
  context = await launchExtension(resolve(temp, "ungranted"), resolve("dist-store"));
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  assert.equal(await worker.evaluate(() => chrome.permissions.contains({permissions:["scripting"]})), false);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get("data")).data.settings.barEnabled), false);
  await context.close(); context = undefined;

  // Headless Chromium cannot click its native permission dialog. Only this test
  // copy pregrants the optional permissions; all executable bytes are unchanged.
  const extension = resolve(temp, "extension");
  await cp(resolve("dist-store"), extension, {recursive:true});
  const manifest = JSON.parse(await readFile(resolve(extension,"manifest.json"),"utf8"));
  manifest.permissions.push("scripting");
  manifest.host_permissions.push("http://*/*", "https://*/*");
  await writeFile(resolve(extension,"manifest.json"),JSON.stringify(manifest));
  context = await launchExtension(resolve(temp,"granted"),extension);
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const home = await context.newPage();
  await home.goto(`chrome-extension://${new URL(worker.url()).hostname}/index.html`);
  await home.getByRole("textbox",{name:"搜索",exact:true}).waitFor();
  const data = fixture(); data.settings.barEnabled = true;
  await worker.evaluate(data => chrome.storage.local.set({data}),data);
  const page = await context.newPage();
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(origin);
  await page.locator("kongjing-bar").waitFor();
  const cdp = await context.newCDPSession(page);
  async function shadow(selector) {
    const {root} = await cdp.send("DOM.getDocument",{depth:-1,pierce:true});
    function find(node) {
      if(node.nodeName === "KONGJING-BAR") return node;
      for(const child of [...(node.children||[]),...(node.shadowRoots||[])]) {
        const match=find(child); if(match) return match;
      }
    }
    const host=find(root);assert.ok(host?.shadowRoots?.length);
    const {object}=await cdp.send("DOM.resolveNode",{nodeId:host.shadowRoots[0].nodeId});
    const {result,exceptionDetails}=await cdp.send("Runtime.callFunctionOn",{
      objectId:object.objectId,
      functionDeclaration:'function(selector){const el=this.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,cls:el.className};}',
      arguments:[{value:selector}],returnByValue:true
    });
    assert.ok(!exceptionDetails);return result.value;
  }
  const isOpen = async()=> (await shadow(".dock")).cls.split(" ").includes("open");
  const click = async selector=>{const r=await shadow(selector);await page.mouse.click(r.x+r.width/2,r.y+r.height/2);};
  for (const position of ["top","left","right"]) {
    await worker.evaluate(async position => {
      const {data} = await chrome.storage.local.get("data");
      data.settings.barPosition = position;
      await chrome.storage.local.set({data});
    },position);
    await page.waitForTimeout(250);
    const box = await shadow(".hot"), x=box.x+box.width/2, y=box.y+box.height/2;
    assert.ok(box.cls.includes(position));
    // A short pass over the edge must not leave a delayed opening behind.
    await page.mouse.move(400,650); await page.waitForTimeout(450);
    await page.mouse.move(x,y); await page.waitForTimeout(20);
    await page.mouse.move(400,650); await page.waitForTimeout(500);
    assert.equal(await isOpen(),false);
    // Explicit click opens without needing the hover delay.
    await page.mouse.click(x,y);
    assert.equal(await isOpen(),true);
    await page.waitForTimeout(1050);
    await click(".group");
    const menu = await shadow(".menu");
    await page.mouse.move(menu.x+menu.width/2,menu.y+menu.height/2);await page.waitForTimeout(350);
    assert.equal(await isOpen(),true,"menu remains interactive");
    // Keep moving: the deadline must not reset on every pointer event.
    for (let i=0;i<8;i++) {await page.mouse.move(350+i*12,650);await page.waitForTimeout(50);}
    await page.waitForTimeout(200);
    assert.equal(await isOpen(),false,"leave collapses even with a focused menu");
    assert.equal(await shadow(".menu"),null);
    // The user's final preference also permits hover opening.
    await page.mouse.move(x,y); await page.waitForTimeout(1150);
    assert.equal(await isOpen(),true);
    await page.keyboard.press("Escape");await page.waitForTimeout(250);
    assert.equal(await isOpen(),false);
  }
  assert.deepEqual(errors,[]);
  console.log("Dock passed: default off, optional scripting ungranted; top/left/right click and hover, menu traversal, continuous pointer exit, Escape.");
} finally {
  await context?.close();
  await new Promise(r=>server.close(r));
  await rm(temp,{recursive:true,force:true});
}
