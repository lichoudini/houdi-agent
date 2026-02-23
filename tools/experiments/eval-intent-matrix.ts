import fs from "node:fs/promises";
import path from "node:path";
import { IntentSemanticRouter } from "../../src/intent-semantic-router.js";

type Row = {
  text: string;
  finalHandler: string;
};

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function readJsonl(filePath: string): Promise<Row[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Row;
        if (!parsed?.text || !parsed?.finalHandler) return [];
        return [{ text: String(parsed.text), finalHandler: String(parsed.finalHandler) }];
      } catch {
        return [];
      }
    });
}

function toMarkdownTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

async function main(): Promise<void> {
  const datasetPath = path.resolve(process.cwd(), process.argv[2] || "datasets/intent-debug-100.es-ar.jsonl");
  const routesPath = path.resolve(process.cwd(), process.argv[3] || "workspace/state/intent-routes.json");

  const rows = await readJsonl(datasetPath);
  if (rows.length === 0) {
    console.log(`dataset vacio: ${datasetPath}`);
    process.exit(0);
  }

  const router = new IntentSemanticRouter();
  await router.loadFromFile(routesPath, { createIfMissing: true });
  const routeNames = router.listRouteThresholds().map((r) => String(r.name));
  const labels = [...routeNames, "__none__"];

  const matrix = new Map<string, Map<string, number>>();
  for (const expected of labels) {
    matrix.set(expected, new Map(labels.map((pred) => [pred, 0])));
  }

  let correct = 0;
  for (const row of rows) {
    const predicted = router.route(row.text)?.handler ?? "__none__";
    if (!matrix.has(row.finalHandler)) {
      matrix.set(row.finalHandler, new Map(labels.map((pred) => [pred, 0])));
    }
    const rowMap = matrix.get(row.finalHandler)!;
    rowMap.set(predicted, (rowMap.get(predicted) ?? 0) + 1);
    if (predicted === row.finalHandler) correct += 1;
  }

  const presentExpected = Array.from(new Set(rows.map((r) => r.finalHandler))).filter((h) => labels.includes(h));
  const predictedSet = new Set<string>();
  for (const expected of presentExpected) {
    const rowMap = matrix.get(expected)!;
    for (const label of labels) {
      if ((rowMap.get(label) ?? 0) > 0) predictedSet.add(label);
    }
  }
  const predLabels = labels.filter((l) => predictedSet.has(l));

  const metricRows: string[][] = [];
  for (const cls of presentExpected) {
    const tp = matrix.get(cls)?.get(cls) ?? 0;
    let fp = 0;
    let fn = 0;
    for (const other of presentExpected) {
      if (other !== cls) {
        fp += matrix.get(other)?.get(cls) ?? 0;
      }
    }
    for (const predicted of labels) {
      if (predicted !== cls) {
        fn += matrix.get(cls)?.get(predicted) ?? 0;
      }
    }
    const support = Array.from(matrix.get(cls)?.values() ?? []).reduce((a, b) => a + b, 0);
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    metricRows.push([cls, String(support), String(tp), pct(precision), pct(recall), pct(f1)]);
  }

  const matrixRows: string[][] = [];
  for (const expected of presentExpected) {
    const rowMap = matrix.get(expected)!;
    matrixRows.push([expected, ...predLabels.map((p) => String(rowMap.get(p) ?? 0))]);
  }

  console.log(`Intent Matrix Eval`);
  console.log(`dataset: ${datasetPath}`);
  console.log(`routes: ${routesPath}`);
  console.log(`samples: ${rows.length}`);
  console.log(`accuracy_global: ${pct(correct / rows.length)} (${correct}/${rows.length})`);
  console.log("");
  console.log("Per-class metrics");
  console.log(toMarkdownTable(["class", "support", "tp", "precision", "recall", "f1"], metricRows));
  console.log("");
  console.log("Confusion matrix (rows=expected, cols=predicted)");
  console.log(toMarkdownTable(["expected \\\\ predicted", ...predLabels], matrixRows));
}

void main();
