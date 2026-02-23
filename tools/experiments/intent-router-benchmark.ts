import fs from "node:fs/promises";
import path from "node:path";
import { IntentSemanticRouter } from "../../src/intent-semantic-router.js";

type DatasetEntry = {
  text: string;
  finalHandler?: string;
  semantic?: {
    handler: string;
    score: number;
  };
};

type RouteStats = {
  evaluated: number;
  matchedFinal: number;
  matchedSemantic: number;
  scoreTotal: number;
  tp: number;
  fp: number;
  fn: number;
};

async function readDataset(filePath: string, limit: number): Promise<DatasetEntry[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit);

  const out: DatasetEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as DatasetEntry;
      if (parsed && typeof parsed.text === "string" && parsed.text.trim().length > 0) {
        out.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return out;
}

function formatPct(hit: number, total: number): string {
  if (total <= 0) {
    return "n/a";
  }
  return `${((hit / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const rawLimit = Number.parseInt(process.argv[2] ?? "3000", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 30_000) : 3000;
  const datasetPath = path.resolve(
    process.cwd(),
    process.env.HOUDI_INTENT_ROUTER_DATASET_FILE?.trim() || "./houdi-intent-router-dataset.jsonl",
  );
  const routesPath = path.resolve(
    process.cwd(),
    process.env.HOUDI_INTENT_ROUTER_ROUTES_FILE?.trim() || "./workspace/state/intent-routes.json",
  );

  const router = new IntentSemanticRouter();
  try {
    await router.loadFromFile(routesPath);
  } catch {
    // fallback to defaults
  }
  const routes = router.listRouteThresholds().map((item) => item.name as string);
  const stats = new Map<string, RouteStats>();
  for (const route of routes) {
    stats.set(route, {
      evaluated: 0,
      matchedFinal: 0,
      matchedSemantic: 0,
      scoreTotal: 0,
      tp: 0,
      fp: 0,
      fn: 0,
    });
  }
  const confusion = new Map<string, Map<string, number>>();

  let entries: DatasetEntry[] = [];
  try {
    entries = await readDataset(datasetPath, limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/enoent/i.test(message)) {
      console.log(`Dataset no encontrado, benchmark omitido: ${datasetPath}`);
      process.exit(0);
    }
    console.error(`No pude leer dataset (${datasetPath}): ${message}`);
    process.exit(1);
  }

  if (entries.length === 0) {
    console.log(`Sin datos para benchmark en ${datasetPath}`);
    process.exit(0);
  }

  const globalAcc = router.evaluateDataset(entries.map((item) => ({ text: item.text, finalHandler: item.finalHandler })));

  for (const entry of entries) {
    const decision = router.route(entry.text);
    if (!decision) {
      continue;
    }
    const routeStats = stats.get(decision.handler);
    if (!routeStats) {
      continue;
    }
    routeStats.evaluated += 1;
    routeStats.scoreTotal += decision.score;
    if (entry.finalHandler && decision.handler === entry.finalHandler) {
      routeStats.matchedFinal += 1;
    }
    if (entry.semantic?.handler && decision.handler === entry.semantic.handler) {
      routeStats.matchedSemantic += 1;
    }
    if (entry.finalHandler && routes.includes(entry.finalHandler)) {
      if (decision.handler === entry.finalHandler) {
        routeStats.tp += 1;
      } else {
        routeStats.fp += 1;
        const expectedStats = stats.get(entry.finalHandler);
        if (expectedStats) {
          expectedStats.fn += 1;
        }
        const row = confusion.get(entry.finalHandler) ?? new Map<string, number>();
        row.set(decision.handler, (row.get(decision.handler) ?? 0) + 1);
        confusion.set(entry.finalHandler, row);
      }
    }
  }

  const lines: string[] = [];
  lines.push("Intent router benchmark");
  lines.push(`dataset: ${datasetPath}`);
  lines.push(`muestras: ${entries.length}`);
  lines.push(`accuracy_global: ${(globalAcc * 100).toFixed(2)}%`);
  let f1MacroSum = 0;
  let f1MacroCount = 0;
  lines.push("");

  for (const route of routes) {
    const routeStats = stats.get(route);
    if (!routeStats || routeStats.evaluated === 0) {
      continue;
    }
    const avgScore = routeStats.scoreTotal / routeStats.evaluated;
    const precision = routeStats.tp + routeStats.fp > 0 ? routeStats.tp / (routeStats.tp + routeStats.fp) : 0;
    const recall = routeStats.tp + routeStats.fn > 0 ? routeStats.tp / (routeStats.tp + routeStats.fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    if (routeStats.evaluated > 0) {
      f1MacroSum += f1;
      f1MacroCount += 1;
    }
    lines.push(
      [
        `${route}`,
        `evaluadas=${routeStats.evaluated}`,
        `match_final=${formatPct(routeStats.matchedFinal, routeStats.evaluated)}`,
        `match_semantic=${formatPct(routeStats.matchedSemantic, routeStats.evaluated)}`,
        `precision=${(precision * 100).toFixed(1)}%`,
        `recall=${(recall * 100).toFixed(1)}%`,
        `f1=${(f1 * 100).toFixed(1)}%`,
        `score_prom=${avgScore.toFixed(3)}`,
      ].join(" | "),
    );
  }
  lines.push("");
  lines.push(`f1_macro: ${f1MacroCount > 0 ? ((f1MacroSum / f1MacroCount) * 100).toFixed(2) : "0.00"}%`);

  const topConfusions = Array.from(confusion.entries())
    .flatMap(([expected, byPredicted]) =>
      Array.from(byPredicted.entries()).map(([predicted, count]) => ({
        expected,
        predicted,
        count,
      })),
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (topConfusions.length > 0) {
    lines.push("top_confusions:");
    for (const item of topConfusions) {
      lines.push(`- expected=${item.expected} predicted=${item.predicted} n=${item.count}`);
    }
  }

  console.log(lines.join("\n"));
}

await main();
