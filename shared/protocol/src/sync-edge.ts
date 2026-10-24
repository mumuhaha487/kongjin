import {ProtocolError,type SyncOptions,type SyncStatus,type Member,type Device,type InviteSession,type JoinSession,type JournalRecord,type Slot,type Incoming,type SecretStore,type QueueStore} from './types.ts';
import {identity,random,b64url,unb64,utf8,text,deriveGroup,sealSnapshot,openSnapshot,generatePairCode,normalizePairCode,formatPairCode,pairKeys,pairSession,hmac,verifyMac,encrypt,decrypt,wrapKey,unwrapKey,sha256} from './crypto.ts';
import {deriveSlotId,sealContinuity,openContinuity,envelopeBytes,bytesEnvelope} from './continuity-crypto.ts';
import {MemoryQueueStore,IndexedDBQueueStore} from './queue-store.ts';
import {EdgeHttp,TransportEdge,DEFAULT_EDGE_URL,type ObjectInfo} from './transport-edge.ts';
import {PeerMesh,type PeerMeshOptions,type PeerSignal} from './peer-mesh.ts';
import {solvePowWorker} from './pow.ts';
import {KongjingSync as CloudflareSync} from './sync.ts';
import {OldEpochBridge,type RotationBridgeData} from './edge-bridge.ts';
import {AdaptivePoller,FULL_RECONCILE_MS,type PollInput} from './adaptive-poll.ts';
import {LocalAccess} from './local-access.ts';
import {joinRetrier} from './join-retry.ts';
import type {RequestDiagnostic,HttpObservation,RequestObserver} from './diagnostics.ts';
class DeliveryError extends Error { constructor(cause:unknown){super('Application delivery failed',{cause});} }
type Identity=Awaited<ReturnType<typeof identity>>;
type Group={gk:string;epoch:number;members:Member[];rev:number;name:string;platform:string};
type Keys=Awaited<ReturnType<typeof deriveGroup>>;
export interface EdgeSyncOptions<D> extends Omit<SyncOptions<D>,'relayUrl'> {
  relayUrl?:string;directOnly?:boolean;disablePeer?:boolean;turn?:RTCIceServer[];
  rtc?:PeerMeshOptions['rtc'];iceServers?:RTCIceServer[];
  /** Existing Cloudflare groups dual write for at most seven days. Off for new groups. */
  legacyMigration?:boolean;legacyUrl?:string;
  /** Android hidden pages suspend reads; desktop offscreen documents must pass actual UI visibility. */
  clientPlatform?:'android'|'desktop';
}
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return{promise,resolve,reject};}
const labels=(name:unknown,platform:unknown)=>typeof name==='string'&&name.length>=1&&name.length<=32&&!/[\u0000-\u001f\u007f]/.test(name)&&typeof platform==='string'&&platform.length>=1&&platform.length<=32&&!/[\u0000-\u001f\u007f]/.test(platform);
const wait=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal?.aborted){reject(new DOMException('Aborted','AbortError'));return;}const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});
/** v3 client. Uses the same identity/group SecretStore keys as v2; no re-pairing. */
export class EdgeKongjingSync<D> {
  private localAccess:LocalAccess<D>;
  private requestLog:RequestDiagnostic[]=[];
  private diagnosticContext=()=>({pollMode:this.poller?.current()?.mode??'initial',foreground:this.foreground,peers:this.mesh?.states?.()??[]});
  private observe:RequestObserver=Object.assign((o:HttpObservation)=>{const {context,...request}=o;this.requestLog.push({...request,...context??this.diagnosticContext()});if(this.requestLog.length>100)this.requestLog.shift();},{capture:()=>this.diagnosticContext()});
  diagnostics(){return structuredClone(this.requestLog);}
  private ident!:Identity;private group?:Group;private keys?:Keys;private slot='';private transport?:TransportEdge;private mesh?:PeerMesh;
  private http:EdgeHttp;private store:QueueStore;private initPromise?:Promise<void>;private stop=false;private poller?:AdaptivePoller;private foreground=true;private debounce?:ReturnType<typeof setTimeout>;
  private listeners=new Map<string,Set<(...args:any[])=>void>>();private statusValue:SyncStatus;
  private cache=new Map<string,string>();private etags=new Map<string,string>();private pending=new Map<string,string>();private records=new Map<string,JournalRecord>();private seenRecords=new Set<string>();private slots=new Map<string,Slot>();private sequence=0;private stateFingerprint='';
  private cursor='';private writeChain:Promise<unknown>=Promise.resolve();private readChain:Promise<unknown>=Promise.resolve();private mergeChain:Promise<unknown>=Promise.resolve();private appendChain:Promise<unknown>=Promise.resolve();private appendSaveScheduled=false;private appendBuffer:JournalRecord[]=[];private generation=0;private pairCancels=new Set<()=>void>();private legacy?:CloudflareSync<D>;private migrationStart?:number;private edgeSeen=new Set<string>();
  private pendingJoins=new Set<string>();private joinPending=false;private joinCompletion?:Promise<void>;private joinController?:AbortController;
  private wake=()=>{if(!this.stop&&this.group){this.refreshPolling(true);void this.presence().then(()=>this.flushOutbound()).catch(e=>this.fail(e));}};
  private bridges:OldEpochBridge[]=[];
  private deliveryRetries=new Map<string,ReturnType<typeof setTimeout>>();
  private lastFullPullAt=0;private discovering=0;private negotiationUntil=0;private negotiationTimer?:ReturnType<typeof setTimeout>;
  private clearDeliveryRetries(){for(const timer of this.deliveryRetries.values())clearTimeout(timer);this.deliveryRetries.clear();}
  private async deliver(ev:string,...args:any[]){try{for(const cb of this.listeners.get(ev)??[])await cb(...args);}catch(e){throw new DeliveryError(e);}}
  private retryDelivery(path:string,bytes:Uint8Array,generation:number){clearTimeout(this.deliveryRetries.get(path));this.deliveryRetries.set(path,setTimeout(async()=>{this.deliveryRetries.delete(path);if(this.stop||generation!==this.generation)return;try{await this.consume(path,bytes);}catch(e){if(e instanceof DeliveryError)this.retryDelivery(path,bytes,generation);else this.fail(e);}},1000));}
  constructor(private opts:EdgeSyncOptions<D>){
    this.localAccess=new LocalAccess(opts);
    this.http=new EdgeHttp(opts.relayUrl??DEFAULT_EDGE_URL,opts.fetch,this.observe);this.store=opts.queueStore??(typeof indexedDB!=='undefined'?new IndexedDBQueueStore('kj-edge'):new MemoryQueueStore());if(this.store===opts.secrets)throw new ProtocolError('BAD_REQUEST','Use separate queueStore');
    this.statusValue={paired:false,connection:'offline',syncing:false,devices:[],relayUrl:this.http.origin,transport:'offline'};
  }
  private emit(ev:string,...args:any[]){for(const cb of this.listeners.get(ev)??[])cb(...args);}
  on(ev:'status',cb:(status:SyncStatus)=>void):()=>void;
  on(ev:'removed',cb:()=>void):()=>void;
  on(ev:string,cb:(...args:any[])=>void){let set=this.listeners.get(ev);if(!set)this.listeners.set(ev,set=new Set());set.add(cb);return()=>set!.delete(cb);}
  status(){return structuredClone(this.statusValue);}
  /** Auxiliary fallback for a single context. Never call inside raw callbacks. */
  runExclusive<T>(task:()=>Promise<T>){return this.localAccess.exclusive(task);}
  private update(extra:Partial<SyncStatus>={}){
    this.statusValue={...this.statusValue,...extra};if(this.opts.directOnly&&!this.mesh?.connectedSlots().length)this.statusValue.transport='offline';
    this.statusValue={...this.statusValue,paired:!!this.group&&!this.joinPending,epoch:this.group?.epoch,devices:(this.group?.members??[]).map(m=>({...m,self:m.deviceId===this.ident?.deviceId,joining:m.deviceId!==this.ident?.deviceId&&this.pendingJoins.has(m.deviceId),online:this.pendingJoins.has(m.deviceId)?false:m.deviceId===this.ident?.deviceId?this.statusValue.connection==='online':Date.now()-(this.presenceSeen.get(m.deviceId)??0)<180000||!!this.mesh?.connectedSlots().some(s=>this.memberSlots.get(s)===m.deviceId),transport:m.deviceId===this.ident?.deviceId?this.statusValue.transport:this.mesh?.connectedSlots().some(s=>this.memberSlots.get(s)===m.deviceId)?'direct':this.opts.directOnly?'offline':'relay'}))};
    this.emit('status',this.status());
    this.refreshPolling();
  }
  private pollInput():PollInput {
    const connected=this.mesh?.connectedSlots()??[], online=(this.group?.members??[]).filter(m=>m.deviceId!==this.ident?.deviceId&&(Date.now()-(this.presenceSeen.get(m.deviceId)??0)<180000||connected.some(s=>this.memberSlots.get(s)===m.deviceId))).length;
    return {foreground:this.foreground,android:this.opts.clientPlatform==='android'||(this.opts.clientPlatform===undefined&&(/android/i.test(this.group?.platform??'')||typeof navigator!=='undefined'&&/android/i.test(navigator.userAgent))),pending:this.appendBuffer.length>0||this.pending.size>0,online,connected:connected.length,negotiating:Date.now()<this.negotiationUntil};
  }
  private refreshPolling(immediate=false,force=false){if(!this.group||this.stop)return;const input=this.pollInput();if(this.discovering&&!force&&!immediate&&!(input.android&&!input.foreground&&!input.pending))return;this.poller?.update(input,immediate);for(const b of this.bridges)b.setForeground(input.foreground,input.android);}
  /** Call with the actual new-tab/App visibility, including before init(). */
  setForeground(visible:boolean){const resumed=visible&&!this.foreground;this.foreground=visible;this.mesh?.setForeground?.(visible,this.pollInput().android);this.refreshPolling(resumed,true);if(resumed&&this.group){void this.presence().then(()=>this.flushOutbound()).catch(e=>this.fail(e));}}
  private memberSlots=new Map<string,string>();private presenceSeen=new Map<string,number>();
  private fail(e:unknown){if(this.stop)return;this.update({error:e instanceof ProtocolError?e.code:'NETWORK',syncing:false});}
  init(){return this.initPromise??=this.initialize().catch(e=>{this.initPromise=undefined;throw e;});}
  private async initialize(){
    this.opts.directOnly??=await this.opts.secrets.get<boolean>('edge.directOnly')??false;
    this.ident=await this.opts.secrets.get<Identity>('identity')??await identity();await this.opts.secrets.set('identity',this.ident);
    this.group=await this.opts.secrets.get<Group>('group');this.joinPending=await this.opts.secrets.get<boolean>('edge.joinPending')??false;this.pendingJoins=new Set(await this.opts.secrets.get<string[]>('edge.pendingJoins')??[]);
    if(this.group){
      const prior=await this.opts.secrets.get<{origin:string;started:number;done?:boolean}>('edge.migration');
      const legacyOrigin=await this.opts.secrets.get<string>('relayUrl');
      if(!this.opts.directOnly&&this.opts.legacyMigration!==false&&(!prior||!prior.done)&&(!legacyOrigin||legacyOrigin.includes('kongjing.inc.re')||prior)){
        this.migrationStart=prior?.started??Date.now();
        if(Date.now()-this.migrationStart<7*86400000){
          let oldGroup=this.group;const secrets:SecretStore={get:async<T>(key:string)=>(key==='relayUrl'?(this.opts.legacyUrl??'https://kongjing.inc.re'):key==='group'?structuredClone(oldGroup):await this.opts.secrets.get(key)) as T,set:async(key,value)=>{if(key==='group')oldGroup=value as Group;else if(key!=='relayUrl')await this.opts.secrets.set(key,value);},delete:async key=>{if(key!=='group'&&key!=='relayUrl')await this.opts.secrets.delete(key);}};
          this.legacy=new CloudflareSync({...this.opts,withLocalLock:task=>this.localAccess.exclusive(task),relayUrl:this.opts.legacyUrl??'https://kongjing.inc.re',secrets,queueStore:new MemoryQueueStore()});
          this.legacy.onJournal(records=>{for(const r of records)if(r.dev===this.ident.deviceId&&!this.records.has(r.id)&&!this.appendBuffer.some(x=>x.id===r.id)){this.appendBuffer.push(r);this.sequence=Math.max(this.sequence,r.seq);}if(this.keys)void this.publishQueue().catch(e=>this.fail(e));});
          this.legacy.onSlots(slots=>{const own=slots.find(s=>s.dev===this.ident.deviceId);if(own&&this.keys&&this.slot)void this.publish('d/'+this.slot+'/tabs',own).catch(e=>this.fail(e));});
          await this.legacy.init();this.group=oldGroup;
        }
        await this.opts.secrets.set('edge.migration',{origin:this.http.origin,started:this.migrationStart,done:!this.legacy});
      }
      if(this.joinPending)await this.retryJoin();else await this.activate(this.group,true);
    }
    await this.startBridges();globalThis.addEventListener?.('online',this.wake);
  }
  private async startBridges(){for(const b of this.bridges)b.dispose();this.bridges=[];const active=(await this.opts.secrets.get<RotationBridgeData[]>('edge.rotationBridges')??[]).filter(b=>b.expiresAt>Date.now());await this.opts.secrets.set('edge.rotationBridges',active);if(this.opts.disablePeer)return;for(const data of active){const bridge=new OldEpochBridge(data,{url:this.http.origin,fetch:this.opts.fetch,rtc:this.opts.rtc,iceServers:this.opts.iceServers,turn:this.opts.turn,observer:this.observe});this.bridges.push(bridge);const input=this.pollInput();bridge.setForeground(input.foreground,input.android);await bridge.start();}}
  private async persistPendingJoins(){await this.opts.secrets.set('edge.pendingJoins',[...this.pendingJoins]);}
  private async persist(){if(this.group)await this.opts.secrets.set('group',this.group);else await this.opts.secrets.delete('group');}
  private async proof(purpose:'group'|'pair'){
    for(let attempt=0;attempt<3;attempt++){const c=await(await this.http.request('/pow?purpose='+purpose)).json();try{return await solvePowWorker(c,this.opts.powWorkerUrl);}catch(e){if(!(e instanceof Error)||e.message!=='EXPIRED'||attempt===2)throw e;}}throw new ProtocolError('EXPIRED');
  }
  private async createRoom(keys:Keys){
    // Probe idempotent initialization before paying PoW. A missing room responds 428.
    try{await this.http.create(keys.roomId,keys.roomToken);}catch(e){if(!(e instanceof ProtocolError)||e.code!=='POW_REQUIRED')throw e;await this.http.create(keys.roomId,keys.roomToken,await this.proof('group'));}
  }
  async createGroup(name:string,platform:string){await this.init();if(this.group)throw new ProtocolError('CONFLICT');if(!labels(name,platform))throw new ProtocolError('BAD_REQUEST');
    const gk=b64url(random(32)),member:Member={deviceId:this.ident.deviceId,pub:this.ident.pub,name,platform,joinedAt:Date.now(),addedBy:this.ident.deviceId};
    await this.opts.secrets.set('edge.migration',{origin:this.http.origin,started:Date.now(),done:true});await this.activate({gk,epoch:1,members:[member],rev:0,name,platform},true);
  }
  /** Resume welcome credentials after transient failures, including across restart. */
  retryJoin():Promise<void>{
    if(this.joinCompletion)return this.joinCompletion;
    if(!this.group||!this.joinPending||this.stop)return Promise.reject(new ProtocolError('CONFLICT'));
    const controller=this.joinController=new AbortController();
    this.update({joinPhase:'completing',connection:'connecting',syncing:true,error:undefined});
    const completion=(async()=>{
      try{
        await this.activate(this.group!,false,joinRetrier(controller.signal));
        if(controller.signal.aborted)throw new ProtocolError('CANCELLED');
        await this.opts.secrets.delete('edge.joinPending');this.joinPending=false;
        this.update({joinPhase:undefined,syncing:false,error:undefined});
      }catch(e){
        this.poller?.dispose();this.poller=undefined;this.mesh?.dispose();this.mesh=undefined;
        this.update({joinPhase:'failed',connection:'offline',transport:'offline',syncing:false,error:e instanceof ProtocolError?e.code:'NETWORK'});throw e;
      }finally{this.joinCompletion=undefined;if(this.joinController===controller)this.joinController=undefined;}
    })();
    this.joinCompletion=completion;return completion;
  }
  private async activate(group:Group,initializeRoom:boolean,complete:<T>(task:()=>Promise<T>)=>Promise<T>=task=>task()){
    clearTimeout(this.negotiationTimer);this.negotiationUntil=0;
    this.clearDeliveryRetries();this.generation++;this.poller?.dispose();this.poller=undefined;this.mesh?.dispose();this.mesh=undefined;this.group=group;this.keys=await deriveGroup(unb64(group.gk),group.epoch);this.slot=await deriveSlotId(unb64(group.gk),group.epoch,this.ident.deviceId);
    const generation=this.generation;
    this.transport=new TransportEdge(this.keys.roomId,this.keys.roomToken,this.slot,{url:this.http.origin,fetch:this.opts.fetch,observer:this.observe});this.cache.clear();this.etags.clear();this.pending.clear();this.records.clear();this.slots.clear();this.seenRecords.clear();this.cursor='';this.edgeSeen.clear();this.stateFingerprint='';
    await this.persist();await this.opts.secrets.set('edge.origin',this.http.origin);
    if(initializeRoom)await this.createRoom(this.keys);
    await this.restore();if(generation!==this.generation)return;await this.setupMesh();
    await complete(()=>this.initialPull());if(generation!==this.generation||!this.group)return;await complete(()=>this.publishState());await complete(()=>this.flushPending());await complete(()=>this.presence());if(generation!==this.generation)return;
    this.update({connection:'online',transport:'relay',error:undefined});
    this.poller=new AdaptivePoller({check:signal=>this.readSerial(async()=>{if(!signal.aborted&&generation===this.generation)await this.checkRoom(signal);}),watch:signal=>this.watchOnce(generation,signal),presence:async()=>{await this.presence();this.update();},error:e=>{this.fail(e);this.update({connection:'offline',transport:this.mesh?.connectedSlots().length?'direct':'offline'});return e instanceof ProtocolError&&e.retryAfter?e.retryAfter*1000:2000;}});
    this.poller.start(this.pollInput());
  }
  private async setupMesh(){
    this.memberSlots.clear();if(!this.group||!this.keys)return;for(const m of this.group.members)this.memberSlots.set(await deriveSlotId(unb64(this.group.gk),this.group.epoch,m.deviceId),m.deviceId);
    if(this.mesh){this.mesh.ensure([...this.memberSlots.keys()]);return;}
    if(this.opts.disablePeer||(!this.opts.rtc&&typeof RTCPeerConnection==='undefined'))return;
    const keys=this.keys;
    this.mesh=new PeerMesh({roomId:keys.roomId,encKey:keys.encKey,slot:this.slot,turn:this.opts.turn,rtc:this.opts.rtc,iceServers:this.opts.iceServers,
      signal:async(to,signal)=>{if(this.keys!==keys)return;const path='sig/'+to+'/'+Date.now()+'-'+b64url(random(8));await this.transport!.put(path,await this.seal(path,{from:this.slot,signal}));},
      receive:async(from,bytes)=>{if(this.keys!==keys||!this.memberSlots.has(from))return;const frame=JSON.parse(text(bytes));if(frame.t==='objects'&&Array.isArray(frame.objects)){for(const o of frame.objects){if(!o||typeof o.key!=='string'||typeof o.bytes!=='string'||!this.allowedPeerObject(o.key,from))throw new ProtocolError('UNAUTHORIZED');const b=unb64(o.bytes);clearTimeout(this.deliveryRetries.get(o.key));this.deliveryRetries.delete(o.key);this.cache.set(o.key,o.bytes);await this.saveCache();try{await this.consume(o.key,b);}catch(e){if(e instanceof DeliveryError)this.retryDelivery(o.key,b,this.generation);else throw e;}}await this.saveCache();}},
      status:(slot,connected)=>{if(this.keys!==keys)return;const dev=this.memberSlots.get(slot);if(dev)this.presenceSeen.set(dev,Date.now());this.update({transport:this.mesh?.connectedSlots().length?'direct':this.statusValue.connection==='online'?'relay':'offline'});if(connected)void this.replay(slot).catch(e=>this.fail(e));else if(!this.stop&&(!this.pollInput().android||this.foreground)){const generation=this.generation;void this.readSerial(async()=>{if(generation===this.generation&&!this.stop)await this.pullAll();}).catch(e=>this.fail(e));}},
    });this.mesh.setForeground(this.foreground,this.pollInput().android);this.mesh.ensure([...this.memberSlots.keys()]);
  }
  private allowedPeerObject(key:string,from:string){return key.startsWith('d/'+from+'/')||/^b\/[\w-]{22}$/.test(key);}
  private async replay(slot:string){for(const[key,bytes]of this.cache)if(key.startsWith('d/'+this.slot+'/')||key.startsWith('b/'))await this.mesh?.send(slot,utf8(JSON.stringify({t:'objects',objects:[{key,bytes}]})));if(this.opts.directOnly&&this.allPeersConnected()){this.pending.clear();await this.saveCache();this.refreshPolling();}}
  private allPeersConnected(){const count=(this.group?.members.length??1)-1;return count>0&&(this.mesh?.connectedSlots().length??0)>=count;}
  private async presence(){if(this.group&&!this.opts.directOnly)await this.publish('d/'+this.slot+'/presence',{dev:this.ident.deviceId,name:this.group.name,platform:this.group.platform,at:Date.now()});this.poller?.announced();this.maybeFinishMigration();}
  private maybeFinishMigration(){if(this.legacy&&this.group&&(Date.now()-(this.migrationStart??0)>=7*86400000||this.group.members.every(m=>m.deviceId===this.ident.deviceId||this.edgeSeen.has(m.deviceId)))){this.legacy.dispose();this.legacy=undefined;void this.opts.secrets.set('edge.migration',{origin:this.http.origin,started:this.migrationStart,done:true});}}
  private async seal(path:string,value:unknown){return envelopeBytes(await sealContinuity(this.keys!.encKey,'kj/obj/'+this.keys!.roomId+'/'+path,utf8(JSON.stringify(value))));}
  private async open(path:string,bytes:Uint8Array){return JSON.parse(text(await openContinuity(this.keys!.encKey,'kj/obj/'+this.keys!.roomId+'/'+path,bytesEnvelope(bytes))));}
  private queueKey(){return 'edge.cache/'+this.ident.deviceId+'/'+this.keys!.roomId;}
  private async saveCache(){if(!this.keys)return;await this.store.set(this.queueKey(),{cache:[...this.cache],pending:[...this.pending],cursor:this.cursor,etags:[...this.etags],sequence:this.sequence});}
  private async restore(){const stored=await this.store.get<any>(this.queueKey());if(!stored)return;this.cache=new Map(stored.cache??[]);this.pending=new Map(stored.pending??[]);this.cursor=stored.cursor??'';this.etags=new Map(stored.etags??[]);this.sequence=stored.sequence??0;for(const[path,bytes]of this.cache)await this.consume(path,unb64(bytes));}
  private readSerial<T>(fn:()=>Promise<T>){const run=this.readChain.then(fn);this.readChain=run.catch(()=>{});return run;}
  private writeSerial<T>(fn:()=>Promise<T>){const run=this.writeChain.then(fn);this.writeChain=run.catch(()=>{});return run;}
  private async publish(path:string,value:unknown,raw?:Uint8Array){
    const bytes=raw??await this.seal(path,value),encoded=b64url(bytes);this.cache.set(path,encoded);this.pending.set(path,encoded);await this.saveCache();
    await this.mesh?.broadcast(utf8(JSON.stringify({t:'objects',objects:[{key:path,bytes:encoded}]})));
    if(this.opts.directOnly&&this.allPeersConnected()&&this.pending.get(path)===encoded){this.pending.delete(path);await this.saveCache();}
    if(!this.opts.directOnly){await this.transport!.put(path,bytes);if(this.pending.get(path)===encoded)this.pending.delete(path);await this.saveCache();}
  }
  private async publishState(){if(!this.group||!this.keys)return;const data=await this.localAccess.exclusive(async()=>structuredClone(await this.opts.loadLocal())),fingerprint=JSON.stringify({epoch:this.group.epoch,members:this.group.members,data});if(this.stateFingerprint===fingerprint)return;const snapshot={v:1 as const,writer:this.ident.deviceId,at:Date.now(),group:{epoch:this.group.epoch,members:this.group.members},data};await this.publish('d/'+this.slot+'/state',null,await sealSnapshot(this.keys.encKey,this.keys.roomId,snapshot));this.stateFingerprint=fingerprint;}
  private async flushPending(){if(!this.transport)return;for(const[path,bytes]of this.pending){if(this.opts.directOnly){await this.mesh?.broadcast(utf8(JSON.stringify({t:'objects',objects:[{key:path,bytes}]})));if(this.allPeersConnected()&&this.pending.get(path)===bytes)this.pending.delete(path);continue;}await this.transport.put(path,unb64(bytes));if(this.pending.get(path)===bytes)this.pending.delete(path);}await this.saveCache();}
  private async consume(path:string,bytes:Uint8Array){
    if(!this.group||!this.keys)return;
    if(path.startsWith('sig/')){if(!path.startsWith('sig/'+this.slot+'/'))return;const m=await this.open(path,bytes);if(this.memberSlots.has(m.from))await this.mesh?.acceptSignal(m.from,m.signal as PeerSignal);await this.transport!.delete(path);return;}
    if(path.endsWith('/state')){const p=await openSnapshot<D>(this.keys.encKey,this.keys.roomId,bytes);if(p.group.epoch!==this.group.epoch||!this.group.members.some(m=>m.deviceId===p.writer)||await deriveSlotId(unb64(this.group.gk),this.group.epoch,p.writer)!==path.split('/')[1])throw new ProtocolError('UNAUTHORIZED');
      const merge=this.mergeChain.then(()=>this.localAccess.merge(p.data));this.mergeChain=merge.catch(()=>{});await merge;await this.acceptMembers(p.group.members,p.writer);if(this.pendingJoins.delete(p.writer)){await this.persistPendingJoins();this.presenceSeen.set(p.writer,Date.now());}this.edgeSeen.add(p.writer);this.legacy?.notifyLocalChange();
    }else if(path.startsWith('d/')){
      const m=await this.open(path,bytes);if(path.endsWith('/presence')){if(Date.now()-m.at<180000){this.edgeSeen.add(m.dev);this.presenceSeen.set(m.dev,m.at);}}
      else if(path.endsWith('/tabs')){const list=Array.isArray(m)?m:[m];for(const item of list)if(item.dev&&Date.now()-item.at<30*86400000)this.slots.set(item.dev,item);this.emit('slots',await this.getSlots());}
      else if(path.includes('/h/')||path.includes('/ev/')){if(m.leave){const leaving=m.leave.deviceId;if(this.group.members.some(x=>x.deviceId===leaving)&&this.memberSlots.get(path.split('/')[1])===leaving){const owner=this.group.members.filter(x=>x.deviceId!==leaving).map(x=>x.deviceId).sort()[0];if(owner===this.ident.deviceId&&!this.leaveTimers.has(leaving)){const timer=setTimeout(()=>{this.leaveTimers.delete(leaving);if(this.group?.members.some(x=>x.deviceId===leaving))void this.removeDevice(leaving).catch(e=>this.fail(e));},5000);this.leaveTimers.set(leaving,timer);}}return;}if(m.rotate){await this.followRotation(m.rotate);return;}const records=m.records??[];const fresh:JournalRecord[]=[];for(const r of records){if(typeof r.id!=='string'||!/^[\w-]{22}$/.test(r.id)||typeof r.dev!=='string'||!/^[\w-]{16}$/.test(r.dev)||Date.now()-r.at>90*86400000)continue;this.records.set(r.id,r);if(!this.seenRecords.has(r.id))fresh.push(r);}
        for(const r of fresh)if(r.t==='snd'&&r.to===this.ident.deviceId&&Date.now()-r.at<7*86400000&&!this.acknowledged(r.id))await this.deliver('incoming',{id:r.id,from:r.dev,at:r.at,k:r.k,u:r.u,ti:r.ti,tx:r.tx} as Incoming);
        if(fresh.length)await this.deliver('journal',fresh.sort((a,b)=>a.at-b.at||a.dev.localeCompare(b.dev)||a.seq-b.seq),{replay:true});for(const r of fresh)this.seenRecords.add(r.id);}
    }
    this.update({lastSyncAt:Date.now()});this.maybeFinishMigration();
  }
  private acknowledged(id:string){return [...this.records.values()].some(r=>r.t==='ack'&&r.ref===id);}
  private async acceptMembers(members:Member[],writer:string){if(!this.group||!Array.isArray(members)||members.length>10)return;const old=new Map(this.group.members.map(m=>[m.deviceId,m]));let changed=false;
    for(const m of members){if(!labels(m.name,m.platform)||typeof m.pub!=='string'||b64url(await sha256(unb64(m.pub))).slice(0,16)!==m.deviceId)continue;if(!old.has(m.deviceId)&&m.addedBy===writer){old.set(m.deviceId,m);changed=true;}}
    if(changed){for(const m of old.values())if(!this.group.members.some(p=>p.deviceId===m.deviceId)){this.pendingJoins.add(m.deviceId);this.presenceSeen.set(m.deviceId,Date.now());}this.group.members=[...old.values()];await this.persistPendingJoins();await this.persist();await this.legacy?.importMigrationMembers(this.group.members);this.memberSlots.clear();for(const m of this.group.members)this.memberSlots.set(await deriveSlotId(unb64(this.group.gk),this.group.epoch,m.deviceId),m.deviceId);this.mesh?.ensure([...this.memberSlots.keys()]);this.refreshPolling();}
  }
  private async checkRoom(signal:AbortSignal){
    if(this.poller?.current()?.mode!=='direct'){await this.pullAll(signal);return;}
    const generation=this.generation,list=await this.transport!.list('',signal);if(signal.aborted||generation!==this.generation)return;
    const full=Date.now()-this.lastFullPullAt>=FULL_RECONCILE_MS;
    const connected=new Set(this.mesh?.connectedSlots()),before=new Set([...this.presenceSeen].filter(([,at])=>Date.now()-at<180000).map(([dev])=>dev));
    const discovery=list.objects.filter(o=>o.key.startsWith('sig/'+this.slot+'/')||o.key.endsWith('/presence')&&!connected.has(o.key.split('/')[1])&&this.etags.get(o.key)!==o.etag);
    // Defer topology-driven rescheduling until this list has been reconciled.
    // Explicit visibility changes still cancel immediately, including hidden Android.
    this.discovering++;
    try{
      if(full)await this.applyList(list,signal);else await this.readObjects(discovery,signal);if(signal.aborted||generation!==this.generation)return;
      const newcomers=[...this.presenceSeen].filter(([dev,at])=>dev!==this.ident.deviceId&&!before.has(dev)&&Date.now()-at<180000);
      for(const[dev]of newcomers){const slot=[...this.memberSlots].find(([,id])=>id===dev)?.[0];if(slot)await this.mesh?.discover(slot);}
      if(discovery.some(o=>o.key.startsWith('sig/'))||newcomers.length){
        // An expired original offer may require a fresh offer/answer roundtrip.
        // Background discovery must finish that exchange now, rather than wait
        // another 60s for the answer. Bound this exception to ten seconds;
        // Android suspension and the normal background failure policy still win.
        if(!this.foreground){this.negotiationUntil=Date.now()+10000;clearTimeout(this.negotiationTimer);this.negotiationTimer=setTimeout(()=>this.refreshPolling(),10000);}
        if(!full)await this.applyList({...list,objects:list.objects.filter(o=>!o.key.startsWith('sig/'+this.slot+'/'))},signal);
      }
      else if(!full)this.update({connection:'online',error:undefined});
      // Discovery-only lists must not advance the full-data cursor: an unseen
      // state/history etag still needs fetching on fallback or 5-minute repair.
    }finally{this.discovering--;this.refreshPolling();}
  }
  private async pullAll(signal?:AbortSignal){if(!this.transport)return;const generation=this.generation,list=await this.transport.list('',signal);if(signal?.aborted||generation!==this.generation)return;await this.applyList(list,signal);}
  private async applyList(list:{objects:ObjectInfo[];cursor:string},signal?:AbortSignal){const generation=this.generation;
    // Rotation is processed first, so an offline member never republishes stale state.
    const objects=[...list.objects].sort((a,b)=>Number(b.key.includes('/ev/'))-Number(a.key.includes('/ev/')));
    await this.readObjects(objects.filter(o=>this.etags.get(o.key)!==o.etag||o.key.startsWith('sig/')),signal);
    if(signal?.aborted||generation!==this.generation)return;
    this.cursor=list.cursor;this.lastFullPullAt=Date.now();await this.saveCache();
    this.update({connection:'online',error:undefined});
  }
  private async initialPull(){
    const transport=this.transport!,generation=this.generation;
    // A nonexistent cursor marker guarantees an immediate first watch, even in
    // an empty room. It avoids HEAD metadata calls before downloading data.
    const response=await transport.watch(b64url(utf8(JSON.stringify({__initial__:'1'}))));
    if(generation!==this.generation)return;const tags=response.tags??JSON.parse(text(unb64(response.cursor)));
    await this.readObjects(Object.entries(tags).map(([key,etag])=>({key,etag:String(etag),size:0})));if(generation!==this.generation)return;
    this.cursor=response.cursor;this.lastFullPullAt=Date.now();await this.saveCache();
  }
  private async readObjects(objects:ObjectInfo[],signal?:AbortSignal){
    const generation=this.generation,transport=this.transport!;
    // This slot has exactly one writer. Its local cache already contains its own writes.
    for(const o of objects)if(o.key.startsWith('d/'+this.slot+'/')&&this.cache.has(o.key))this.etags.set(o.key,o.etag);
    const priority=(key:string)=>key.includes('/ev/')?0:key.endsWith('/state')?1:key.startsWith('sig/')?3:2;
    const wanted=objects.filter(o=>!(o.key.startsWith('d/'+this.slot+'/')&&this.cache.has(o.key))&&(!this.opts.directOnly||o.key.startsWith('sig/'+this.slot+'/'))&&(!o.key.startsWith('sig/')||o.key.startsWith('sig/'+this.slot+'/'))).sort((a,b)=>priority(a.key)-priority(b.key));
    type Result={bytes?:Uint8Array|null;error?:unknown};
    const tasks=wanted.map(()=>{let resolve!:(r:Result)=>void;return{promise:new Promise<Result>(r=>resolve=r),resolve:(r:Result)=>resolve(r)};});let next=0,halt=false;
    // Fetch with bounded concurrency, but deliver ready state immediately. A
    // slow/deleted ICE object must not hold an already-downloaded snapshot.
    const workers=Promise.all(Array.from({length:Math.min(6,wanted.length)},async()=>{while(next<wanted.length&&!halt&&!signal?.aborted&&generation===this.generation){const i=next++;try{tasks[i].resolve({bytes:await transport.get(wanted[i].key,signal)});}catch(error){tasks[i].resolve({error});}}})).then(()=>{for(let i=next;i<tasks.length;i++)tasks[i].resolve({});});
    try{for(let i=0;i<wanted.length;i++){if(signal?.aborted||generation!==this.generation)return;const o=wanted[i],result=await tasks[i].promise;if(signal?.aborted||generation!==this.generation)return;if(result.error)throw result.error;const bytes=result.bytes;if(!bytes){this.cache.delete(o.key);this.etags.delete(o.key);if(o.key.endsWith('/tabs')){const dev=this.memberSlots.get(o.key.split('/')[1]);if(dev)this.slots.delete(dev);}continue;}await this.consume(o.key,bytes);if(generation!==this.generation)return;if(!o.key.startsWith('sig/'))this.cache.set(o.key,b64url(bytes));this.etags.set(o.key,o.etag);}}
    finally{halt=true;await workers;}
  }
  private async watchOnce(generation:number,signal:AbortSignal){
    const transport=this.transport;if(!transport)return;
    const changes=await transport.watch(this.cursor,signal);if(signal.aborted||generation!==this.generation)return;
    if(changes.changed.length||changes.reset){const tags=changes.tags??JSON.parse(text(unb64(changes.cursor)));
      // A hash mismatch supplies the full current tag set. Reconcile locally to
      // skip unchanged downloads and detect deleted objects without a huge URL.
      const changed=changes.reset?[...new Set([...Object.keys(tags),...this.etags.keys()])].filter(key=>this.etags.get(key)!==tags[key]||key.startsWith('sig/')):changes.changed;
      await this.readSerial(async()=>{if(!signal.aborted&&generation===this.generation)await this.readObjects(changed.map(key=>({key,etag:tags[key]??'',size:0})),signal);});}
    if(signal.aborted||generation!==this.generation)return;this.cursor=changes.cursor;await this.saveCache();this.update({connection:'online',transport:this.mesh?.connectedSlots().length?'direct':'relay',error:undefined});
  }
  private async flushOutbound(){await this.init();if(!this.group)return;await this.appendChain;await this.writeSerial(async()=>{await this.publishState();await this.flushAppend();await this.flushPending();this.refreshPolling();});}
  private async pushRealtime(){if(!this.group||!this.keys||!this.mesh?.connectedSlots().length)return;const bytes=await sealSnapshot(this.keys.encKey,this.keys.roomId,{v:1,writer:this.ident.deviceId,at:Date.now(),group:{epoch:this.group.epoch,members:this.group.members},data:await this.localAccess.exclusive(async()=>structuredClone(await this.opts.loadLocal()))});await this.mesh.broadcast(utf8(JSON.stringify({t:'objects',objects:[{key:'d/'+this.slot+'/state',bytes:b64url(bytes)}]})));}
  notifyLocalChange(){clearTimeout(this.debounce);this.debounce=setTimeout(()=>{void this.pushRealtime().then(()=>this.flushOutbound()).catch(e=>this.fail(e));},150);this.legacy?.notifyLocalChange();}
  async syncNow(){await this.init();if(!this.group)return;await this.appendChain;await this.writeSerial(async()=>{this.update({syncing:true});await this.publishState();await this.flushAppend();await this.flushPending();await this.readSerial(()=>this.pullAll());if(!this.group)return;this.update({syncing:false,lastSyncAt:Date.now(),connection:'online',transport:this.mesh?.connectedSlots().length?'direct':'relay'});});if(this.legacy)await this.legacy.syncNow();}
  journalAppend(t:string,payload:object){if(!this.group)throw new ProtocolError('CONFLICT');const r={...payload,id:b64url(random(16)),seq:++this.sequence,t,dev:this.ident.deviceId,at:Date.now()} as JournalRecord;this.appendBuffer.push(r);this.refreshPolling();if(!this.appendSaveScheduled){this.appendSaveScheduled=true;this.appendChain=this.appendChain.then(async()=>{this.appendSaveScheduled=false;await this.publishQueue();}).catch(e=>this.fail(e));}clearTimeout(this.debounce);this.debounce=setTimeout(()=>{void this.flushOutbound().catch(e=>this.fail(e));},250);this.legacy?.journalAppend(t,payload);return r.id;}
  private async publishQueue(){if(!this.keys)return;await this.store.set(this.queueKey()+'/append',b64url(await this.seal('local/outbox',this.appendBuffer)));}
  private async flushAppend(){if(!this.group)return;const saved=await this.store.get<string>(this.queueKey()+'/append');if(!this.appendBuffer.length&&saved)this.appendBuffer=await this.open('local/outbox',unb64(saved));if(!this.appendBuffer.length)return;
    const records=[...this.appendBuffer],buckets=new Map<string,JournalRecord[]>();for(const r of records){const path=r.t==='hv'?'d/'+this.slot+'/h/'+new Date(r.at).toISOString().slice(0,10).replaceAll('-',''):'d/'+this.slot+'/ev/'+Date.now()+'-'+records[0].id;const list=buckets.get(path)??[];list.push(r);buckets.set(path,list);}
    for(const[path,rows]of buckets){let previous:JournalRecord[]=[];const b=this.cache.get(path);if(b)previous=(await this.open(path,unb64(b))).records??[];const combined=[...new Map([...previous,...rows].map(r=>[r.id,r])).values()].sort((a,b)=>a.seq-b.seq);const bytes=await this.seal(path,{records:combined});if(bytes.length>(path.includes('/h/')?262144:65536))throw new ProtocolError('PAYLOAD_TOO_LARGE');await this.publish(path,null,bytes);await this.consume(path,bytes);}
    const ids=new Set(records.map(r=>r.id));this.appendBuffer=this.appendBuffer.filter(r=>!ids.has(r.id));await this.publishQueue();
  }
  onJournal(cb:(records:JournalRecord[],info:{replay:boolean})=>unknown){let set=this.listeners.get('journal');if(!set)this.listeners.set('journal',set=new Set());set.add(cb);return()=>set!.delete(cb);}
  journalCursor(){return this.sequence;}
  async putSlot(payload:object){await this.init();if(!this.group)throw new ProtocolError('CONFLICT');const v={dev:this.ident.deviceId,at:Date.now(),payload};this.slots.set(v.dev,v);await this.writeSerial(()=>this.publish('d/'+this.slot+'/tabs',v));await this.legacy?.putSlot(payload);}
  async getSlots(){return [...this.slots.values()].filter(s=>Date.now()-s.at<30*86400000);}
  onSlots(cb:(slots:Slot[])=>void){let set=this.listeners.get('slots');if(!set)this.listeners.set('slots',set=new Set());set.add(cb);return()=>set!.delete(cb);}
  async deleteSlot(){if(!this.group)return;this.slots.delete(this.ident.deviceId);const path='d/'+this.slot+'/tabs';this.cache.delete(path);this.pending.delete(path);if(!this.opts.directOnly)await this.transport!.delete(path);await this.saveCache();await this.legacy?.deleteSlot();}
  async putBlob(bytes:Uint8Array,mime:string){await this.init();if(!this.group)throw new ProtocolError('CONFLICT');const id=b64url(random(16)),path='b/'+id,wire=await this.seal(path,{mime,bytes:b64url(bytes)});if(wire.length>3145728)throw new ProtocolError('PAYLOAD_TOO_LARGE');await this.writeSerial(()=>this.publish(path,null,wire));return id;}
  async getBlob(id:string){if(!/^[\w-]{22}$/.test(id)||!this.group)throw new ProtocolError('BAD_REQUEST');const path='b/'+id,bytes=this.cache.has(path)?unb64(this.cache.get(path)!):this.opts.directOnly?null:await this.transport!.get(path);if(!bytes)throw new ProtocolError('NOT_FOUND');const p=await this.open(path,bytes);return{bytes:unb64(p.bytes),mime:p.mime};}
  async deleteBlob(id:string){if(!/^[\w-]{22}$/.test(id))throw new ProtocolError('BAD_REQUEST');const p='b/'+id;this.cache.delete(p);this.pending.delete(p);if(!this.opts.directOnly)await this.transport?.delete(p);await this.saveCache();}
  sendTo(deviceId:string,item:{k:'url'|'text';u?:string;ti?:string;tx?:string}){if(!this.group?.members.some(m=>m.deviceId===deviceId))throw new ProtocolError('BAD_REQUEST');return this.journalAppend('snd',{...item,to:deviceId});}
  onIncoming(cb:(item:Incoming)=>unknown){let set=this.listeners.get('incoming');if(!set)this.listeners.set('incoming',set=new Set());set.add(cb);return()=>set!.delete(cb);}
  ack(id:string){if(!/^[\w-]{22}$/.test(id))throw new ProtocolError('BAD_REQUEST');this.journalAppend('ack',{ref:id});}
  async setDirectOnly(enabled:boolean){await this.init();this.opts.directOnly=enabled;if(enabled){this.legacy?.dispose();this.legacy=undefined;}if(enabled&&this.transport){for(const o of(await this.transport.list('d/'+this.slot+'/')).objects)await this.transport.delete(o.key);for(const key of this.cache.keys())if(key.startsWith('b/'))await this.transport.delete(key);}else if(this.group){for(const[path,bytes]of this.cache)if(path.startsWith('d/'+this.slot+'/')||path.startsWith('b/'))this.pending.set(path,bytes);await this.flushPending();}await this.opts.secrets.set('edge.directOnly',enabled);}
  async setRelayUrl(origin:string){if(this.group)throw new ProtocolError('RELAY_CHANGE_REQUIRES_REPAIR');this.http=new EdgeHttp(origin,this.opts.fetch,this.observe);this.update({relayUrl:this.http.origin});}
  private leaveTimers=new Map<string,ReturnType<typeof setTimeout>>();
  async leave(){if(this.group){const path='d/'+this.slot+'/ev/'+Date.now()+'-'+b64url(random(8));await this.publish(path,{leave:{deviceId:this.ident.deviceId,at:Date.now()}}).catch(()=>{});await this.legacy?.leave().catch(()=>{});}await this.clearGroup();}
  private async clearGroup(){this.joinController?.abort();this.pendingJoins.clear();await this.opts.secrets.delete('edge.pendingJoins');this.joinPending=false;await this.opts.secrets.delete('edge.joinPending');clearTimeout(this.negotiationTimer);this.negotiationUntil=0;this.clearDeliveryRetries();this.generation++;this.poller?.dispose();this.mesh?.dispose();this.mesh=undefined;for(const b of this.bridges)b.dispose();this.bridges=[];await this.opts.secrets.delete('edge.rotationBridges');this.legacy?.dispose();this.legacy=undefined;this.group=undefined;this.keys=undefined;this.transport=undefined;await this.persist();this.update({connection:'offline',transport:'offline',joinPhase:undefined});}
  async removeDevice(deviceId:string){await this.init();if(!this.group||deviceId===this.ident.deviceId||!this.group.members.some(m=>m.deviceId===deviceId))throw new ProtocolError('BAD_REQUEST');await this.syncNow();const old=this.group,keys=this.keys!,transport=this.transport!,slot=this.slot,cache=new Map(this.cache),members=old.members.filter(m=>m.deviceId!==deviceId),next={...old,gk:b64url(random(32)),epoch:old.epoch+1,members};
    // Reserve the new room before publishing a forward or changing any credentials.
    // A quota/network failure must leave every member on the working old epoch.
    await this.createRoom(await deriveGroup(unb64(next.gk),next.epoch));
    const wraps:Record<string,string>={};for(const m of members)wraps[m.deviceId]=await wrapKey(this.ident.privateKey,m.pub,m.deviceId,next.epoch,{gk:next.gk,epoch:next.epoch,members});
    const rotate={from:this.ident.deviceId,pub:this.ident.pub,epoch:next.epoch,wraps};const forwardPath='d/'+slot+'/ev/'+Date.now()+'-'+b64url(random(8)),forward=await this.seal(forwardPath,{rotate});
    // Same next GK is forwarded to legacy devices, so mixed-version groups do not split.
    if(this.legacy)await this.legacy.removeDevice(deviceId,{gk:unb64(next.gk),epoch:next.epoch});
    const oldMesh=this.mesh;await oldMesh?.broadcast(utf8(JSON.stringify({t:'objects',objects:[{key:forwardPath,bytes:b64url(forward)}]})));
    if(this.opts.directOnly){const bridges=await this.opts.secrets.get<RotationBridgeData[]>('edge.rotationBridges')??[];bridges.push({gk:old.gk,epoch:old.epoch,members:old.members,deviceId:this.ident.deviceId,forwardPath,forward:b64url(forward),expiresAt:Date.now()+7*86400000});await this.opts.secrets.set('edge.rotationBridges',bridges);}
    this.legacy?.dispose();this.legacy=undefined;await this.activate(next,false);
    if(this.opts.directOnly)await this.startBridges();
    // Re-encrypt retained journal, tabs and image objects. Snapshot merge was completed above.
    const dayRows=new Map<string,JournalRecord[]>(),tabs:Slot[]=[];for(const[path,encoded]of cache){if(path.includes('/h/')){const p=JSON.parse(text(await openContinuity(keys.encKey,'kj/obj/'+keys.roomId+'/'+path,bytesEnvelope(unb64(encoded)))));const day=path.split('/').at(-1)!,rows=dayRows.get(day)??[];rows.push(...(p.records??[]));dayRows.set(day,rows);}else if(path.includes('/ev/')){const p=JSON.parse(text(await openContinuity(keys.encKey,'kj/obj/'+keys.roomId+'/'+path,bytesEnvelope(unb64(encoded)))));if(!p.rotate&&p.records?.length)await this.publish('d/'+this.slot+'/ev/'+path.split('/').at(-1),p);}else if(path.endsWith('/tabs')){const p=JSON.parse(text(await openContinuity(keys.encKey,'kj/obj/'+keys.roomId+'/'+path,bytesEnvelope(unb64(encoded)))));tabs.push(...(Array.isArray(p)?p:[p]).filter((s:Slot)=>members.some(m=>m.deviceId===s.dev)));}else if(path.startsWith('b/')){const p=JSON.parse(text(await openContinuity(keys.encKey,'kj/obj/'+keys.roomId+'/'+path,bytesEnvelope(unb64(encoded)))));await this.publish(path,p);}}
    for(const[day,rows]of dayRows)await this.publish('d/'+this.slot+'/h/'+day,{records:[...new Map(rows.map(r=>[r.id,r])).values()]});if(tabs.length)await this.publish('d/'+this.slot+'/tabs',tabs);
    await this.mesh?.broadcast(utf8(JSON.stringify({t:'objects',objects:[]})));
    if(!this.opts.directOnly)await transport.put(forwardPath,forward);
    // Only the owner's old objects may be deleted. Forward remains seven days for offline peers.
    if(!this.opts.directOnly)for(const o of(await transport.list()).objects)if((o.key.startsWith('d/'+slot+'/')||o.key.startsWith('b/'))&&o.key!==forwardPath)await transport.delete(o.key);
    await this.opts.secrets.set('edge.migration',{origin:this.http.origin,started:Date.now(),done:true});
  }
  private async followRotation(rotate:any){if(!this.group||!this.keys||rotate.epoch<=this.group.epoch||!this.group.members.some(m=>m.deviceId===rotate.from&&m.pub===rotate.pub))return;const wrap=rotate.wraps?.[this.ident.deviceId];if(!wrap){await this.clearGroup();this.emit('removed');return;}const next=await unwrapKey(this.ident.privateKey,rotate.pub,this.ident.deviceId,rotate.epoch,wrap);if(next.epoch!==this.group.epoch+1||!Array.isArray(next.members)||!next.members.some((m:Member)=>m.deviceId===this.ident.deviceId))throw new ProtocolError('BAD_REQUEST');await this.activate({...this.group,...next},false);}
  async invite():Promise<InviteSession>{await this.init();if(!this.group)throw new ProtocolError('CONFLICT');const code=generatePairCode(),{room,authKey}=await pairKeys(code),created=await(await this.http.request('/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,pow:await this.proof('pair')})})).json();
    const done=deferred<Device>(),controller=new AbortController(),host=new PairMailbox(this.http,room,'host',created.hostKey,controller.signal);let session:Awaited<ReturnType<typeof pairSession>>|undefined,peer:Member|undefined,local=false,remote=false,finished=false,sending=false,info:{name:string;platform:string;sas:string}|undefined,cb:((p:NonNullable<typeof info>)=>void)|undefined;
    const fail=(e:unknown)=>{if(finished)return;finished=true;controller.abort();this.pairCancels.delete(cancel);done.reject(e);};const cancel=()=>fail(new ProtocolError('CANCELLED'));this.pairCancels.add(cancel);
    const welcome=async()=>{if(!local||!remote||!session||!peer||finished||sending)return;sending=true;try{const group=this.group!;group.members=[...group.members,peer];this.pendingJoins.add(peer.deviceId);await this.persistPendingJoins();this.presenceSeen.set(peer.deviceId,Date.now());await this.persist();await this.legacy?.importMigrationMembers(group.members);await this.setupMesh();this.refreshPolling();await this.publishState();const e=await encrypt(session.key,utf8(JSON.stringify({gk:group.gk,epoch:group.epoch,members:group.members,relay:this.http.origin})));await host.send({t:'welcome',iv:b64url(e.iv),ct:b64url(e.ct)});finished=true;controller.abort();this.pairCancels.delete(cancel);done.resolve({deviceId:peer.deviceId,name:peer.name,platform:peer.platform,online:false,joining:true,self:false});this.update();}catch(e){fail(e);}};
    void host.loop(created.expiresAt,async m=>{if(m.t==='hello-j'){if(peer||!labels(m.name,m.platform)||!await verifyMac(authKey,'J|'+m.epk+'|'+m.id+'|'+m.name+'|'+m.platform,m.mac))throw new ProtocolError('BAD_CODE');if(this.group!.members.length>=10)throw new ProtocolError('GROUP_FULL');const id=b64url(await sha256(unb64(m.id))).slice(0,16);if(this.group!.members.some(x=>x.deviceId===id))throw new ProtocolError('BAD_CODE');peer={deviceId:id,pub:m.id,name:m.name,platform:m.platform,joinedAt:Date.now(),addedBy:this.ident.deviceId};const ep=await identity();session=await pairSession(ep.privateKey,m.epk,ep.pub,m.epk,m.id);const{name,platform}=this.group!;await host.send({t:'hello-i',epk:ep.pub,name,platform,mac:await hmac(authKey,'I|'+ep.pub+'|'+m.epk+'|'+name+'|'+platform)});info={name:m.name,platform:m.platform,sas:session.sas};cb?.(info);}else if(m.t==='confirm'){remote=true;await welcome();}else if(m.t==='abort')throw new ProtocolError('CANCELLED');}).catch(e=>{if(!finished)fail(e);});
    return{code:formatPairCode(code),expiresAt:created.expiresAt,onPeer(fn){cb=fn;if(info)fn(info);},confirm:async()=>{if(!session)throw new ProtocolError('BAD_CODE');local=true;await welcome();},cancel,done:done.promise};
  }
  async join(input:string,name:string,platform:string):Promise<JoinSession>{await this.init();if(this.group)throw new ProtocolError('CONFLICT');const code=normalizePairCode(input);if(!code||!labels(name,platform))throw new ProtocolError('BAD_CODE');const{room,authKey}=await pairKeys(code),ep=await identity(),controller=new AbortController(),guest=new PairMailbox(this.http,room,'guest',b64url(random(32)),controller.signal),sas=deferred<Awaited<JoinSession['sas']>>(),done=deferred<void>();let session:Awaited<ReturnType<typeof pairSession>>|undefined,confirmed=false,finished=false;
    const fail=(e:unknown)=>{if(finished)return;finished=true;controller.abort();this.pairCancels.delete(cancel);sas.reject(e);done.reject(e);};const cancel=()=>{this.joinController?.abort();fail(new ProtocolError('CANCELLED'));};this.pairCancels.add(cancel);
    await guest.send({t:'hello-j',epk:ep.pub,id:this.ident.pub,name,platform,mac:await hmac(authKey,'J|'+ep.pub+'|'+this.ident.pub+'|'+name+'|'+platform)});
    void guest.loop(Date.now()+600000,async m=>{if(m.t==='hello-i'){if(session||!labels(m.name,m.platform)||!await verifyMac(authKey,'I|'+m.epk+'|'+ep.pub+'|'+m.name+'|'+m.platform,m.mac))throw new ProtocolError('BAD_CODE');session=await pairSession(ep.privateKey,m.epk,m.epk,ep.pub,this.ident.pub);sas.resolve({sas:session.sas,inviterName:m.name,platform:m.platform});}else if(m.t==='welcome'){if(!session||!confirmed)throw new ProtocolError('SAS_MISMATCH');const p=JSON.parse(text(await decrypt(session.key,unb64(m.iv),unb64(m.ct))));if(p.relay!==this.http.origin||!Array.isArray(p.members)||p.members.length>10||!p.members.some((m:Member)=>m.deviceId===this.ident.deviceId&&m.pub===this.ident.pub)||unb64(p.gk).length!==32)throw new ProtocolError('BAD_CODE');await this.opts.secrets.set('edge.migration',{origin:this.http.origin,started:Date.now(),done:true});this.group={gk:p.gk,epoch:p.epoch,members:p.members,rev:0,name,platform};this.joinPending=true;await this.opts.secrets.set('edge.joinPending',true);await this.retryJoin();finished=true;controller.abort();this.pairCancels.delete(cancel);done.resolve();}else if(m.t==='abort')throw new ProtocolError('CANCELLED');}).catch(e=>{if(!finished)fail(e);});
    return{sas:sas.promise,retry:()=>this.retryJoin(),confirm:async()=>{if(!session)throw new ProtocolError('BAD_CODE');confirmed=true;await guest.send({t:'confirm'});},cancel,done:done.promise};
  }
  dispose(){this.stop=true;this.joinController?.abort();clearTimeout(this.negotiationTimer);this.clearDeliveryRetries();for(const timer of this.leaveTimers.values())clearTimeout(timer);this.leaveTimers.clear();this.generation++;this.poller?.dispose();this.mesh?.dispose();this.legacy?.dispose();for(const b of this.bridges)b.dispose();clearTimeout(this.debounce);for(const cancel of this.pairCancels)cancel();globalThis.removeEventListener?.('online',this.wake);this.listeners.clear();}
}
class PairMailbox {
  private sequence=0;private after=-1;
  constructor(private http:EdgeHttp,private room:string,private side:'host'|'guest',private token:string,private signal:AbortSignal){}
  private headers(){return{[this.side==='host'?'X-KJ-Host':'X-KJ-Guest']:this.token,'Content-Type':'application/json'};}
  async send(frame:object){const seq=this.sequence++;await this.http.request('/pair/'+this.room+'/'+this.side+'/'+seq,{method:'PUT',headers:this.headers(),body:JSON.stringify(frame),signal:this.signal});}
  async loop(expiresAt:number,receive:(frame:any)=>Promise<void>){while(!this.signal.aborted&&Date.now()<expiresAt){const body=await(await this.http.request('/pair/'+this.room+'/'+(this.side==='host'?'guest':'host')+'/messages?after='+this.after,{headers:this.headers(),signal:this.signal})).json();for(const m of body.messages){if(this.signal.aborted)return;await receive(m.frame);this.after=m.seq;}if(!this.signal.aborted)await wait(800,this.signal);}if(!this.signal.aborted)throw new ProtocolError('EXPIRED');}
}

