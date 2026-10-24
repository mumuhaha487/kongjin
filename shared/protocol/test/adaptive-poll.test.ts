import {test,expect,vi,afterEach} from 'vitest';
import {pollingPlan,AdaptivePoller} from '../src/index.ts';
const base={foreground:true,android:false,pending:false,online:0,connected:0};
afterEach(()=>vi.useRealTimers());

test('persistent failed watches back off exponentially, respect server delays and reset on recovery',async()=>{
  vi.useFakeTimers();const random=vi.spyOn(Math,'random').mockReturnValue(0),starts:number[]=[];let minimum=0;
  const p=new AdaptivePoller({check:async()=>{},watch:async signal=>{starts.push(Date.now());if(starts.length<=4||starts.length===6||starts.length===8)throw new Error('offline');if(starts.length===5){await new Promise(resolve=>setTimeout(resolve,1000));return;}await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));},presence:async()=>{},error:()=>minimum});
  try{
    p.start({...base,online:1});await vi.advanceTimersByTimeAsync(16000);expect(starts.map(at=>at-starts[0])).toEqual([0,2000,4000,8000,16000]);
    await vi.advanceTimersByTimeAsync(3000);expect(starts).toHaveLength(6);await vi.advanceTimersByTimeAsync(1);expect(starts[6]-starts[5]).toBe(2000);
    minimum=120000;p.update({...base,online:1},true);await vi.advanceTimersByTimeAsync(1);expect(starts).toHaveLength(8);await vi.advanceTimersByTimeAsync(119998);expect(starts).toHaveLength(8);await vi.advanceTimersByTimeAsync(2);expect(starts).toHaveLength(9);
  }finally{p.dispose();random.mockRestore();}
});
test('v3.1 ordinary background failures never accelerate the 90s policy',async()=>{
  vi.useFakeTimers();let reads=0;const p=new AdaptivePoller({check:async()=>{reads++;throw new Error('offline');},watch:async()=>{},presence:async()=>{},error:()=>2000});
  try{p.start({...base,foreground:false});await vi.advanceTimersByTimeAsync(90000);expect(reads).toBe(1);await vi.advanceTimersByTimeAsync(89999);expect(reads).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(reads).toBe(2);}finally{p.dispose();}
});
test('v3.1 exact foreground/background/Android policy matrix',()=>{
  expect(pollingPlan(base)).toEqual({mode:'solo',watch:false,checkMs:20000,presenceMs:60000});
  expect(pollingPlan({...base,foreground:false}).checkMs).toBe(90000);
  expect(pollingPlan({...base,online:2})).toEqual({mode:'relay',watch:true,checkMs:0,presenceMs:60000});
  expect(pollingPlan({...base,online:2,foreground:false}).checkMs).toBe(60000);
  expect(pollingPlan({...base,online:2,connected:2})).toEqual({mode:'direct',watch:false,checkMs:30000,presenceMs:120000});
  expect(pollingPlan({...base,online:2,connected:2,foreground:false}).checkMs).toBe(60000);
  expect(pollingPlan({...base,android:true,foreground:false}).mode).toBe('suspended');
  expect(pollingPlan({...base,android:true,foreground:false,pending:true}).checkMs).toBe(90000);
  expect(pollingPlan({...base,online:2,connected:1,foreground:false,negotiating:true}).watch).toBe(true);
  expect(pollingPlan({...base,online:2,connected:1,android:true,foreground:false,negotiating:true}).mode).toBe('suspended');
});
test('v3.1 solo discovery <=20s, full direct stops watch, disconnect immediately falls back, timeout renews',async()=>{
  vi.useFakeTimers();let checks=0,watches=0,aborts=0;const resolvers:Array<()=>void>=[];
  const poller=new AdaptivePoller({check:async()=>{checks++;},watch:signal=>new Promise(resolve=>{watches++;resolvers.push(resolve);signal.addEventListener('abort',()=>{aborts++;resolve();},{once:true});}),presence:async()=>{},error:()=>{}});
  try{
    poller.start(base);await vi.advanceTimersByTimeAsync(19999);expect(checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);expect(checks).toBe(1);
    poller.update({...base,online:1});await vi.advanceTimersByTimeAsync(1);expect(watches).toBe(1);
    poller.update({...base,online:1,connected:1});expect(aborts).toBe(1);
    await vi.advanceTimersByTimeAsync(29999);expect(checks).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(checks).toBe(2);
    poller.update({...base,online:1,connected:0});await vi.advanceTimersByTimeAsync(1);expect(watches).toBe(2);
    resolvers.at(-1)!();await vi.advanceTimersByTimeAsync(1);expect(watches).toBe(3);
    poller.update({...base,online:1,foreground:false});expect(aborts).toBe(2);
    await vi.advanceTimersByTimeAsync(60000);expect(checks).toBe(3);
  }finally{poller.dispose();}
});
test.each([true,false])('v3.2 full mesh discovers a returning device within one cycle (foreground=%s)',async foreground=>{
  vi.useFakeTimers();let arrived=false,reads=0,connected=1;const state={...base,foreground,online:1,connected:1};
  const p=new AdaptivePoller({check:async()=>{reads++;if(arrived){connected=2;p.update({...state,online:2,connected});}},watch:async()=>{},presence:async()=>{},error:()=>{}});
  try{p.start(state);arrived=true;const interval=foreground?30000:60000;await vi.advanceTimersByTimeAsync(interval-1);expect(connected).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(connected).toBe(2);expect(reads).toBe(1);expect(p.current()?.mode).toBe('direct');}finally{p.dispose();}
});
test('v3.2 discovery interval includes read duration instead of drifting by that duration',async()=>{
  vi.useFakeTimers();const starts:number[]=[];
  const p=new AdaptivePoller({check:async()=>{starts.push(Date.now());await new Promise(r=>setTimeout(r,3000));},watch:async()=>{},presence:async()=>{},error:()=>{}});
  try{p.start({...base,online:1,connected:1});await vi.advanceTimersByTimeAsync(93000);expect(starts).toHaveLength(3);expect(starts[1]-starts[0]).toBe(30000);expect(starts[2]-starts[1]).toBe(30000);}finally{p.dispose();}
});
test('v3.2 background handshake follow-up stops at its deadline and returns to 60s checks',async()=>{
  vi.useFakeTimers();let watches=0,checks=0,aborts=0;const input={...base,foreground:false,online:2,connected:1};
  const p=new AdaptivePoller({check:async()=>{checks++;},watch:signal=>new Promise(resolve=>{watches++;signal.addEventListener('abort',()=>{aborts++;resolve();});}),presence:async()=>{},error:()=>{}});
  try{p.start({...input,negotiating:true});await vi.advanceTimersByTimeAsync(1);expect(watches).toBe(1);await vi.advanceTimersByTimeAsync(9999);p.update(input);expect(aborts).toBe(1);await vi.advanceTimersByTimeAsync(59999);expect(checks).toBe(0);await vi.advanceTimersByTimeAsync(1);expect(checks).toBe(1);expect(watches).toBe(1);}finally{p.dispose();}
});
test('v3.1 hidden Android cancels inflight read and heartbeat; foreground checks immediately',async()=>{
  vi.useFakeTimers();let reads=0,beats=0,aborted=0;
  const p=new AdaptivePoller({check:async()=>{reads++;},watch:signal=>new Promise(resolve=>{reads++;signal.addEventListener('abort',()=>{aborted++;resolve();});}),presence:async()=>{beats++;},error:()=>{}});
  try{p.start({...base,android:true,online:1});await vi.advanceTimersByTimeAsync(1);expect(reads).toBe(1);
    p.update({...base,android:true,online:1,foreground:false});expect(aborted).toBe(1);
    await vi.advanceTimersByTimeAsync(600000);expect(reads).toBe(1);expect(beats).toBe(0);
    p.announced();p.update({...base,android:true,online:1},true);await vi.advanceTimersByTimeAsync(1);expect(reads).toBe(2);
    p.update({...base,android:true,online:1,connected:1});await vi.advanceTimersByTimeAsync(119998);expect(beats).toBe(0);await vi.advanceTimersByTimeAsync(2);expect(beats).toBe(1);
  }finally{p.dispose();}
});
