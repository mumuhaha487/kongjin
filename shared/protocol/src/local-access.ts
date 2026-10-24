import type {SyncOptions} from './types.ts';
/** Remote ordering is separate from the application storage transaction. */
export class LocalAccess<D> {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private options:Pick<SyncOptions<D>,'loadLocal'|'saveMerged'|'merge'|'withLocalLock'>){}
  exclusive<T>(task:()=>Promise<T>):Promise<T>{
    const run=this.chain.then(()=>this.options.withLocalLock?this.options.withLocalLock(task):task());
    this.chain=run.catch(()=>{});return run;
  }
  merge(remote:D){return this.exclusive(async()=>{
    const latest=await this.options.loadLocal();
    await this.options.saveMerged(this.options.merge(latest,remote));
  });}
}
