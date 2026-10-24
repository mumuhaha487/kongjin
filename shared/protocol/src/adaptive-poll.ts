import {retryDelay} from './network-retry.ts';
/** v3.2 scheduling policy. Timings are protocol constants, not user preferences. */
export const FULL_RECONCILE_MS = 300000;
export type PollInput = {
  foreground: boolean;
  android: boolean;
  pending: boolean;
  online: number;
  connected: number;
  /** Bounded handshake follow-up after an inbox/presence discovery, not idle polling. */
  negotiating?: boolean;
};
export type PollPlan = {
  mode: 'suspended' | 'direct' | 'relay' | 'solo';
  watch: boolean;
  checkMs: number;
  presenceMs: number;
};
export function pollingPlan(input: PollInput): PollPlan {
  if (input.android && !input.foreground && !input.pending)
    return {mode:'suspended', watch:false, checkMs:0, presenceMs:0};
  if (input.online > 0 && input.connected >= input.online)
    return {mode:'direct', watch:false, checkMs:input.foreground ? 30000 : 60000, presenceMs:120000};
  if (input.online > 0)
    return {mode:'relay', watch:input.foreground||!!input.negotiating, checkMs:input.foreground||input.negotiating ? 0 : 60000, presenceMs:60000};
  return {mode:'solo', watch:false, checkMs:input.foreground ? 20000 : 90000, presenceMs:60000};
}

/** One cancellable read at a time; a policy transition cancels the old read/wait.
 * Application callbacks must honor the signal before starting a queued read. */
export class AdaptivePoller {
  private plan?: PollPlan;
  private running = false;
  private revision = 0;
  private checkTimer?: ReturnType<typeof setTimeout>;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private lastPresence: number;
  private failures = 0;
  constructor(private callbacks: {
    check: (signal:AbortSignal) => Promise<void>;
    watch: (signal:AbortSignal) => Promise<void>;
    presence: () => Promise<void>;
    error: (error:unknown) => number | void;
  }) { this.lastPresence = Date.now(); }

  start(input:PollInput) { this.running=true; this.update(input); }
  current() { return this.plan && {...this.plan}; }
  update(input:PollInput, immediate=false) {
    const next=pollingPlan(input), previous=this.plan;
    if (!this.running) { this.plan=next; return; }
    if (!immediate && previous && JSON.stringify(previous)===JSON.stringify(next)) return;
    this.plan=next; const revision=++this.revision;
    clearTimeout(this.checkTimer); clearTimeout(this.presenceTimer); this.controller?.abort();
    if (next.mode==='suspended') return;
    this.schedulePresence();
    if (immediate || next.watch) this.checkTimer=setTimeout(()=>void this.read(revision),0);
    else this.scheduleRead(revision, next.checkMs);
  }
  private scheduleRead(revision:number, delay:number) {
    this.checkTimer=setTimeout(()=>void this.read(revision),delay);
  }
  private async read(revision:number) {
    if (!this.running || revision!==this.revision || this.plan?.mode==='suspended') return;
    const controller=this.controller=new AbortController(), started=Date.now(); let retry=0;
    try { await (this.plan!.watch ? this.callbacks.watch(controller.signal) : this.callbacks.check(controller.signal));this.failures=0; }
    catch(error) { if (!controller.signal.aborted) retry=retryDelay(++this.failures,this.callbacks.error(error)||2000,2000); }
    finally {
      if (this.running && revision===this.revision && this.current()?.mode!=='suspended')
        this.scheduleRead(revision,retry ? Math.max(retry,this.plan!.checkMs) : Math.max(0,this.plan!.checkMs-(Date.now()-started)));
    }
  }
  private schedulePresence() {
    clearTimeout(this.presenceTimer);
    if (!this.running || !this.plan?.presenceMs) return;
    this.presenceTimer=setTimeout(()=>void this.heartbeat(),Math.max(0,this.lastPresence+this.plan.presenceMs-Date.now()));
  }
  private async heartbeat() {
    if (!this.running || this.plan?.mode==='suspended') return;
    try { await this.callbacks.presence(); }
    catch(error) { this.callbacks.error(error); }
    finally { this.lastPresence=Date.now(); this.schedulePresence(); }
  }
  /** A visible/resumed client announces immediately; do not duplicate scheduled heartbeats. */
  announced() { this.lastPresence=Date.now(); this.schedulePresence(); }
  dispose() {
    this.running=false; this.revision++;
    clearTimeout(this.checkTimer); clearTimeout(this.presenceTimer); this.controller?.abort();
  }
}
