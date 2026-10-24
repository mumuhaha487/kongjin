import type { AppData } from "./model";
export function normalizeUrl(s: string): string | null {
  try {
    const value = s.trim();
    if (!value || /\s/.test(value)) return null;
    const u = new URL(
      /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`,
    );
    return ["http:", "https:"].includes(u.protocol) &&
      !!u.hostname &&
      (u.hostname.includes(".") || u.hostname === "localhost")
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export const isAddress = (s: string) =>
  !/\s/.test(s.trim()) &&
  (/^https?:\/\//i.test(s.trim()) || /^[^/]+\.[^/]+/.test(s.trim())) &&
  !!normalizeUrl(s);
export function autoTitle(s: string) {
  const u = normalizeUrl(s);
  if (!u) return "";
  const n = new URL(u).hostname.replace(/^www\./, "").split(".")[0];
  return n[0].toUpperCase() + n.slice(1);
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string";
const time = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
export function validateData(v: unknown): v is AppData {
  if (!object(v) || v.schema !== 2 || !object(v.settings)) return false;
  const s = v.settings;
  if (s.smoothFirst !== undefined && typeof s.smoothFirst !== "boolean") return false;
  if (
    !["system", "dark", "light"].includes(String(s.theme)) ||
    !["sky", "mist", "dusk", "nebula", "sakura"].includes(String(s.accent)) ||
    !["kongjing", "solid", "image"].includes(String(s.background)) ||
    !["favicon", "letter"].includes(String(s.iconStyle)) ||
    ![6, 7, 8].includes(Number(s.columns)) ||
    !time(s.updatedAt)
  )
    return false;
  if (
    ![
      "animated",
      "grain",
      "hour24",
      "seconds",
      "greeting",
      "newTab",
      "history",
      "labels",
    ].every((k) => typeof s[k] === "boolean") ||
    !["imageUrl", "quickGroup"].every((k) => text(s[k]))
  )
    return false;
  if (
    !object(v.profile) ||
    !text(v.profile.nickname) ||
    Array.from(v.profile.nickname as string).length > 20 ||
    !time(v.profile.updatedAt)
  )
    return false;
  if (
    v.profile.avatar !== undefined &&
    (!text(v.profile.avatar) ||
      !/^(https?:\/\/|data:image\/webp;base64,)/.test(
        v.profile.avatar as string,
      ))
  )
    return false;
  if (
    !Array.isArray(s.hiddenSites) ||
    !s.hiddenSites.every(text) ||
    !["top", "left", "right"].includes(String(s.barPosition)) ||
    typeof s.barEnabled !== "boolean" ||
    typeof s.autoClose !== "boolean"
  )
    return false;
  const arrays = ["groups", "bookmarks", "tombstones", "searchEngines"];
  if (!arrays.every((k) => Array.isArray(v[k]))) return false;
  const a = v as unknown as AppData;
  const unique = (items: { id: string }[]) =>
    new Set(items.map((x) => x.id)).size === items.length;
  if (
    !a.groups.length ||
    !a.groups.every(
      (g) =>
        object(g) &&
        text(g.id) &&
        !!g.id &&
        text(g.name) &&
        !!g.name &&
        time(g.order) &&
        time(g.updatedAt),
    ) ||
    !unique(a.groups)
  )
    return false;
  if (
    !a.bookmarks.every(
      (b) =>
        object(b) &&
        text(b.id) &&
        !!b.id &&
        text(b.groupId) &&
        text(b.title) &&
        text(b.url) &&
        !!normalizeUrl(b.url) &&
        object(b.icon) &&
        ["auto", "letter", "custom"].includes(String(b.icon.mode)) &&
        (b.icon.tone === undefined ||
          ["dark", "light", "normal"].includes(b.icon.tone)) &&
        (b.icon.url === undefined ||
          (text(b.icon.url) && !!normalizeUrl(b.icon.url))) &&
        (b.icon.dataUrl === undefined ||
          (text(b.icon.dataUrl) &&
            /^data:image\/(webp|png);base64,/.test(b.icon.dataUrl) &&
            b.icon.dataUrl.length <= 8300)) &&
        time(b.order) &&
        time(b.createdAt) &&
        time(b.updatedAt),
    ) ||
    !unique(a.bookmarks)
  )
    return false;
  if (
    !a.searchEngines.every(
      (e) =>
        object(e) &&
        text(e.id) &&
        text(e.name) &&
        !!e.name &&
        text(e.url) &&
        e.url.includes("%s") &&
        !!normalizeUrl(e.url.replace("%s", "x")) &&
        time(e.updatedAt),
    ) ||
    !unique(a.searchEngines)
  )
    return false;
  return a.tombstones.every(
    (t) =>
      object(t) &&
      text(t.id) &&
      ["group", "bookmark", "searchEngine"].includes(t.kind) &&
      time(t.deletedAt),
  );
}
