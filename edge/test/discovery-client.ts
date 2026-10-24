// Local-only WebRTC fixture. Private CryptoKeys remain in their browser context.
import {EdgeKongjingSync,MemorySecretStore,MemoryQueueStore,identity,deriveSlotId,unb64} from '../../shared/protocol/src/index.ts';
const api:any=globalThis,secrets=new MemorySecretStore();
let sync:EdgeKongjingSync<any>,local={at:0,value:''};
api.discovery={
  async identity(gk:string){const id=await identity();await secrets.set('identity',id);return{deviceId:id.deviceId,pub:id.pub,slot:await deriveSlotId(unb64(gk),1,id.deviceId)};},
  async seed(group:any){await secrets.set('group',group);},
  async start(origin:string){sync=new EdgeKongjingSync({relayUrl:origin,secrets,queueStore:new MemoryQueueStore(),legacyMigration:false,clientPlatform:'desktop',iceServers:[],loadLocal:async()=>local,saveMerged:async value=>{local=value;},merge:(a,b)=>a.at>=b.at?a:b});await sync.init();},
  foreground:(value:boolean)=>sync.setForeground(value),
  status:()=>sync.status(),plan:()=>(sync as any).poller?.current(),data:()=>local,
  async sync(){await sync.syncNow();},
  async change(value:string){local={at:Date.now(),value};await sync.syncNow();},
  stop(){sync?.dispose();},
};
