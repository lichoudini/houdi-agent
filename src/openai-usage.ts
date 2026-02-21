export type OpenAiUsageSource = "ask" | "image" | "shell" | "audio";

export type OpenAiUsageEvent = {
  atMs: number;
  model: string;
  source: OpenAiUsageSource;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type OpenAiUsageAggregate = {
  model: string;
  source: OpenAiUsageSource;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type OpenAiUsageSnapshot = {
  sinceMs: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byModelAndSource: OpenAiUsageAggregate[];
};

type Pricing = {
  inputPer1M: number;
  outputPer1M: number;
};

const DEFAULT_PRICING: Record<string, Pricing> = {
  "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.2 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1-mini": { inputPer1M: 0.2, outputPer1M: 0.8 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  o3: { inputPer1M: 4, outputPer1M: 16 },
  o1: { inputPer1M: 15, outputPer1M: 60 },
  "whisper-1": { inputPer1M: 0, outputPer1M: 0 },
};

function pickPricing(model: string): Pricing {
  const normalized = model.trim().toLowerCase();
  if (DEFAULT_PRICING[normalized]) {
    return DEFAULT_PRICING[normalized];
  }
  const family = Object.entries(DEFAULT_PRICING).find(([key]) => normalized.startsWith(`${key}-`) || normalized.includes(key));
  if (family) {
    return family[1];
  }
  return { inputPer1M: 0, outputPer1M: 0 };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class OpenAiUsageTracker {
  private readonly events: OpenAiUsageEvent[] = [];
  private readonly startedAtMs = Date.now();

  record(event: Omit<OpenAiUsageEvent, "estimatedCostUsd">): OpenAiUsageEvent {
    const pricing = pickPricing(event.model);
    const estimatedCostUsd =
      (Math.max(0, event.inputTokens) * pricing.inputPer1M) / 1_000_000 +
      (Math.max(0, event.outputTokens) * pricing.outputPer1M) / 1_000_000;
    const normalized: OpenAiUsageEvent = {
      ...event,
      inputTokens: Math.max(0, Math.floor(event.inputTokens)),
      outputTokens: Math.max(0, Math.floor(event.outputTokens)),
      totalTokens: Math.max(0, Math.floor(event.totalTokens)),
      estimatedCostUsd: roundUsd(estimatedCostUsd),
    };
    this.events.push(normalized);
    if (this.events.length > 20_000) {
      this.events.splice(0, this.events.length - 20_000);
    }
    return normalized;
  }

  reset(): void {
    this.events.splice(0, this.events.length);
  }

  snapshot(): OpenAiUsageSnapshot {
    const aggregateMap = new Map<string, OpenAiUsageAggregate>();
    let totalCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let estimatedCostUsd = 0;

    for (const item of this.events) {
      totalCalls += 1;
      totalInputTokens += item.inputTokens;
      totalOutputTokens += item.outputTokens;
      totalTokens += item.totalTokens;
      estimatedCostUsd += item.estimatedCostUsd;

      const key = `${item.model}::${item.source}`;
      const previous = aggregateMap.get(key);
      aggregateMap.set(key, {
        model: item.model,
        source: item.source,
        calls: (previous?.calls ?? 0) + 1,
        inputTokens: (previous?.inputTokens ?? 0) + item.inputTokens,
        outputTokens: (previous?.outputTokens ?? 0) + item.outputTokens,
        totalTokens: (previous?.totalTokens ?? 0) + item.totalTokens,
        estimatedCostUsd: roundUsd((previous?.estimatedCostUsd ?? 0) + item.estimatedCostUsd),
      });
    }

    return {
      sinceMs: this.startedAtMs,
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCostUsd: roundUsd(estimatedCostUsd),
      byModelAndSource: [...aggregateMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    };
  }
}

export function formatUsd(value: number): string {
  if (value === 0) {
    return "0.000000";
  }
  if (value < 0.000001) {
    return "<0.000001";
  }
  return value.toFixed(6);
}
