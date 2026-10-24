/** Mirrors ScriptBuilder's literal executor generation: no unsafe-eval for declared scripts. */
export function literalGroups(scripts) {
  const keys=['matches','exclude_matches','excludeMatches','include_globs','includeGlobs','exclude_globs','excludeGlobs','all_frames','allFrames','match_about_blank','matchAboutBlank','match_origin_as_fallback','matchOriginAsFallback','world'];
  const groups=Map.groupBy(scripts,s=>JSON.stringify(keys.map(k=>s[k]??null)));
  return '['+[...groups.values()].map(group=>{
    const data=group.map(({jsText,...s})=>s);
    const phase=at=>group.filter(s=>(s.run_at||s.runAt||'document_idle')===at).map(s=>s.jsText||'').join('\n;\n');
    return `{scripts:${JSON.stringify(data)},execute:async function(chrome,browser,window,self,globalThis,document,MutationObserver,__end,__idle){${phase('document_start')}\n;await __end;\n${phase('document_end')}\n;await __idle;\n${phase('document_idle')}\n}}`;
  }).join(',')+']';
}
