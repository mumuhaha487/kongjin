import { historyEntryId } from "./continuity-crypto.ts";
import type { JournalRecord } from "./types.ts";

// Rebuild the merged retained view, so deletions are not resurrected by rotation.
export async function materializeJournal(records: JournalRecord[], time = Date.now()) {
  const visits = new Map<string, any>(), searches = new Map<string, any>();
  const retentionByDevice = new Map<string, number>();
  const extra: any[] = [];
  for (const r of records) {
    if (r.t === "cfg" && [30,90].includes(Number(r.retentionDays))) retentionByDevice.set(r.dev, Number(r.retentionDays));
    if (r.t === "hv") for (const v of r.v as any[]) visits.set(await historyEntryId(r.dev, v.u, v.at), { ...v, dev: r.dev });
    if (r.t === "sh") for (const q of r.q as any[]) searches.set(r.dev + "|" + q.s + "|" + q.at, { ...q, dev: r.dev });
    if (r.t === "hd") for (const [id, v] of visits) {
      const range = r.range as any, ids = r.ids as string[] | undefined;
      if (r.scope === "self" && v.dev !== r.dev) continue;
      if ((ids && ids.includes(id)) || (range && v.at >= range.from && v.at <= range.to) || (!ids && !range)) visits.delete(id);
    }
    if (r.t === "sd") for (const [id, q] of searches) {
      const range = r.range as any;
      if (r.all || (!range || (q.at >= range.from && q.at <= range.to))) searches.delete(id);
    }
    if (["snd", "ack"].includes(r.t) && r.at > time - 7 * 86400000) {
      const { seq, ...plain } = r; extra.push(plain);
    }
  }
  const result: any[] = [];
  const retention = Math.max(30,...retentionByDevice.values());
  for (const [source, type, field] of [[visits, "hv", "v"], [searches, "sh", "q"]] as const) {
    const byDevice = new Map<string, any[]>();
    for (const r of source.values()) if (r.at > time - retention * 86400000) {
      const { dev, ...v } = r;
      if (!byDevice.has(dev)) byDevice.set(dev, []);
      byDevice.get(dev)!.push(v);
    }
    for (const [dev, items] of byDevice) for (let i = 0; i < items.length; i += 200)
      result.push({ t: type, dev, at: time, [field]: items.slice(i, i + 200) });
  }
  return [...result, { t: "cfg", dev: records[0]?.dev ?? "", at: time, retentionDays: retention }, ...extra];
}
