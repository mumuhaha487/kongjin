/** Desktop test mirror of P0 DNR matching. JVM tests remain authoritative for native rules. */
export function compileRules(rules) {
  const suffix=(host,domain)=>host===domain||host.endsWith('.'+domain);
  const rank={allow:5,allowAllRequests:4,block:3,upgradeScheme:2,redirect:1};
  const compiled=rules.filter(r=>rank[r.action.type]).map(r=>{
    const c=r.condition;let regex;
    if(c.regexFilter)regex=c.regexFilter;
    else if(c.urlFilter){let f=c.urlFilter;const domain=f.startsWith('||'),start=f.startsWith('|')&&!domain,end=f.endsWith('|');f=f.replace(domain?/^\|\|/:/^\|/,'').replace(/\|$/,'');regex=(domain?'^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/@]*@)?(?:[^/:]*\\.)?':start?'^':'')+[...f].map(ch=>ch==='*'?'.*':ch==='^'?'(?:[^A-Za-z0-9_.%\\-]|$)':ch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('')+(end?'$':'');}
    return {r,re:regex?new RegExp(regex,c.isUrlFilterCaseSensitive?'':'i'):null};
  });
  return (url,initiator,type,method='GET')=>{
    const host=new URL(url).hostname,source=initiator?new URL(initiator).hostname:'';let winner;
    for(const {r,re} of compiled){const c=r.condition;
      if(c.requestDomains&&!c.requestDomains.some(d=>suffix(host,d))||c.excludedRequestDomains?.some(d=>suffix(host,d)))continue;
      if(c.initiatorDomains&&!c.initiatorDomains.some(d=>suffix(source,d))||c.excludedInitiatorDomains?.some(d=>suffix(source,d)))continue;
      if(c.resourceTypes&&!c.resourceTypes.includes(type)||c.excludedResourceTypes?.includes(type))continue;
      if(c.requestMethods&&!c.requestMethods.includes(method.toLowerCase())||c.excludedRequestMethods?.includes(method.toLowerCase()))continue;
      if(c.domainType==='thirdParty'&&host.split('.').slice(-2).join('.')===source.split('.').slice(-2).join('.'))continue;
      if(re&&!re.test(url))continue;
      if(!winner||(r.priority||1)>(winner.priority||1)||(r.priority||1)===(winner.priority||1)&&rank[r.action.type]>rank[winner.action.type])winner=r;
    }
    return winner;
  };
}
