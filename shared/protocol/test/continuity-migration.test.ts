import {it,expect} from 'vitest';
import {materializeJournal} from '../src/migration.ts';
import {historyEntryId} from '../src/index.ts';
const DAY=86400000, now=1800000000000;
const r=(seq:number,t:string,dev:string,p:any)=>({id:String(seq),seq,t,dev,at:now,...p});
it('materializes deletion scopes, retention, dedup, search removal and stable send/ack ids',async()=>{
  const recent={u:'https://private.example/',ti:'private',at:now-DAY};
  const old={u:'https://old.example/',ti:'old',at:now-40*DAY};
  const records=[r(1,'hv','A',{v:[recent,recent,old]}),r(2,'hv','B',{v:[recent]}),
    r(3,'hd','A',{scope:'self',ids:[await historyEntryId('A',recent.u,recent.at)]}),
    r(4,'cfg','A',{retentionDays:90}),r(5,'cfg','A',{retentionDays:30}),
    r(6,'sh','A',{q:[{s:'erased',at:now}]}),r(7,'sd','A',{all:true}),
    r(8,'snd','A',{to:'B',k:'text',tx:'keep'}),r(9,'ack','B',{ref:'8'}),
    r(10,'snd','A',{at:now-7*DAY,to:'B',k:'text',tx:'expired'})];
  const out=await materializeJournal(records,now);
  expect(out.filter(r=>r.t==='hv')).toEqual([{t:'hv',dev:'B',at:now,v:[recent]}]);
  expect(out.some(r=>r.t==='sh')).toBe(false);
  expect(out.find(r=>r.t==='cfg').retentionDays).toBe(30);
  expect(out.filter(r=>r.t==='snd').map(r=>r.id)).toEqual(['8']);
  expect(out.find(r=>r.t==='ack')).toMatchObject({id:'9',ref:'8'});
  expect((await materializeJournal([...records,r(11,'cfg','B',{retentionDays:90})],now)).filter(r=>r.t==='hv').flatMap(r=>r.v)).toContainEqual(old);
});
it('rebatches 500 retained visits into at most 200 per hv and applies all-device range deletions',async()=>{
  const visits=Array.from({length:500},(_,i)=>({u:'https://example.com/'+i,ti:String(i),at:now-i*60000}));
  let out=await materializeJournal([r(1,'hv','A',{v:visits})],now);
  expect(out.filter(r=>r.t==='hv').map(r=>r.v.length)).toEqual([200,200,100]);
  out=await materializeJournal([r(1,'hv','A',{v:visits}),r(2,'hd','B',{scope:'all',range:{from:now-60000,to:now}})],now);
  expect(out.filter(r=>r.t==='hv').flatMap(r=>r.v)).toHaveLength(498);
});
