export type MetricTagSet = Record<string, string | number | boolean | null | undefined>;

type CounterEntry = {
  name: string;
  tagsKey: string;
  tags: Record<string, string>;
  value: number;
};

type TimingStats = {
  name: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
};

function normalizeTags(tags?: MetricTagSet): Record<string, string> {
  if (!tags) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(tags)) {
    if (raw === null || typeof raw === "undefined") {
      continue;
    }
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }
    out[normalizedKey] = String(raw).trim();
  }
  return out;
}

function buildTagsKey(tags: Record<string, string>): string {
  const entries = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${value}`).join("|");
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * q));
  const leftIndex = Math.floor(position);
  const rightIndex = Math.min(sorted.length - 1, leftIndex + 1);
  const weight = position - leftIndex;
  const left = sorted[leftIndex] ?? sorted[0] ?? 0;
  const right = sorted[rightIndex] ?? left;
  return left + (right - left) * weight;
}

export class ObservabilityService {
  private readonly counters = new Map<string, CounterEntry>();
  private readonly timings = new Map<string, number[]>();

  increment(name: string, amount = 1, tags?: MetricTagSet): void {
    const metricName = name.trim();
    if (!metricName) {
      return;
    }
    const normalizedAmount = Number.isFinite(amount) ? amount : 1;
    const normalizedTags = normalizeTags(tags);
    const tagsKey = buildTagsKey(normalizedTags);
    const compositeKey = `${metricName}::${tagsKey}`;
    const previous = this.counters.get(compositeKey);
    this.counters.set(compositeKey, {
      name: metricName,
      tagsKey,
      tags: normalizedTags,
      value: (previous?.value ?? 0) + normalizedAmount,
    });
  }

  timing(name: string, ms: number): void {
    const metricName = name.trim();
    if (!metricName || !Number.isFinite(ms)) {
      return;
    }
    const value = Math.max(0, Math.floor(ms));
    const series = this.timings.get(metricName) ?? [];
    series.push(value);
    if (series.length > 5000) {
      series.splice(0, series.length - 5000);
    }
    this.timings.set(metricName, series);
  }

  listCounters(): CounterEntry[] {
    return [...this.counters.values()].sort((a, b) => {
      if (a.name !== b.name) {
        return a.name.localeCompare(b.name);
      }
      return a.tagsKey.localeCompare(b.tagsKey);
    });
  }

  listTimingStats(): TimingStats[] {
    const out: TimingStats[] = [];
    for (const [name, values] of this.timings.entries()) {
      if (values.length === 0) {
        continue;
      }
      const totalMs = values.reduce((acc, current) => acc + current, 0);
      const minMs = Math.min(...values);
      const maxMs = Math.max(...values);
      out.push({
        name,
        count: values.length,
        totalMs,
        minMs,
        maxMs,
        p50Ms: Math.round(quantile(values, 0.5)),
        p95Ms: Math.round(quantile(values, 0.95)),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  snapshot(): {
    counters: CounterEntry[];
    timings: TimingStats[];
  } {
    return {
      counters: this.listCounters(),
      timings: this.listTimingStats(),
    };
  }
}
