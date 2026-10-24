import type { AppData, BookmarkIcon } from "./model";
import { findBookmark } from "../platform/bookmark-key";
import { normalizeUrl, autoTitle } from "./validation";

export function addReadLater(
  data: AppData,
  input: { url: string; title?: string; icon?: BookmarkIcon },
  now = Date.now(),
) {
  const url = normalizeUrl(input.url);
  if (!url) throw Error("INVALID_URL");
  let group = data.groups.find((g) => g.name === "稍后阅读");
  if (!group) {
    group = {
      id: crypto.randomUUID(),
      name: "稍后阅读",
      order: Math.max(-1, ...data.groups.map((g) => g.order)) + 1,
      updatedAt: now,
    };
    data.groups.push(group);
  }
  const existing = findBookmark(
    data.bookmarks.filter((b) => b.groupId === group.id),
    url,
  );
  if (existing) return { id: existing.id, groupId: group.id };
  const bookmark = {
    id: crypto.randomUUID(),
    groupId: group.id,
    url,
    title: (input.title?.trim() || autoTitle(url)).slice(0, 200),
    icon: input.icon || { mode: "auto" as const },
    createdAt: now,
    updatedAt: now,
    order:
      Math.max(
        -1,
        ...data.bookmarks
          .filter((b) => b.groupId === group.id)
          .map((b) => b.order),
      ) + 1,
  };
  data.bookmarks.push(bookmark);
  return { id: bookmark.id, groupId: group.id };
}
