import { getStore } from '@edgeone/pages-blob';
import { BlobStorage } from '../../lib/storage.mjs';
import { createRouter } from '../../lib/router.mjs';
let router;
export async function onRequest({request,env}) {
  const started=performance.now();
  router ??= createRouter({storage:new BlobStorage(getStore({name:'kongjing',consistency:'strong'})),secret:env?.KONGJING_POW_SECRET??process.env.KONGJING_POW_SECRET,corsOrigins:env?.KONGJING_CORS_ORIGINS??process.env.KONGJING_CORS_ORIGINS??''});
  request=new Request(request.url,{method:request.method,headers:request.headers,...(!['GET','HEAD','OPTIONS'].includes(request.method)?{body:await Request.prototype.arrayBuffer.call(request)}:{})});
  const response=await router(request),headers=new Headers(response.headers);
  headers.set('Server-Timing',response.headers.get('Server-Timing').replace(/^total;dur=[\d.]+/,'total;dur='+(performance.now()-started).toFixed(2)));
  return new Response(response.body,{status:response.status,headers});
}
