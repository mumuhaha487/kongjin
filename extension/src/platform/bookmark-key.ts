import { normalizeUrl } from "../lib/validation";
import type { Bookmark } from "../lib/model";
export function bookmarkKey(input: string) {
  const normalized = normalizeUrl(input);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.hash = "";
  return url.href;
}
export function findBookmark(bookmarks: Bookmark[], url: string) {
  const key = bookmarkKey(url);
  return key ? bookmarks.find((b) => bookmarkKey(b.url) === key) : undefined;
}
