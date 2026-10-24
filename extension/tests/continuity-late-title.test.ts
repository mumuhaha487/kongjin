import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { LateHistoryTitles } from "../src/features/continuity/late-history-title";
import { recordableUrl } from "../src/features/continuity/privacy";
import type { RawVisit } from "../src/features/continuity/types";
const at = 1700000000000,
  url = "https://example.com/delayed";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
function fixture() {
  const host = {
    enabled: () => true,
    normalize: recordableUrl,
    record: vi.fn(async (_visits: RawVisit[]) => {}),
  };
  const tracker = new LateHistoryTitles(host, () => Date.now());
  const load = (id = 1, u = url) =>
    tracker.updated(
      id,
      { url: u, status: "loading" },
      { url: u, incognito: false },
    );
  const visit = (u = url) =>
    tracker.visited({ url: u, lastVisitTime: Date.now() });
  const title = (value = "十一秒后才出现的标题", id = 1, u = url) =>
    tracker.updated(id, { title: value }, { url: u, incognito: false });
  return { tracker, host, load, visit, title };
}
describe("late desktop titles with an injected clock", () => {
  it("can replace a URL placeholder emitted by the tab before its real title", async () => {
    const { load, visit, title, host } = fixture();
    await load();
    visit();
    await title(url);
    await vi.advanceTimersByTimeAsync(11000);
    await title();
    expect(host.record).toHaveBeenLastCalledWith([
      { u: url, at, ti: "十一秒后才出现的标题" },
    ]);
  });
  it("submits the title eleven seconds later using the original visit timestamp", async () => {
    const { load, visit, title, host, tracker } = fixture();
    await load();
    visit();
    await tracker.updated(1, { status: "complete" }, { url });
    await vi.advanceTimersByTimeAsync(11000);
    await title();
    expect(host.record).toHaveBeenCalledExactlyOnceWith([
      { u: url, at, ti: "十一秒后才出现的标题" },
    ]);
    await title("后来的标题");
    expect(host.record).toHaveBeenCalledTimes(1);
  });
  it("accepts the two-minute boundary and rejects a title after it", async () => {
    const { load, visit, title, host } = fixture();
    await load();
    visit();
    await load(2, url + "-other");
    visit(url + "-other");
    await vi.advanceTimersByTimeAsync(120000);
    await title();
    expect(host.record).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await title("过期", 2, url + "-other");
    expect(host.record).toHaveBeenCalledTimes(1);
  });
  it("handles history-before-tab event order and a later loading event without losing at", async () => {
    const { load, visit, title, tracker, host } = fixture();
    visit();
    await load();
    await tracker.updated(1, { status: "loading" }, { url });
    await vi.advanceTimersByTimeAsync(11000);
    await title();
    expect(host.record).toHaveBeenCalledExactlyOnceWith([
      { u: url, at, ti: "十一秒后才出现的标题" },
    ]);
  });
  it("requires the original tab and URL, and does not use an unrelated tab's title", async () => {
    const { load, visit, title, host } = fixture();
    await load();
    visit();
    await title("其他标签页", 2);
    await title("其他网址", 1, "https://other.example.com/");
    expect(host.record).not.toHaveBeenCalled();
    await title();
    expect(host.record).toHaveBeenCalledOnce();
  });
  it("requires tabs/history authorization and ignores incognito, private and sensitive URLs", async () => {
    const { load, visit, title, host, tracker } = fixture();
    host.enabled = () => false;
    await load();
    visit();
    await title();
    expect(host.record).not.toHaveBeenCalled();
    host.enabled = () => true;
    await tracker.updated(
      1,
      { url, status: "loading" },
      { url, incognito: true },
    );
    visit();
    await tracker.updated(1, { title: "无痕" }, { url, incognito: true });
    for (const u of [
      "http://127.0.0.1/",
      "https://example.com/?token=secret",
    ]) {
      await load(2, u);
      visit(u);
      await title("隐私", 2, u);
    }
    expect(host.record).not.toHaveBeenCalled();
  });
  it("cancels on navigation, tab close, history deletion and permission removal", async () => {
    const { load, visit, title, host, tracker } = fixture();
    await load();
    visit();
    await load(1, url + "/next");
    await title();
    expect(host.record).not.toHaveBeenCalled();
    for (const cancel of [
      () => tracker.removed(1),
      () => tracker.cancel([url]),
      () => tracker.cancel(),
    ]) {
      await load();
      visit();
      cancel();
      await title();
    }
    expect(host.record).not.toHaveBeenCalled();
  });
  it("does not guess when two tabs navigate to the same URL concurrently", async () => {
    const { load, visit, title, host } = fixture();
    await load(1);
    await load(2);
    visit();
    await title("不确定属于谁", 1);
    await title("不确定属于谁", 2);
    expect(host.record).not.toHaveBeenCalled();
  });
  it("ignores whitespace titles and rechecks the current exclusion list", async () => {
    const { load, visit, title, host } = fixture();
    await load();
    visit();
    await title(" ");
    expect(host.record).not.toHaveBeenCalled();
    host.normalize = (u) => recordableUrl(u, ["example.com"]);
    await title();
    expect(host.record).not.toHaveBeenCalled();
  });
});
