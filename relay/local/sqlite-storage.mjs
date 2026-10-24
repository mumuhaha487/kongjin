// Optional file-backed SQLite adapter for Node 24+. No production/debug API dependencies.
import {DatabaseSync} from 'node:sqlite';
export function sqliteStorage(path, metrics, arm) {
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS kj_local_kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const exec=(query,...args)=>{
    const all=[];
    for(const q of query.split(';').filter(q=>q.trim())){
      const st=db.prepare(q),before=db.prepare('SELECT total_changes() AS n').get().n;
      const rows=st.columns().length?st.all(...args):(st.run(...args),[]);all.push(...rows);
      const changed=Number(db.prepare('SELECT total_changes() AS n').get().n-before);
      // Native SQLite changes exclude index entries; charge every affected secondary index conservatively.
      const table=/^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(\w+)/i.exec(q)?.[1];
      const indexes=table?db.prepare('SELECT COUNT(*) AS n FROM pragma_index_list(?)').get(table).n:0;
      metrics.sqlBaseWrites+=changed;metrics.sqlIndexWrites+=changed*Number(indexes);
    }
    return {toArray:()=>all};
  };
  const get=async(k)=>{const row=db.prepare('SELECT value FROM kj_local_kv WHERE key=?').get(k);return row?JSON.parse(row.value):undefined;};
  const storage={sql:{exec},get,
    async put(k,v){exec('INSERT INTO kj_local_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',k,JSON.stringify(v));},
    async delete(k){exec('DELETE FROM kj_local_kv WHERE key=?',k);},
    async list({prefix='',limit=1e9}={}){return new Map(db.prepare('SELECT key,value FROM kj_local_kv WHERE substr(key,1,?)=? LIMIT ?').all(prefix.length,prefix,limit).map(r=>[r.key,JSON.parse(r.value)]));},
    async deleteAll(){for(const {name}of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())exec('DELETE FROM '+name);},
    async getAlarm(){return get('_alarm');},
    async setAlarm(t){await storage.put('_alarm',t);arm(t);},
    transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},
  };
  return storage;
}
