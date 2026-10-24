import type { RawVisit, Slot, TabItem } from "./types";
const sensitive = new Set([
  "token",
  "access_token",
  "id_token",
  "code",
  "password",
  "passwd",
  "pwd",
  "session",
  "sessionid",
  "sid",
  "sig",
  "signature",
  "auth",
  "key",
  "apikey",
  "otp",
]);
export function recordableUrl(input: string, excluded: string[] = []) {
  try {
    const u = new URL(input);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !host.includes(".") ||
      /^\[|^[\d.]+$/.test(host) ||
      /(^|\.)(localhost|local|lan)$/.test(host)
    )
      return null;
    if (excluded.some((e) => host === e || host.endsWith("." + e))) return null;
    for (const key of u.searchParams.keys())
      if (sensitive.has(key.toLowerCase())) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}
export function excludedHost(input: string) {
  try {
    return new URL(
      /^https?:\/\//i.test(input) ? input : "https://" + input,
    ).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return null;
  }
}
export function filterVisits(
  visits: RawVisit[],
  excluded: string[],
  now = Date.now(),
  days = 30,
) {
  return visits.flatMap((v) => {
    const u = typeof v?.u === "string" ? recordableUrl(v.u, excluded) : null;
    return u &&
      typeof v.ti === "string" &&
      Number.isFinite(v.at) &&
      v.at >= now - days * 86400000 &&
      v.at <= now + 60000
      ? [{ u, ti: v.ti.slice(0, 2000), at: v.at }]
      : [];
  });
}
export function safeSlot(
  payload: Slot["payload"],
  excluded: string[],
): Slot["payload"] {
  let remaining = 200;
  const windows = (payload.windows || [])
    .map((w) => ({
      focused: !!w.focused,
      tabs: (w.tabs || []).flatMap((t: TabItem) => {
        const u =
          typeof t?.u === "string" ? recordableUrl(t.u, excluded) : null;
        return u && remaining-- > 0
          ? [{ u, ti: String(t.ti || "").slice(0, 2000), active: !!t.active }]
          : [];
      }),
    }))
    .filter((w) => w.tabs.length);
  const lastUrl = payload.last && recordableUrl(payload.last.u, excluded);
  return {
    windows,
    ...(lastUrl && payload.last && Number.isFinite(payload.last.at)
      ? { last: { ...payload.last, u: lastUrl } }
      : {}),
  };
}
export async function visitId(dev: string, u: string, at: number) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(dev + "|" + u + "|" + Math.floor(at / 60000)),
  );
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, 22);
}
export function textTerms(text: string) {
  return [
    ...new Set(
      Array.from({ length: Math.max(0, text.length - 2) }, (_, i) =>
        text.slice(i, i + 3),
      ),
    ),
  ];
}
