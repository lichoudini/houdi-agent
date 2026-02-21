import fs from "node:fs/promises";
import path from "node:path";

type CalibrationBin = {
  min: number;
  max: number;
  total: number;
  correct: number;
};

type CalibrationRouteState = {
  bins: CalibrationBin[];
  support: number;
};

type PersistedCalibrationState = {
  version: number;
  updatedAt: string;
  bins: number;
  byRoute: Record<string, CalibrationRouteState>;
};

export type CalibrationSample = {
  predictedRoute: string;
  score: number;
  finalRoute: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class IntentConfidenceCalibrator {
  private readonly byRoute = new Map<string, CalibrationRouteState>();

  constructor(private readonly bins: number = 10) {}

  fit(samples: CalibrationSample[]): void {
    this.byRoute.clear();
    const binsCount = Math.max(5, Math.min(20, Math.floor(this.bins)));
    for (const sample of samples) {
      const route = sample.predictedRoute.trim();
      if (!route) {
        continue;
      }
      const score = clamp(sample.score, 0, 1);
      const state = this.byRoute.get(route) ?? {
        bins: Array.from({ length: binsCount }, (_, idx) => ({
          min: idx / binsCount,
          max: (idx + 1) / binsCount,
          total: 0,
          correct: 0,
        })),
        support: 0,
      };
      const bucket = Math.min(binsCount - 1, Math.floor(score * binsCount));
      const bin = state.bins[bucket];
      if (!bin) {
        continue;
      }
      bin.total += 1;
      if (sample.predictedRoute === sample.finalRoute) {
        bin.correct += 1;
      }
      state.support += 1;
      this.byRoute.set(route, state);
    }
  }

  calibrate(route: string, score: number): number {
    const state = this.byRoute.get(route);
    if (!state || state.support < 8) {
      return clamp(score, 0, 1);
    }
    const safeScore = clamp(score, 0, 1);
    const bucket = Math.min(state.bins.length - 1, Math.floor(safeScore * state.bins.length));
    const bin = state.bins[bucket];
    if (!bin || bin.total < 3) {
      return safeScore;
    }
    return clamp(bin.correct / bin.total, 0, 1);
  }

  getSupport(route: string): number {
    return this.byRoute.get(route)?.support ?? 0;
  }

  async loadFromFile(filePath: string): Promise<void> {
    const resolved = path.resolve(process.cwd(), filePath);
    const raw = await fs.readFile(resolved, "utf8");
    const parsed = JSON.parse(raw) as PersistedCalibrationState;
    if (!parsed || typeof parsed !== "object" || !parsed.byRoute) {
      throw new Error("archivo de calibración inválido");
    }
    this.byRoute.clear();
    for (const [route, state] of Object.entries(parsed.byRoute)) {
      if (!state || !Array.isArray(state.bins)) {
        continue;
      }
      const bins = state.bins
        .map((bin) => ({
          min: clamp(Number(bin.min) || 0, 0, 1),
          max: clamp(Number(bin.max) || 0, 0, 1),
          total: Math.max(0, Math.floor(Number(bin.total) || 0)),
          correct: Math.max(0, Math.floor(Number(bin.correct) || 0)),
        }))
        .filter((bin) => bin.max >= bin.min);
      this.byRoute.set(route, {
        bins,
        support: Math.max(0, Math.floor(Number(state.support) || 0)),
      });
    }
  }

  async saveToFile(filePath: string): Promise<void> {
    const resolved = path.resolve(process.cwd(), filePath);
    const payload: PersistedCalibrationState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      bins: this.bins,
      byRoute: Object.fromEntries(this.byRoute.entries()),
    };
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
