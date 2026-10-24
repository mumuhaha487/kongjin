import { expect, it } from "vitest";
import { defaults } from "../src/lib/model";
import { merge } from "../src/lib/merge";
import { rebaseChange } from "../src/lib/app-data";
import { validateData } from "../src/lib/validation";

it("deleted search engines stay deleted across stale sync and backup validation", () => {
  const before = defaults();
  before.searchEngines.push({ id: "custom", name: "Custom", url: "https://example.com/?q=%s", updatedAt: 1 });
  const after = structuredClone(before); after.searchEngines = [];
  const deleted = rebaseChange(before, before, after);
  expect(validateData(deleted)).toBe(true);
  expect(deleted.tombstones).toContainEqual(expect.objectContaining({ id: "custom", kind: "searchEngine" }));
  expect(merge(deleted, before).searchEngines).toEqual([]);
  expect(merge(before, deleted)).toEqual(merge(deleted, before));
});

it("engine deletion wins a concurrent edit and does not delete a bookmark with the same ID", () => {
  const before = defaults();
  before.searchEngines.push({ id: before.bookmarks[0].id, name: "Custom", url: "https://example.com/?q=%s", updatedAt: 1 });
  const latest = structuredClone(before); latest.searchEngines[0].updatedAt = Date.now() + 1000;
  const after = structuredClone(before); after.searchEngines = [];
  const deleted = rebaseChange(latest, before, after);
  expect(merge(deleted, latest).searchEngines).toEqual([]);
  expect(deleted.bookmarks).toEqual(before.bookmarks);
});
