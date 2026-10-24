import {EdgeKongjingSync,MemorySecretStore,MemoryQueueStore} from '../../shared/protocol/src/index.ts';
let sync:EdgeKongjingSync<any>,data={at:0,value:''},invite:any,join:any,peer:any;
let events:Array<{at:number;direct:boolean}>=[],received:Array<{at:number;value:string}>=[];
const secrets=new MemorySecretStore();
const lock=<T>(task:()=>Promise<T>)=>navigator.locks.request('kongjing:app-data',task);
(globalThis as any).v33={
 async start(origin:string){sync=new EdgeKongjingSync({relayUrl:origin,secrets,queueStore:new MemoryQueueStore(),legacyMigration:false,iceServers:[],clientPlatform:'desktop',withLocalLock:lock,
  loadLocal:async()=>structuredClone(data),saveMerged:async v=>{data=v;received.push({at:Date.now(),value:v.value});},merge:(a,b)=>a.at>=b.at?a:b});
  sync.on('status',s=>{const direct=s.devices.some(d=>!d.self&&d.transport==='direct');if(events.at(-1)?.direct!==direct)events.push({at:Date.now(),direct});});await sync.init();},
 create:()=>sync.createGroup('v33 desktop A','Chrome'),
 async invite(){peer=undefined;invite=await sync.invite();void invite.done.catch(()=>{});invite.onPeer((p:any)=>{peer=p;});return invite.code;},
 async join(code:string){join=await sync.join(code,'v33 desktop B','Chrome');void join.done.catch(()=>{});return join.sas;},
 peer:()=>peer,
 async confirmHost(){await invite.confirm();await invite.done;},async confirmGuest(){await join.confirm();await join.done;},
 status:()=>sync.status(),plan:()=>(sync as any).poller?.current(),events:()=>events,received:()=>received,data:()=>data,
 diagnostics:()=>sync.diagnostics(),
 async change(value:string){await lock(async()=>{data={at:Date.now(),value};});sync.notifyLocalChange();},
 silent(enabled:boolean){(sync as any).mesh.setTestDropFrames(enabled);return(sync as any).mesh.states();},
 close(){const mesh=(sync as any).mesh;for(const p of mesh.peers.values())p.pc.close();mesh.setTestDropFrames(true);},
 async recover(){(sync as any).mesh.setTestDropFrames(false);(sync as any).mesh.setForeground(true);await sync.syncNow();},
 async sync(){await sync.syncNow();},
 reset(){events=[];received=[];},
 stop(){sync?.dispose();},
};
