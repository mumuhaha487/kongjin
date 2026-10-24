import { defaults, cleanSettings, type AppData } from "./model";
import { validateData } from "./validation";
const mapping: Record<string, string> = {
  glacier: "sky",
  jade: "mist",
  ember: "dusk",
  iris: "nebula",
  rose: "sakura",
};
export function migrate(input: unknown, username = ""): AppData | null {
  if (validateData(input)) {
    const data = structuredClone(input);
    data.settings = cleanSettings(data.settings);
    return data;
  }
  if (!input || typeof input !== "object") return null;
  const v = input as Record<string, unknown>;
  if (v.schema !== 1 || !v.settings || !Array.isArray(v.bookmarks)) return null;
  const old = v.settings as Record<string, unknown>;
  const base = defaults();
  const settings = {
    ...base.settings,
    ...old,
    autoClose: true,
    accent: mapping[String(old.accent)] || "sky",
    background: old.background === "aurora" ? "kongjing" : old.background,
  };
  delete (settings as Record<string, unknown>).nickname;
  delete (settings as Record<string, unknown>).engine;
  const clean = {
    schema: 2,
    settings,
    profile: {
      nickname: Array.from(username || String(old.nickname || ""))
        .slice(0, 20)
        .join(""),
      updatedAt: Number(old.updatedAt) || 0,
    },
    groups: v.groups,
    bookmarks: v.bookmarks.map((b: unknown) => ({
      ...(b as object),
      icon: { mode: "auto" },
    })),
    tombstones: v.tombstones,
    searchEngines: v.searchEngines,
  };
  return validateData(clean) ? clean : null;
}
