import {b64url,unb64,random,encrypt,decrypt,utf8,concat} from './crypto.ts';
export const ICE_SERVERS:RTCIceServer[]=[
  {urls:'stun:stun.miwifi.com:3478'},{urls:'stun:stun.chat.bilibili.com:3478'},{urls:'stun:stun.qq.com:3478'},
  {urls:'stun:stun.cloudflare.com:3478'},{urls:'stun:stun.l.google.com:19302'},
];
export type PeerSignal={description?:RTCSessionDescriptionInit;candidate?:RTCIceCandidateInit};
type Peer={pc:RTCPeerConnection;dc?:RTCDataChannel;chain:Promise<void>;messages:Promise<void>;deliveries:Promise<void>;candidates:RTCIceCandidateInit[];attempt:number;lastSeen:number;lastSent:number;live:boolean;timer?:ReturnType<typeof setTimeout>};
export interface PeerMeshOptions {
  roomId:string;slot:string;encKey:CryptoKey;
  signal:(to:string,signal:PeerSignal)=>Promise<void>;
  receive:(from:string,bytes:Uint8Array)=>void|Promise<void>;
  status?:(slot:string,connected:boolean)=>void;
  turn?:RTCIceServer[];
  rtc?:(config:RTCConfiguration)=>RTCPeerConnection;
  /** Test/private network overrides. Production uses the five prescribed STUN services. */
  iceServers?:RTCIceServer[];
}
export class PeerMesh {
  private peers=new Map<string,Peer>();
  private fragments=new Map<string,{at:number;parts:Map<number,Uint8Array>;total:number;size:number}>();
  private stopped=false;
  private tick?:ReturnType<typeof setTimeout>;private foreground=true;private android=false;private testDrop=false;
  constructor(private options:PeerMeshOptions){
    this.schedule();
  }
  private suspended(){return this.android&&!this.foreground;}
  setForeground(visible:boolean,android=false){this.foreground=visible;this.android=android;if(!this.suspended())this.check();this.schedule();}
  /** Test only: simulate a frozen remote with an open PC, not a clean close. */
  setTestDropFrames(enabled:boolean){this.testDrop=enabled;this.schedule();}
  states(){return [...this.peers.values()].map(p=>({connected:this.connectedPeer(p),pc:p.pc.connectionState,ice:p.pc.iceConnectionState??'unknown',dc:p.dc?.readyState??'absent',lastReceivedAgoMs:Math.max(0,Date.now()-p.lastSeen)}));}
  private connectedPeer(p:Peer){return p.live&&p.dc?.readyState==='open'&&!p.timer&&!['failed','closed','disconnected'].includes(p.pc.connectionState);}
  connected(slot:string){const p=this.peers.get(slot);return !!p&&this.connectedPeer(p);}
  private schedule(){clearTimeout(this.tick);if(this.stopped||this.suspended()||this.testDrop)return;const now=Date.now(),beat=this.foreground?2000:15000,timeout=this.foreground?5000:35000;let next=now+beat;
    for(const p of this.peers.values())if(p.dc?.readyState==='open'&&!p.timer)next=Math.min(next,p.lastSeen+timeout,p.lastSent+beat);
    this.tick=setTimeout(()=>{this.check();this.schedule();},Math.max(1,next-now));
  }
  private check(){if(this.stopped||this.suspended()||this.testDrop)return;const now=Date.now(),beat=this.foreground?2000:15000,timeout=this.foreground?5000:35000;
    for(const[slot,p]of this.peers)if(p.dc?.readyState==='open'&&!p.timer){if(now-p.lastSeen>=timeout)this.retry(slot,p);else if(now-p.lastSent>=beat){p.lastSent=now;void this.send(slot,new Uint8Array()).catch(()=>this.retry(slot,p));}}
    for(const[k,v]of this.fragments)if(v.at+60000<now)this.fragments.delete(k);
  }
  connectedSlots(){return [...this.peers.keys()].filter(s=>this.connected(s));}
  ensure(slots:string[]){for(const s of slots){if(s!==this.options.slot&&/^[\w-]{22}$/.test(s)&&!this.peers.has(s)&&this.peers.size<9){const p=this.create(s);if(this.options.slot<s)void this.offer(s,p).catch(()=>this.retry(s,p));}}for(const[s,p]of this.peers)if(!slots.includes(s)){clearTimeout(p.timer);this.peers.delete(s);p.pc.close();}}
  /** A returning member may have missed/expired the original offer. Re-send
   * the gathered SDP without replacing a live connection or reversing roles. */
  async discover(slot:string){const p=this.peers.get(slot);if(!p||this.stopped||this.connected(slot)||this.options.slot>=slot||p.timer||['connecting','connected'].includes(p.pc.connectionState))return;
    if(p.pc.signalingState==='have-local-offer'&&p.pc.localDescription)await this.options.signal(slot,{description:p.pc.localDescription.toJSON()});
    else if(p.pc.signalingState==='stable')await this.offer(slot,p);
  }
  private create(slot:string){
    const rtc=this.options.rtc??(config=>new RTCPeerConnection(config));
    const pc=rtc({iceServers:[...(this.options.iceServers??ICE_SERVERS),...(this.options.turn??[])]});
    const p:Peer={pc,chain:Promise.resolve(),messages:Promise.resolve(),deliveries:Promise.resolve(),candidates:[],attempt:0,lastSeen:Date.now(),lastSent:0,live:false};this.peers.set(slot,p);
    pc.onicecandidate=e=>{if(e.candidate)void this.options.signal(slot,{candidate:e.candidate.toJSON()}).catch(()=>{});};
    pc.ondatachannel=e=>this.channel(slot,p,e.channel);
    pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))this.retry(slot,p);};
    pc.oniceconnectionstatechange=()=>{if(['failed','disconnected','closed'].includes(pc.iceConnectionState))this.retry(slot,p);};
    return p;
  }
  private channel(slot:string,p:Peer,dc:RTCDataChannel){
    p.dc=dc;dc.binaryType='arraybuffer';
    dc.onopen=()=>{if(this.peers.get(slot)!==p)return;clearTimeout(p.timer);p.timer=undefined;p.attempt=0;p.lastSeen=Date.now();p.lastSent=0;this.check();this.schedule();};
    dc.onclose=()=>{if(this.stopped||this.peers.get(slot)!==p)return;this.retry(slot,p);};
    dc.onerror=()=>this.retry(slot,p);
    dc.onmessage=e=>{if(this.testDrop)return;p.messages=p.messages.then(()=>this.message(slot,p,e.data)).catch(()=>{});};
  }
  private async offer(slot:string,p:Peer){if(this.stopped||this.peers.get(slot)!==p)return;this.channel(slot,p,p.pc.createDataChannel('kongjing.v3',{ordered:true}));await p.pc.setLocalDescription(await p.pc.createOffer());await this.options.signal(slot,{description:p.pc.localDescription!.toJSON()});}
  private retry(slot:string,p:Peer){
    if(this.stopped||this.peers.get(slot)!==p||p.timer)return;
    p.live=false;
    p.timer=setTimeout(()=>{if(this.stopped||this.peers.get(slot)!==p)return;this.peers.delete(slot);p.pc.onconnectionstatechange=null;p.pc.close();const next=this.create(slot);next.attempt=p.attempt+1;if(this.options.slot<slot)void this.offer(slot,next).catch(()=>this.retry(slot,next));},Math.min(60000,1000*2**Math.min(p.attempt,6)));
    this.options.status?.(slot,false);
  }
  async acceptSignal(from:string,signal:PeerSignal){
    if(this.stopped||from===this.options.slot||!/^[\w-]{22}$/.test(from))return;
    const p=this.peers.get(from);if(!p)return;
    const operation=p.chain.then(async()=>{
      if(signal.description){if(signal.description.type==='offer'&&from>this.options.slot)return;
        await p.pc.setRemoteDescription(signal.description);for(const c of p.candidates.splice(0))await p.pc.addIceCandidate(c);
        if(signal.description.type==='offer'){await p.pc.setLocalDescription(await p.pc.createAnswer());await this.options.signal(from,{description:p.pc.localDescription!.toJSON()});}
      }else if(signal.candidate){if(p.pc.remoteDescription)await p.pc.addIceCandidate(signal.candidate);else if(p.candidates.length<128)p.candidates.push(signal.candidate);}
    });p.chain=operation.catch(()=>this.retry(from,p));await operation;
  }
  async send(slot:string,plain:Uint8Array){
    if(this.testDrop)return false;
    const dc=this.peers.get(slot)?.dc;if(dc?.readyState!=='open')return false;
    if(plain.length>6*1024*1024)throw new Error('Peer payload too large');
    const e=await encrypt(this.options.encKey,plain,utf8('kj/p2p/'+this.options.roomId)),bytes=concat(new Uint8Array([1]),e.iv,e.ct),id=b64url(random(12)),total=Math.ceil(bytes.length/32768);
    for(let n=0;n<total;n++){
      const deadline=Date.now()+10000;while(dc.bufferedAmount>262144){if(Date.now()>deadline||dc.readyState!=='open')throw new Error('Peer backpressure');await new Promise(r=>setTimeout(r,10));}
      dc.send(JSON.stringify({id,n,total,b:b64url(bytes.slice(n*32768,(n+1)*32768))}));
    }const p=this.peers.get(slot);if(p)p.lastSent=Date.now();return true;
  }
  async broadcast(plain:Uint8Array){await Promise.all(this.connectedSlots().map(slot=>this.send(slot,plain)));}
  private async message(slot:string,p:Peer,data:unknown){
    if(typeof data!=='string'||data.length>65536)throw new Error('Invalid peer frame');
    const f=JSON.parse(data);if(!/^[\w-]{16}$/.test(f.id)||!Number.isInteger(f.n)||!Number.isInteger(f.total)||f.total<1||f.total>193||f.n<0||f.n>=f.total||typeof f.b!=='string')throw new Error('Invalid fragments');
    const part=unb64(f.b);if(part.length>32768)throw new Error('Invalid fragment size');
    const key=slot+'/'+f.id;let item=this.fragments.get(key);
    if(!item){if(this.fragments.size>=16)throw new Error('Fragment capacity');this.fragments.set(key,item={at:Date.now(),parts:new Map(),total:f.total,size:0});}
    if(item.total!==f.total)throw new Error('Inconsistent fragment total');if(!item.parts.has(f.n)){item.size+=part.length;item.parts.set(f.n,part);}
    if(item.size>6*1024*1024+29){this.fragments.delete(key);throw new Error('Reassembly bound');}
    if(item.parts.size===item.total){this.fragments.delete(key);const b=concat(...Array.from({length:item.total},(_,i)=>item!.parts.get(i)!));if(b[0]!==1)throw new Error('Version');const plain=await decrypt(this.options.encKey,b.slice(1,13),b.slice(13),utf8('kj/p2p/'+this.options.roomId));if(this.stopped||p.timer||this.peers.get(slot)!==p)return;p.lastSeen=Date.now();if(!p.live){p.live=true;this.options.status?.(slot,true);}this.schedule();if(plain.length)p.deliveries=p.deliveries.then(()=>this.options.receive(slot,plain)).catch(()=>{});}
  }
  dispose(){this.stopped=true;clearTimeout(this.tick);for(const p of this.peers.values()){clearTimeout(p.timer);p.pc.onconnectionstatechange=null;p.pc.oniceconnectionstatechange=null;p.pc.close();}this.peers.clear();this.fragments.clear();}
}
