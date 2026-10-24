import {b64url,unb64,utf8,text,random,deriveGroup} from './crypto.ts';
import {deriveSlotId,sealContinuity,openContinuity,envelopeBytes,bytesEnvelope} from './continuity-crypto.ts';
import {TransportEdge} from './transport-edge.ts';
import {PeerMesh,type PeerMeshOptions} from './peer-mesh.ts';
import type {Member} from './types.ts';
import {AdaptivePoller} from './adaptive-poll.ts';
import type {RequestObserver} from './diagnostics.ts';
/** Local SecretStore only: old credentials are never uploaded. */
export type RotationBridgeData={gk:string;epoch:number;members:Member[];deviceId:string;forwardPath:string;forward:string;expiresAt:number};
/** Direct-only rotation: keep old signaling alive so an offline peer can
 * receive its ECDH-wrapped new GK when both devices next come online. */
export class OldEpochBridge {
  private stop=false;private mesh?:PeerMesh;private poller?:AdaptivePoller;private foreground=true;private android=false;
  constructor(private data:RotationBridgeData,private options:{url:string;fetch?:typeof fetch;rtc?:PeerMeshOptions['rtc'];iceServers?:RTCIceServer[];turn?:RTCIceServer[];observer?:RequestObserver}){}
  async start(){
    if(this.data.expiresAt<=Date.now()||(!this.options.rtc&&typeof RTCPeerConnection==='undefined'))return;
    const keys=await deriveGroup(unb64(this.data.gk),this.data.epoch),slot=await deriveSlotId(unb64(this.data.gk),this.data.epoch,this.data.deviceId),transport=new TransportEdge(keys.roomId,keys.roomToken,slot,this.options),slots=await Promise.all(this.data.members.map(m=>deriveSlotId(unb64(this.data.gk),this.data.epoch,m.deviceId)));
    const seal=async(path:string,value:object)=>envelopeBytes(await sealContinuity(keys.encKey,'kj/obj/'+keys.roomId+'/'+path,utf8(JSON.stringify(value))));
    this.mesh=new PeerMesh({...keys,slot,rtc:this.options.rtc,iceServers:this.options.iceServers,turn:this.options.turn,
      signal:async(to,signal)=>{if(this.stop)return;const p='sig/'+to+'/'+Date.now()+'-'+b64url(random(8));await transport.put(p,await seal(p,{from:slot,signal}));},
      receive:async()=>{},
      status:(to,connected)=>{this.refresh();if(connected)void this.mesh?.send(to,utf8(JSON.stringify({t:'objects',objects:[{key:this.data.forwardPath,bytes:this.data.forward}]}))).catch(()=>{});},
    });this.mesh.setForeground(this.foreground,this.android);this.mesh.ensure(slots);
    const check=async(signal:AbortSignal)=>{if(this.stop||this.data.expiresAt<=Date.now()){this.dispose();return;}const list=await transport.list('sig/'+slot+'/',signal);for(const {key:path} of list.objects){if(signal.aborted)return;const raw=await transport.get(path,signal);if(!raw)continue;const m=JSON.parse(text(await openContinuity(keys.encKey,'kj/obj/'+keys.roomId+'/'+path,bytesEnvelope(raw))));if(slots.includes(m.from))await this.mesh?.acceptSignal(m.from,m.signal);await transport.delete(path);}};
    this.poller=new AdaptivePoller({check,watch:check,presence:async()=>{},error:()=>2000});
    this.poller.start({foreground:this.foreground,android:this.android,pending:false,online:0,connected:0});this.refresh(true);
  }
  private refresh(immediate=false){const connected=this.mesh?.connectedSlots().length??0;this.poller?.update({foreground:this.foreground,android:this.android,pending:false,online:connected,connected},immediate);}
  setForeground(visible:boolean,android:boolean){const resumed=visible&&!this.foreground;this.foreground=visible;this.android=android;this.mesh?.setForeground(visible,android);this.refresh(resumed);}
  dispose(){this.stop=true;this.poller?.dispose();this.mesh?.dispose();}
}
