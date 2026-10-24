import type { Bookmark } from "../lib/model";

export function searchBookmarks(
  bookmarks: readonly Bookmark[],
  query: string,
  limit = 6,
) {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return bookmarks
    .map((bookmark, index) => {
      const title = bookmark.title.toLowerCase();
      const rank = title.startsWith(term)
        ? 0
        : title.includes(term)
          ? 1
          : bookmark.url.toLowerCase().includes(term)
            ? 2
            : 3;
      return { bookmark, index, rank };
    })
    .filter(({ rank }) => rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map(({ bookmark }) => ({
      title: bookmark.title,
      url: bookmark.url,
      ...(bookmark.icon.dataUrl ? { iconDataUrl: bookmark.icon.dataUrl } : {}),
    }));
}
