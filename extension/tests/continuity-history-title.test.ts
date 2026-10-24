import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryTitleCollector } from "../src/features/continuity/history-collector";
import { historyTitle } from "../src/features/continuity/history-title";
import { recordableUrl } from "../src/features/continuity/privacy";
import type { RawVisit } from "../src/features/continuity/types";

const at = 1700000000000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
function fixture() {
  const search = vi.fn(async (_query: object) => [
    {
      url: "https://example.com/docs",
      title: "接力测试网页",
      lastVisitTime: at,
    },
  ]);
  const record = vi.fn(async (_visits: RawVisit[]) => {});
  const host = {
    enabled: () => true,
    normalize: recordableUrl,
    search,
    record,
  };
  const collector = new HistoryTitleCollector(host, {
    now: () => Date.now(),
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  });
  const visit = (url = "https://example.com/docs", time = at) =>
    collector.visit({ url, lastVisitTime: time });
  return { collector, host, search, record, visit };
}
describe("desktop delayed title collection with an injected clock", () => {
  it("waits four seconds, queries the exact URL and batches repeated visits", async () => {
    const { visit, search, record } = fixture();
    visit();
    await vi.advanceTimersByTimeAsync(2000);
    visit(undefined, at + 2000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(search).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledExactlyOnceWith({
      text: "https://example.com/docs",
      startTime: at - 1000,
      maxResults: 10,
    });
    expect(record).toHaveBeenCalledExactlyOnceWith([
      { u: "https://example.com/docs", ti: "接力测试网页", at },
      { u: "https://example.com/docs", ti: "接力测试网页", at: at + 2000 },
    ]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(search).toHaveBeenCalledTimes(1);
  });
  it("records empty initially then retries once 30 seconds later with the original at", async () => {
    const { visit, search, record } = fixture();
    search.mockResolvedValueOnce([]);
    visit();
    await vi.advanceTimersByTimeAsync(4000);
    expect(record).toHaveBeenLastCalledWith([
      { u: "https://example.com/docs", ti: "", at },
    ]);
    await vi.advanceTimersByTimeAsync(29999);
    expect(search).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenLastCalledWith([
      { u: "https://example.com/docs", ti: "接力测试网页", at },
    ]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(search).toHaveBeenCalledTimes(2);
  });
  it("uses only the newest exact-URL result, not a matching search substring", async () => {
    const { visit, search, record } = fixture();
    search.mockResolvedValueOnce([
      {
        url: "https://example.com/docs/other",
        title: "错误网页",
        lastVisitTime: at + 3000,
      },
      {
        url: "https://example.com/docs",
        title: "旧标题",
        lastVisitTime: at - 100,
      },
      {
        url: "https://example.com/docs#section",
        title: "最新标题",
        lastVisitTime: at,
      },
    ]);
    visit();
    await vi.advanceTimersByTimeAsync(4000);
    expect(record).toHaveBeenLastCalledWith([
      { u: "https://example.com/docs", ti: "最新标题", at },
    ]);
  });
  it("batches different URLs into one record call and caps concurrent queries at three", async () => {
    const { visit, search, record } = fixture();
    let concurrent = 0,
      peak = 0;
    search.mockImplementation(async (q) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return [
        { url: (q as { text: string }).text, title: "标题", lastVisitTime: at },
      ];
    });
    for (let i = 0; i < 10; i++) {
      visit("https://example.com/" + i);
      visit("https://example.com/" + i);
    }
    await vi.advanceTimersByTimeAsync(4100);
    expect(search).toHaveBeenCalledTimes(10);
    expect(peak).toBe(3);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toHaveLength(10);
  });
  it("does not query private URLs or reintroduce visits removed while queued or in flight", async () => {
    const { visit, collector, search, record } = fixture();
    visit("http://127.0.0.1/");
    visit();
    collector.cancel(["https://example.com/docs"]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(search).not.toHaveBeenCalled();
    search.mockImplementationOnce(async () => {
      collector.cancel();
      return [
        { url: "https://example.com/docs", title: "删除了", lastVisitTime: at },
      ];
    });
    visit();
    await vi.advanceTimersByTimeAsync(4000);
    expect(record).not.toHaveBeenCalled();
  });
  it("stops after the single retry and does not upload an empty retry", async () => {
    const { visit, search, record } = fixture();
    search.mockResolvedValue([]);
    visit();
    await vi.advanceTimersByTimeAsync(94000);
    expect(search).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(1);
  });
  it("cancels the retry when history sharing is disabled", async () => {
    const { visit, host, search, record } = fixture();
    search.mockResolvedValue([]);
    visit();
    await vi.advanceTimersByTimeAsync(4000);
    host.enabled = () => false;
    await vi.advanceTimersByTimeAsync(30000);
    expect(search).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
describe("history title presentation", () => {
  it("keeps real titles and shows hostname plus path for an empty title", () => {
    expect(
      historyTitle({ ti: "", u: "https://developer.chrome.com/docs" }),
    ).toBe("developer.chrome.com/docs");
    expect(historyTitle({ ti: " ", u: "https://example.com/" })).toBe(
      "example.com",
    );
    expect(historyTitle({ ti: "", u: "https://example.com/docs?q=test" })).toBe(
      "example.com/docs?q=test",
    );
    expect(
      historyTitle({ ti: "接力测试网页", u: "https://example.com/" }),
    ).toBe("接力测试网页");
  });
});
