/** A scheme-free, readable title for visits whose page has no title yet. */
export function historyTitle(visit: { ti: string; u: string }) {
  if (visit.ti.trim()) return visit.ti;
  try {
    const url = new URL(visit.u);
    return url.host + (url.pathname === "/" ? "" : url.pathname) + url.search;
  } catch {
    return visit.u;
  }
}
