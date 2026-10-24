import { type AppData, type Tombstone, ordered, cleanSettings } from "./model";
const compare = (a: unknown, b: unknown) =>
  JSON.stringify(a).localeCompare(JSON.stringify(b), "en");
function entities<T extends { id: string; updatedAt: number }>(
  a: T[],
  b: T[],
): T[] {
  const m = new Map<string, T>();
  for (const x of [...a, ...b]) {
    const old = m.get(x.id);
    if (
      !old ||
      x.updatedAt > old.updatedAt ||
      (x.updatedAt === old.updatedAt && compare(x, old) > 0)
    )
      m.set(x.id, structuredClone(x));
  }
  return [...m.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}
export function merge(
  local: AppData,
  remote: AppData,
  now = Date.now(),
): AppData {
  const tombs = new Map<string, Tombstone>();
  for (const t of [...local.tombstones, ...remote.tombstones]) {
    const k = `${t.kind}:${t.id}`;
    if ((tombs.get(k)?.deletedAt ?? -1) < t.deletedAt) tombs.set(k, { ...t });
  }
  const alive = (kind: string) => (e: { id: string; updatedAt: number }) =>
    (tombs.get(`${kind}:${e.id}`)?.deletedAt ?? -1) < e.updatedAt;
  const groups = ordered(
    entities(local.groups, remote.groups).filter(alive("group")),
  );
  // A deterministic safety group is necessary when all groups were deleted concurrently.
  if (!groups.length)
    groups.push({
      id: "default-common",
      name: "常用",
      order: 0,
      updatedAt:
        Math.max(
          local.settings.updatedAt,
          remote.settings.updatedAt,
          ...[...tombs.values()].map((t) => t.deletedAt),
        ) + 1,
    });
  const bookmarks = ordered(
    entities(local.bookmarks, remote.bookmarks).filter(alive("bookmark")),
  ).map((b) => ({
    ...b,
    groupId: groups.some((g) => g.id === b.groupId) ? b.groupId : groups[0].id,
  }));
  const a = cleanSettings(local.settings),
    b = cleanSettings(remote.settings);
  return {
    schema: 2,
    profile: structuredClone(
      local.profile.updatedAt > remote.profile.updatedAt ||
        (local.profile.updatedAt === remote.profile.updatedAt &&
          compare(local.profile, remote.profile) >= 0)
        ? local.profile
        : remote.profile,
    ),
    settings: structuredClone(
      a.updatedAt > b.updatedAt ||
        (a.updatedAt === b.updatedAt && compare(a, b) >= 0)
        ? a
        : b,
    ),
    groups,
    bookmarks,
    searchEngines: entities(local.searchEngines, remote.searchEngines).filter(alive("searchEngine")),
    tombstones: [...tombs.values()]
      .filter((t) => t.deletedAt >= now - 90 * 86400000)
      .sort((a, b) =>
        `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`, "en"),
      ),
  };
}
