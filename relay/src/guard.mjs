import {
  Serialized,
  now,
  config,
  hit,
  error,
  json,
  bodyJson,
  checkMac,
  unb64,
} from "./common.mjs";
export class Guard extends Serialized {
  constructor(ctx, env) {
    super();
    this.ctx = ctx;
    this.env = env;
    this.minutes = new Map();
  }
  minute(ip,key,limit,time) {
    const id=ip+'|'+key, state=this.minutes.get(id)??{};
    this.minutes.set(id,state);hit(state,key,limit,60000,time);
    if(this.minutes.size>4096)for(const[k,v]of this.minutes)if(Object.values(v).every(r=>r.start+60000<=time))this.minutes.delete(k);
  }
  async schedule(time) {
    if(this.alarmAt===undefined)this.alarmAt=(await this.ctx.storage.getAlarm?.())??Infinity;
    if(time<this.alarmAt){await this.ctx.storage.setAlarm(time);this.alarmAt=time;}
  }
  fetch(request) {
    return this.serial(async () => {
      try {
        const action = new URL(request.url).pathname,
          body = await bodyJson(request),
          time = now(this.env);
        if(action==='/rate'&&body.op==='global') {
          this.minute(body.ip,'global',config(this.env,'global',300),time);
          return json({ok:true});
        }
        if (action === "/capacity") {
          const key = "room:" + body.room,
            exists = await this.ctx.storage.get(key);
          let count = (await this.ctx.storage.get("count")) ?? 0;
          if (body.op === "reserve") {
            if (exists) return json({ ok: true, reserved: false });
            if (count >= config(this.env, "capacity", 50000))
              error(503, "SERVER_ERROR", "服务容量已满");
            await this.ctx.storage.put(key, true);
            await this.ctx.storage.put("count", count + 1);
            return json({ ok: true, reserved: true });
          } else if (exists) {
            await this.ctx.storage.delete(key);
            await this.ctx.storage.put("count", Math.max(0, count - 1));
          }
          return json({ ok: true });
        }
        const key = "ip:" + body.ip;
        const state = (await this.ctx.storage.get(key)) ?? {
          limits: {},
          used: {},
          issued: {},
          lockedUntil: 0,
        };
        state.issued ??= {};
        for (const [k, v] of Object.entries(state.issued))
          if (v <= time) delete state.issued[k];
        for (const [k, v] of Object.entries(state.used))
          if (v <= time) delete state.used[k];
        for (const [k, v] of Object.entries(state.limits))
          if (v.start + (k.endsWith("day") ? 86400000 : 3600000) <= time)
            delete state.limits[k];
        let answer = { ok: true };
        const dirty=action!=='/rate'||body.op!=='pow';
        try {
          if (action === "/rate") {
            const op = body.op;
            if (op === "global")
              hit(
                state.limits,
                "global",
                config(this.env, "global", 300),
                60000,
                time,
              );
            else if (op === "pow") {
              this.minute(body.ip,'pow',config(this.env,'pow',30),time);
              const purpose = body.purpose;
              const count = state.limits[purpose + "Hour"]?.count ?? 0;
              answer.difficulty =
                count > (purpose === "group" ? 5 : 10) / 2 ? 22 : 18;
            } else if (op === "group") {
              hit(
                state.limits,
                "groupHour",
                config(this.env, "groupHour", 5),
                3600000,
                time,
              );
              hit(
                state.limits,
                "groupday",
                config(this.env, "groupDay", 20),
                86400000,
                time,
              );
            } else if (op === "pair")
              hit(
                state.limits,
                "pairHour",
                config(this.env, "pairHour", 10),
                3600000,
                time,
              );
            else if (op === "journal")
              hit(state.limits, "journalHour", config(this.env, "journalHour", 600), 3600000, time);
            else if (op === "rotate")
              hit(
                state.limits,
                "rotateHour",
                config(this.env, "rotateHour", 10),
                3600000,
                time,
              );
            else if (op === "guest") {
              if (state.lockedUntil > time)
                error(
                  429,
                  "RATE_LIMITED",
                  "Pairing locked",
                  Math.ceil((state.lockedUntil - time) / 1000),
                );
              try {
                hit(
                  state.limits,
                  "guest",
                  config(this.env, "guest", 10),
                  600000,
                  time,
                  body.missing ? 2 : 1,
                );
              } catch (e) {
                state.lockedUntil = time + 1800000;
                e.retryAfter = 1800;
                throw e;
              }
            } else if (op === "icon") {
              this.minute(body.ip,'icon',config(this.env,'iconMinute',60),time);
              hit(
                state.limits,
                "iconday",
                config(this.env, "iconDay", 2000),
                86400000,
                time,
              );
            }
          } else if (action === "/issue") {
            state.issued[body.challenge] = body.expiresAt;
          } else if (action === "/proof") {
            const p = body.proof;
            if (!p) error(428, "POW_REQUIRED");
            if (
              !["group", "pair"].includes(p.purpose) ||
              p.purpose !== body.purpose ||
              !Number.isInteger(p.difficulty) ||
              p.difficulty < config(this.env, "difficulty", 18) ||
              p.difficulty > 256 ||
              !Number.isFinite(p.expiresAt) ||
              p.expiresAt <= time ||
              p.expiresAt > time + 120000 ||
              !(await checkMac(
                this.env.POW_SECRET,
                p.challenge +
                  String(p.difficulty) +
                  String(p.expiresAt) +
                  p.purpose,
                p.sig,
              ))
            )
              error(400, "POW_INVALID");
            let challenge, nonce;
            try {
              challenge = unb64(p.challenge);
              nonce = unb64(p.nonce);
            } catch {
              error(400, "POW_INVALID");
            }
            if (
              challenge.length !== 16 ||
              nonce.length !== 8 ||
              state.used[p.challenge] ||
              state.issued[p.challenge] !== p.expiresAt
            )
              error(400, "POW_INVALID");
            const data = new Uint8Array(24);
            data.set(challenge);
            data.set(nonce, 16);
            const digest = new Uint8Array(
              await crypto.subtle.digest("SHA-256", data),
            );
            let bits = 0;
            for (const v of digest) {
              if (v === 0) bits += 8;
              else {
                bits += Math.clz32(v) - 24;
                break;
              }
            }
            if (bits < p.difficulty) error(400, "POW_INVALID");
            state.used[p.challenge] = p.expiresAt;
            delete state.issued[p.challenge];
          }
        } finally {
          if(dirty) {
            state.last = time;
            await this.ctx.storage.put(key, state);
            const pending=[...Object.values(state.issued),...Object.values(state.used)];
            // One earliest alarm per batch; proof validity is checked against exact expiresAt.
            const short=pending.length?Math.ceil(Math.min(...pending)/60000)*60000:Infinity;
            await this.schedule(Math.min(time+86400000,short));
          }
        }
        return json(answer);
      } catch (e) {
        const { failure } = await import("./common.mjs");
        return failure(e);
      }
    });
  }
  async alarm() {
    const time = now(this.env);
    this.alarmAt=Infinity;
    for (const [k, v] of await this.ctx.storage.list({ prefix: "ip:" })) {
      if (v.last + 86400000 <= time) {await this.ctx.storage.delete(k);continue;}
      let changed=false;
      for(const field of ['issued','used'])for(const[id,expiry]of Object.entries(v[field]??{}))if(expiry<=time){delete v[field][id];changed=true;}
      if(changed)await this.ctx.storage.put(k,v);
      const short=[...Object.values(v.issued??{}),...Object.values(v.used??{})];
      await this.schedule(Math.min(v.last+86400000,short.length?Math.ceil(Math.min(...short)/60000)*60000:Infinity));
    }
  }
}
export async function guard(env, ip, action, body) {
  const id = action === "capacity" ? "kongjing-capacity" : ip.slice(0, 4);
  const r = await env.GUARDS.get(env.GUARDS.idFromName(id)).fetch(
    new Request("https://internal/" + action, {
      method: "POST",
      body: JSON.stringify({ ip, ...body }),
    }),
  );
  const value = await r.json();
  if (!r.ok) {
    const { HttpError } = await import("./common.mjs");
    throw new HttpError(
      r.status,
      value.error.code,
      value.error.message,
      value.retryAfter,
    );
  }
  return value;
}
