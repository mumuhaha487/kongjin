import { describe, expect, it } from "vitest";
import type { Bookmark } from "../src/lib/model";
import { searchBookmarks } from "../src/platform/bookmark-search";

function bookmark(
  title: string,
  url = "https://example.com/",
  groupId = "a",
): Bookmark {
  return {
    id: title,
    title,
    url,
    groupId,
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    icon: { mode: "auto" },
  };
}

describe("native bookmark suggestions", () => {
  it("ranks title prefixes, title substrings, then URL substrings without case sensitivity", () => {
    const books = [
      bookmark("网址匹配", "https://EXAMPLE.com/KoNgJiNg"),
      bookmark("About Kongjing"),
      bookmark("KONGJING Home"),
      bookmark("Kongjing Docs"),
      bookmark("Other"),
    ];
    expect(searchBookmarks(books, "kOnGjInG").map((b) => b.title)).toEqual([
      "KONGJING Home",
      "Kongjing Docs",
      "About Kongjing",
      "网址匹配",
    ]);
  });
  it("defaults to six, applies the limit after ranking and accepts zero", () => {
    const books = Array.from({ length: 8 }, (_, i) => bookmark("空境" + i));
    books.unshift(bookmark("了解空境"));
    expect(searchBookmarks(books, "空境")).toHaveLength(6);
    expect(searchBookmarks(books, "空境", 2).map((b) => b.title)).toEqual([
      "空境0",
      "空境1",
    ]);
    expect(searchBookmarks(books, "空境", 0)).toEqual([]);
  });
  it("matches Chinese titles across all groups and keeps ties stable", () => {
    const books = [
      bookmark("我的设计资料", undefined, "a"),
      bookmark("设计规范", undefined, "b"),
      bookmark("设计参考", undefined, "c"),
    ];
    expect(searchBookmarks(books, "设计").map((b) => b.title)).toEqual([
      "设计规范",
      "设计参考",
      "我的设计资料",
    ]);
  });
  it("returns an empty array for empty queries and no matches", () => {
    const books = [bookmark("空境")];
    for (const query of ["", "  \t", "不存在"])
      expect(searchBookmarks(books, query)).toEqual([]);
    expect(searchBookmarks([], "空境")).toEqual([]);
  });
  it("returns only the contract fields, including a cached icon when present", () => {
    const books = [bookmark("空境"), bookmark("空境资料")];
    books[0].icon.dataUrl = "data:image/webp;base64,dGVzdA==";
    expect(searchBookmarks(books, " 空境 ")).toEqual([
      {
        title: "空境",
        url: "https://example.com/",
        iconDataUrl: books[0].icon.dataUrl,
      },
      { title: "空境资料", url: "https://example.com/" },
    ]);
  });
  it("does not mutate the synced bookmark data", () => {
    const books = [bookmark("了解空境"), bookmark("空境")];
    const before = structuredClone(books);
    searchBookmarks(books, "空境");
    expect(books).toEqual(before);
  });
});
