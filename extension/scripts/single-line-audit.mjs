// Runs inside a browser page. Inspect rendered text lines, not control height:
// a tall touch target may correctly contain one short line of text.
export function singleLineAudit() {
  const issues = [], seen = new Set();
  let checked = 0;
  const atom = el => [...el.classList].some(name => /pill|badge|chip|segment/.test(name) || /(^|-)tag($|-)/.test(name));
  const visible = el => {
    if (el.closest('[aria-hidden="true"],[inert],.background,.theme-snapshot,svg')) return false;
    for(let node=el;node&&node!==document.body;node=node.parentElement){
      const css=getComputedStyle(node);
      if(css.display==='none'||css.visibility==='hidden'||+css.opacity===0)return false;
    }
    return !!el.getClientRects().length;
  };
  for(const control of document.querySelectorAll('button,.text-button,[class*="pill"],[class*="badge"],[class*="chip"],[class*="tag"],[class*="segment"]')){
    if(!(control instanceof HTMLElement)||(!control.matches('button,.text-button')&&!atom(control))||!visible(control))continue;
    const walker=document.createTreeWalker(control,NodeFilter.SHOW_TEXT),groups=new Map();
    while(walker.nextNode()){
      const text=walker.currentNode,parent=text.parentElement;
      if(!text.textContent.trim()||!parent||!visible(parent))continue;
      // These are content, rather than the control's action label. Their
      // documented wrapping/clamping remains valid.
      if(parent.closest('p,.help,.device-name,.bookmark-name,.reset-label small,.me-summary small,h1,h2,h3'))continue;
      const nodes=groups.get(parent)||[];nodes.push(text);groups.set(parent,nodes);
    }
    for(const [parent,nodes]of groups){
      if(seen.has(parent))continue;seen.add(parent);
      const rectangles=nodes.flatMap(text=>{const range=document.createRange();range.selectNodeContents(text);return [...range.getClientRects()].filter(r=>r.width>.1&&r.height>.1);});
      if(!rectangles.length)continue;
      const lines=[];
      for(const rect of rectangles.sort((a,b)=>a.top-b.top))if(!lines.some(top=>Math.abs(top-rect.top)<2))lines.push(rect.top);
      checked++;
      if(lines.length>1)issues.push({kind:'single-line',label:control.tagName.toLowerCase()+'.'+control.className,text:nodes.map(node=>node.textContent).join('').trim(),lines:lines.length,fontSize:getComputedStyle(parent).fontSize,lineHeight:getComputedStyle(parent).lineHeight});
    }
  }
  return {checked,issues};
}
