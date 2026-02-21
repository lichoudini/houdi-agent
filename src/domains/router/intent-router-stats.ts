import fs from "node:fs/promises";
import path from "node:path";

export type IntentRouterDatasetEntry = {
  ts: string;
  chatId: number;
  userId?: number;
  hasMailContext: boolean;
  hasMemoryRecallCue: boolean;
  text: string;
  source: string;
  routeCandidates: string[];
  routeFilterReason?: string;
  routeFilterAllowed?: string[];
  semantic?: {
    handler: string;
    score: number;
    reason: string;
    alternatives: Array<{ name: string; score: number }>;
  };
  ai?: {
    handler: string;
    reason?: string;
  };
  finalHandler: string;
  handled: boolean;
};

function quantile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * q));
  const base = Math.floor(pos);
  const rest = pos - base;
  const left = sorted[base] ?? sorted[0] ?? 0;
  const right = sorted[Math.min(sorted.length - 1, base + 1)] ?? left;
  return left + (right - left) * rest;
}

function suggestIntentThreshold(params: {
  current: number;
  truePositiveScores: number[];
  falsePositiveScores: number[];
}): number | null {
  if (params.truePositiveScores.length < 8) {
    return null;
  }
  const lowTruePositive = quantile(params.truePositiveScores, 0.2);
  if (params.falsePositiveScores.length < 5) {
    const conservative = Math.max(params.current, lowTruePositive - 0.01);
    const rounded = Number(Math.max(0.05, Math.min(0.95, conservative)).toFixed(3));
    return Math.abs(rounded - params.current) >= 0.01 ? rounded : null;
  }

  const highFalsePositive = quantile(params.falsePositiveScores, 0.8);
  const candidate =
    highFalsePositive < lowTruePositive
      ? (highFalsePositive + lowTruePositive) / 2
      : lowTruePositive - 0.01;
  const rounded = Number(Math.max(0.05, Math.min(0.95, candidate)).toFixed(3));
  return Math.abs(rounded - params.current) >= 0.01 ? rounded : null;
}

export class IntentRouterStatsRepository {
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly datasetFilePath: string,
    private readonly onWarn: (message: string) => void,
  ) {}

  async append(entry: IntentRouterDatasetEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.persistQueue = this.persistQueue
      .then(async () => {
        await fs.mkdir(path.dirname(this.datasetFilePath), { recursive: true });
        await fs.appendFile(this.datasetFilePath, line, "utf8");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.onWarn(`No pude persistir dataset de intent router: ${message}`);
      });
    await this.persistQueue;
  }

  async read(limit: number): Promise<IntentRouterDatasetEntry[]> {
    try {
      const raw = await fs.readFile(this.datasetFilePath, "utf8");
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const selected = lines.slice(-Math.max(1, Math.min(20_000, limit)));
      const entries: IntentRouterDatasetEntry[] = [];
      for (const line of selected) {
        try {
          const parsed = JSON.parse(line) as IntentRouterDatasetEntry;
          if (parsed && typeof parsed.chatId === "number" && typeof parsed.text === "string") {
            entries.push(parsed);
          }
        } catch {
          continue;
        }
      }
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/enoent/i.test(message)) {
        return [];
      }
      throw error;
    }
  }
}

export async function buildIntentRouterStatsReport(params: {
  limit: number;
  repository: IntentRouterStatsRepository;
  toProjectRelativePath: (inputPath: string) => string;
  datasetFilePath: string;
  routeThresholds: Array<{ name: string; threshold: number }>;
}): Promise<string> {
  const entries = await params.repository.read(params.limit);
  if (entries.length === 0) {
    return [
      "Intent router stats",
      `dataset: ${params.toProjectRelativePath(params.datasetFilePath)}`,
      "No hay muestras todavía.",
    ].join("\n");
  }

  const routeNames = params.routeThresholds.map((item) => item.name);
  const thresholdByRoute = new Map(params.routeThresholds.map((item) => [item.name, item.threshold]));
  const lines: string[] = [
    "Intent router stats",
    `dataset: ${params.toProjectRelativePath(params.datasetFilePath)}`,
    `muestras: ${entries.length}`,
  ];

  const byRoute = new Map<
    string,
    {
      selected: number;
      hit: number;
      falsePositive: number;
      avgScoreNumerator: number;
      tpScores: number[];
      fpScores: number[];
    }
  >();

  for (const routeName of routeNames) {
    byRoute.set(routeName, {
      selected: 0,
      hit: 0,
      falsePositive: 0,
      avgScoreNumerator: 0,
      tpScores: [],
      fpScores: [],
    });
  }

  let filteredCount = 0;
  for (const entry of entries) {
    if ((entry.routeFilterAllowed?.length ?? 0) > 0 && (entry.routeFilterAllowed?.length ?? 0) < entry.routeCandidates.length) {
      filteredCount += 1;
    }
    if (!entry.semantic) {
      continue;
    }
    const routeStats = byRoute.get(entry.semantic.handler);
    if (!routeStats) {
      continue;
    }
    routeStats.selected += 1;
    routeStats.avgScoreNumerator += entry.semantic.score;
    if (entry.finalHandler === entry.semantic.handler) {
      routeStats.hit += 1;
      routeStats.tpScores.push(entry.semantic.score);
    } else {
      routeStats.falsePositive += 1;
      routeStats.fpScores.push(entry.semantic.score);
    }
  }

  lines.push(`route_filter aplicado: ${filteredCount}/${entries.length}`);
  lines.push("");
  lines.push("Por ruta:");
  for (const routeName of routeNames) {
    const stats = byRoute.get(routeName);
    if (!stats) {
      continue;
    }
    const currentThreshold = thresholdByRoute.get(routeName) ?? 0;
    const avgScore = stats.selected > 0 ? stats.avgScoreNumerator / stats.selected : 0;
    const precision = stats.selected > 0 ? stats.hit / stats.selected : 0;
    const suggested = suggestIntentThreshold({
      current: currentThreshold,
      truePositiveScores: stats.tpScores,
      falsePositiveScores: stats.fpScores,
    });
    lines.push(
      [
        `- ${routeName}`,
        `selected=${stats.selected}`,
        `hit=${stats.hit}`,
        `fp=${stats.falsePositive}`,
        `precision=${(precision * 100).toFixed(1)}%`,
        `avg_score=${avgScore.toFixed(3)}`,
        `threshold=${currentThreshold.toFixed(3)}`,
        `suggested=${suggested === null ? "sin cambio" : suggested.toFixed(3)}`,
      ].join(" | "),
    );
  }

  return lines.join("\n");
}
