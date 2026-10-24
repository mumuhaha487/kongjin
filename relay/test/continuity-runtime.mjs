// Local workerd harness only: never referenced by production wrangler.toml.
import {GroupRoom as ProductionGroup, PairRoom as ProductionPair} from '../src/rooms.mjs';
import {Guard as ProductionGuard} from '../src/guard.mjs';
import {DurableObject} from 'cloudflare:workers';
import {handle} from '../src/worker.mjs';
function instrument(ctx,metrics){
  const storage=new Proxy(ctx.storage,{get(target,key){
    if(key==='sql')return {exec(...args){const cursor=target.sql.exec(...args),rows=cursor.toArray();metrics.sqlWrites+=cursor.rowsWritten;metrics.sqlReads+=cursor.rowsRead;return{toArray:()=>rows};}};
    if(['put','delete','deleteAll','setAlarm','deleteAlarm'].includes(key))return async(...args)=>{metrics.kvAlarmWrites+=key==='put'&&typeof args[0]==='object'?Object.keys(args[0]).length:1;return target[key](...args);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  return new Proxy(ctx,{get(target,key){if(key==='storage')return storage;const value=target[key];return typeof value==='function'?value.bind(target):value;}});
}
function roomClass(Class){return class extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.metrics={sqlWrites:0,sqlReads:0,kvAlarmWrites:0,doCalls:0,wsFrames:0};
    const local={...env,TESTING:'true',testConfig:JSON.parse(env.TEST_CONFIG??'{}'),testClock:()=>Date.now()};
    this.room=new Class(instrument(ctx,this.metrics),local);
  }
  async fetch(request){
    const clock=request.headers.get('X-Test-Clock'),config=request.headers.get('X-Test-Config');
    if(clock)this.room.env.testClock=()=>Number(clock);
    if(config)this.room.env.testConfig=JSON.parse(config);
    const path=new URL(request.url).pathname;
    if(path==='/test-metrics')return Response.json(this.metrics);
    if(path==='/test-alarm'){await this.room.alarm();return new Response('{}');}
    if(path==='/test-tick'){const t=await this.ctx.storage.getAlarm();if(t&&t<=Number(clock)){await this.ctx.storage.deleteAlarm();this.metrics.kvAlarmWrites++;await this.room.alarm();}return new Response('{}');}
    this.metrics.doCalls++;return this.room.fetch(request);
  }
  alarm(){return this.room.alarm();}
  webSocketMessage(...args){this.metrics.wsFrames++;return this.room.webSocketMessage(...args);}
  webSocketClose(...args){return this.room.webSocketClose(...args);}
  webSocketError(...args){return this.room.webSocketError(...args);}
};}
export const GroupRoom=roomClass(ProductionGroup),PairRoom=roomClass(ProductionPair),Guard=roomClass(ProductionGuard);
const seen=new Map();let http=0,clock=0,virtual=false;
export default {async fetch(request,env,ctx){
  if(request.headers.has('X-Test-Clock')){clock=Number(request.headers.get('X-Test-Clock'));virtual=true;}
  else if(!virtual)clock=Date.now();
  const path=new URL(request.url).pathname;
  if(path==='/__test/metrics'){
    const total={http,doCalls:0,wsFrames:0,sqlWrites:0,sqlReads:0,kvAlarmWrites:0};
    for(const [name,id]of seen.values()){const stub=env[name].get(env[name].idFromString(id));const m=await(await stub.fetch('https://internal/test-metrics')).json();for(const k of Object.keys(m))total[k]+=m[k];}
    total.sqlBaseWrites=total.sqlWrites;total.sqlWrites+=total.kvAlarmWrites;return Response.json(total);
  }
  if(path==='/__test/tick'){for(const [name,id]of seen.values())await env[name].get(env[name].idFromString(id)).fetch('https://internal/test-tick',{headers:{'X-Test-Clock':String(clock)}});return Response.json({});}
  const local={...env,TESTING:'true',testClock:()=>clock};
  for(const name of ['GROUPS','GUARDS','PAIRS'])local[name]={idFromName:n=>env[name].idFromName(n),get(id){const stub=env[name].get(id);seen.set(name+id.toString(),[name,id.toString()]);return{fetch(request){const headers=new Headers(request.headers);headers.set('X-Test-Clock',String(clock));return stub.fetch(new Request(request,{headers}));}};}};
  http++;return handle(request,local,ctx);
}};
