import {EdgeKongjingSync,MemorySecretStore,MemoryQueueStore} from '../../shared/protocol/src/index.ts';
const api:any=globalThis;
let sync:EdgeKongjingSync<any>,secrets=new MemorySecretStore(),queue=new MemoryQueueStore(),local={at:0,value:''},invite:any,join:any,peer:any;
let options:any;
let delivery={attempts:0,ids:new Set<string>()};
api.kj={
  async start(origin:string,extra:any={}){options={origin,extra};sync=new EdgeKongjingSync({relayUrl:origin,secrets,queueStore:queue,legacyMigration:false,...extra,loadLocal:async()=>local,saveMerged:async value=>{local=value;},merge:(a,b)=>a.at>=b.at?a:b});await sync.init();},
  async create(name:string){await sync.createGroup(name,'Chrome');},
  async invite(){peer=undefined;invite=await sync.invite();invite.done.catch((e:any)=>console.error('invite failed',e.code,e.message));invite.onPeer((v:any)=>{peer=v;});return invite.code;},
  async join(code:string,name:string){join=await sync.join(code,name,'Chrome');join.done.catch((e:any)=>console.error('join failed',e.code,e.message));return join.sas;},
  peer:()=>peer,
  async confirmHost(){await invite.confirm();await invite.done;},
  async confirmGuest(){await join.confirm();await join.done;},
  status:()=>sync.status(),data:()=>local,
  plan:()=> (sync as any).poller?.current(),
  foreground:(visible:boolean)=>sync.setForeground(visible),
  failPeers(){(sync as any).opts.disablePeer=true;(sync as any).mesh?.dispose();(sync as any).mesh=undefined;(sync as any).update();},
  debug:()=>[...((sync as any).mesh?.peers??new Map())].map(([slot,p]:any)=>({slot,state:p.pc.connectionState,ice:p.pc.iceConnectionState,signaling:p.pc.signalingState,dc:p.dc?.readyState})),
  serverObjects:async()=>((await (sync as any).transport.list()).objects).map((o:any)=>o.key),
  change(value:string){local={at:Date.now(),value};sync.notifyLocalChange();},
  async sync(){await sync.syncNow();},
  append(n:number){for(let i=0;i<n;i++)sync.journalAppend('hv',{u:'https://private.example/'+i,ti:'private-title'});},
  deliveryRegression(){delivery={attempts:0,ids:new Set()};sync.onJournal(async rows=>{const attempt=++delivery.attempts;await new Promise(r=>setTimeout(r,60));if(attempt===1)throw new Error('application transaction rolled back');for(const row of rows)delivery.ids.add(row.id);});},
  deliveryStatus:()=>({attempts:delivery.attempts,delivered:delivery.ids.size}),
  async slot(){await sync.putSlot({tabs:[{u:'https://private.example/tabs',ti:'private-title'}]});},
  slots:()=>sync.getSlots(),
  stop(){sync.dispose();},
  async restart(extra:any={}){sync.dispose();await api.kj.start(options.origin,{...options.extra,...extra});},
  async remove(id:string){await sync.removeDevice(id);},
  async direct(enabled:boolean){await sync.setDirectOnly(enabled);},
  async inspect(){return{identity:await secrets.get('identity').then((v:any)=>({deviceId:v.deviceId})),group:await secrets.get('group')};},
};
