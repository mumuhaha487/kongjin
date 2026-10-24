import type { RawVisit } from "./types";

interface Navigation {
  url: string;
  seen: number;
  loading: boolean;
  visit?: RawVisit;
}
interface Tab {
  url?: string;
  pendingUrl?: string;
  incognito?: boolean;
}
const windowMs = 120000;

/** Correlate history visits with observed tab navigations, never just a title URL. */
export class LateHistoryTitles {
  private tabs = new Map<number, Navigation>();
  private pending = new Map<string, RawVisit>();
  constructor(
    private host: {
      enabled(): boolean;
      normalize(url: string): string | null;
      record(visits: RawVisit[]): Promise<unknown>;
    },
    private now = () => Date.now(),
  ) {}

  visited(item: { url?: string; lastVisitTime?: number }) {
    this.prune();
    const url = item.url && this.host.normalize(item.url);
    if (!this.host.enabled() || !url) return;
    const visit = { u: url, ti: "", at: item.lastVisitTime || this.now() };
    const candidates = [...this.tabs.values()].filter(
      (tab) => tab.url === url && !tab.visit,
    );
    if (candidates.length === 1) candidates[0].visit = visit;
    // History has no tabId. Never guess between simultaneous same-URL loads.
    else if (!candidates.length) this.pending.set(url, visit);
  }

  async updated(
    id: number,
    change: { url?: string; status?: string; title?: string },
    tab: Tab,
  ) {
    this.prune();
    const url = this.host.normalize(
      change.url || tab.pendingUrl || tab.url || "",
    );
    if (!this.host.enabled() || tab.incognito || !url) {
      this.tabs.delete(id);
      return;
    }
    let navigation = this.tabs.get(id);
    if (!change.url && change.status !== "loading" && navigation?.url !== url)
      return;
    if (
      navigation?.url !== url ||
      (!navigation.loading && (change.url || change.status === "loading"))
    ) {
      navigation = { url, seen: this.now(), loading: true };
      this.tabs.set(id, navigation);
    }
    if (!navigation) return;
    if (change.status === "complete") navigation.loading = false;
    const pending = this.pending.get(url);
    if (!navigation.visit && pending) {
      navigation.visit = pending;
      this.pending.delete(url);
    }
    const visit = navigation.visit;
    const title = change.title?.trim();
    if (
      !visit ||
      !title ||
      (visit.ti && visit.ti !== visit.u) ||
      this.now() - visit.at > windowMs ||
      this.now() < visit.at ||
      this.host.normalize(tab.url || "") !== url
    )
      return;
    // Keep the actual visit timestamp even if Chrome's history title stays empty.
    await this.host.record([{ ...visit, ti: title }]);
    visit.ti = title;
  }

  removed(id: number) {
    this.tabs.delete(id);
  }
  cancel(urls?: string[]) {
    const matching = urls && new Set(urls);
    for (const [id, tab] of this.tabs)
      if (!matching || matching.has(tab.url)) this.tabs.delete(id);
    for (const url of this.pending.keys())
      if (!matching || matching.has(url)) this.pending.delete(url);
  }
  private prune() {
    for (const [id, tab] of this.tabs)
      if (this.now() - (tab.visit?.at ?? tab.seen) > windowMs)
        this.tabs.delete(id);
    for (const [url, visit] of this.pending)
      if (this.now() - visit.at > windowMs) this.pending.delete(url);
  }
}
