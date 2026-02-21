import fs from "node:fs/promises";
import path from "node:path";
import { IntentSemanticRouter } from "./intent-semantic-router.js";

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

  const router = new IntentSemanticRouter();
  const routes = router.listRouteThresholds().map((item) => item.name);
  const stats = new Map<string, RouteStats>();
  for (const route of routes) {
    stats.set(route, {
      evaluated: 0,
      matchedFinal: 0,
      matchedSemantic: 0,
      scoreTotal: 0,
    });
  }

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
  }

  const lines: string[] = [];
  lines.push("Intent router benchmark");
  lines.push(`dataset: ${datasetPath}`);
  lines.push(`muestras: ${entries.length}`);
  lines.push("");

  for (const route of routes) {
    const routeStats = stats.get(route);
    if (!routeStats || routeStats.evaluated === 0) {
      continue;
    }
    const avgScore = routeStats.scoreTotal / routeStats.evaluated;
    lines.push(
      [
        `${route}`,
        `evaluadas=${routeStats.evaluated}`,
        `match_final=${formatPct(routeStats.matchedFinal, routeStats.evaluated)}`,
        `match_semantic=${formatPct(routeStats.matchedSemantic, routeStats.evaluated)}`,
        `score_prom=${avgScore.toFixed(3)}`,
      ].join(" | "),
    );
  }

  console.log(lines.join("\n"));
}

await main();
