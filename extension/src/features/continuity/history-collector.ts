import type { RawVisit } from "./types";

interface HistoryItem {
  url?: string;
  title?: string;
  lastVisitTime?: number;
}
interface Clock {
  now(): number;
  setTimeout(fn: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
interface Job {
  url: string;
  visits: RawVisit[];
  due: number;
  retry: boolean;
  cancelled?: boolean;
}
const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** One scheduler batches visits; each URL needs at most one lookup per window. */
export class HistoryTitleCollector {
  private jobs = new Set<Job>();
  private active = new Set<Job>();
  private initial = new Map<string, Job>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private host: {
      enabled(): boolean;
      normalize(url: string): string | null;
      search(query: {
        text: string;
        startTime: number;
        maxResults: number;
      }): Promise<HistoryItem[]>;
      record(visits: RawVisit[]): Promise<unknown>;
    },
    private clock: Clock = systemClock,
  ) {}

  visit(item: HistoryItem) {
    const url = item.url && this.host.normalize(item.url);
    if (!url || !this.host.enabled()) return;
    const visit = {
      u: url,
      ti: "",
      at: item.lastVisitTime || this.clock.now(),
    };
    const existing = this.initial.get(url);
    if (existing) {
      if (!existing.visits.some((v) => v.at === visit.at))
        existing.visits.push(visit);
      return;
    }
    const job: Job = {
      url,
      visits: [visit],
      due: this.clock.now() + 4000,
      retry: false,
    };
    this.initial.set(url, job);
    this.jobs.add(job);
    this.schedule();
  }

  cancel(urls?: string[]) {
    const matches = urls && new Set(urls);
    for (const job of [...this.jobs, ...this.active])
      if (!matches || matches.has(job.url)) {
        job.cancelled = true;
        this.jobs.delete(job);
        this.active.delete(job);
        if (this.initial.get(job.url) === job) this.initial.delete(job.url);
      }
    this.schedule();
  }

  private schedule() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.jobs.size) return;
    const due = Math.min(...[...this.jobs].map((j) => j.due));
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = undefined;
        void this.flush().catch(() => {});
      },
      Math.max(0, due - this.clock.now()),
    );
  }

  private async flush() {
    const groups = new Map<string, Job[]>();
    for (const job of this.jobs)
      if (job.due <= this.clock.now()) {
        this.jobs.delete(job);
        this.active.add(job);
        if (this.initial.get(job.url) === job) this.initial.delete(job.url);
        groups.set(job.url, [...(groups.get(job.url) || []), job]);
      }
    this.schedule();
    if (!this.host.enabled()) {
      this.cancel();
      return;
    }
    const pending = [...groups.entries()];
    const results: { job: Job; title: string }[] = [];
    // Bound outstanding Chrome API calls as well as deduplicating each URL.
    await Promise.all(
      Array.from({ length: Math.min(3, pending.length) }, async () => {
        while (pending.length) {
          const [url, jobs] = pending.shift()!;
          if (jobs.every((j) => j.cancelled) || !this.host.enabled()) continue;
          const items = await this.host
            .search({
              text: url,
              startTime:
                Math.min(...jobs.flatMap((j) => j.visits.map((v) => v.at))) -
                1000,
              maxResults: 10,
            })
            .catch(() => []);
          const latest = items
            .filter((v) => v.url && this.host.normalize(v.url) === url)
            .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))[0];
          const title = latest?.title?.trim() || "";
          jobs.forEach((job) => results.push({ job, title }));
        }
      }),
    );
    try {
      const visits = results.flatMap(({ job, title }) =>
        !job.cancelled && this.host.enabled() && (!job.retry || title)
          ? job.visits.map((v) => ({ ...v, ti: title }))
          : [],
      );
      if (visits.length) await this.host.record(visits);
      for (const { job, title } of results)
        if (!job.cancelled && this.host.enabled() && !job.retry && !title)
          this.jobs.add({
            url: job.url,
            visits: job.visits,
            due: this.clock.now() + 30000,
            retry: true,
          });
    } finally {
      for (const jobs of groups.values())
        jobs.forEach((job) => this.active.delete(job));
      this.schedule();
    }
  }
}
