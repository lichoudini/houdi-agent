import fs from "node:fs/promises";
import path from "node:path";
import { IntentSemanticRouter } from "../src/intent-semantic-router.js";

type DatasetRow = {
  text: string;
  finalHandler?: string;
};

function parseArgs(argv: string[]): Map<string, string> {
  return new Map(
    argv.map((arg) => {
      const [k, v] = arg.split("=");
      return [k, v ?? ""];
    }),
  );
}

async function readJsonl(filePath: string): Promise<DatasetRow[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as DatasetRow;
          if (!parsed?.text || !parsed?.finalHandler) {
            return [];
          }
          return [{ text: String(parsed.text), finalHandler: String(parsed.finalHandler) }];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const trainPath = path.resolve(process.cwd(), args.get("--train") || "workspace/state/intent-dataset-train.jsonl");
  const holdoutPath = path.resolve(process.cwd(), args.get("--holdout") || "workspace/state/intent-dataset-holdout.jsonl");
  const routesPath = path.resolve(process.cwd(), args.get("--routes") || "workspace/state/intent-routes.json");
  const maxIter = Math.max(100, Math.min(15000, Number.parseInt(args.get("--iter") || "1200", 10) || 1200));
  const negativesPerRoute = Math.max(5, Math.min(80, Number.parseInt(args.get("--neg") || "20", 10) || 20));
  const apply = args.has("--apply");

  const train = await readJsonl(trainPath);
  const holdout = await readJsonl(holdoutPath);
  if (train.length === 0 || holdout.length === 0) {
    console.log(`dataset insuficiente: train=${train.length}, holdout=${holdout.length}`);
    process.exit(0);
  }

  const router = new IntentSemanticRouter();
  await router.loadFromFile(routesPath, { createIfMissing: true });

  const holdoutBefore = router.evaluateDataset(holdout);
  const fit = router.fitThresholdsFromDataset(train, { maxIter });
  const negativesAdded = router.augmentNegativesFromDataset(train, negativesPerRoute);
  const holdoutAfter = router.evaluateDataset(holdout);

  console.log("Intent router optimize");
  console.log(`routes: ${routesPath}`);
  console.log(`train: ${train.length} | holdout: ${holdout.length}`);
  console.log(`before_holdout_accuracy: ${pct(holdoutBefore)}`);
  console.log(`after_holdout_accuracy: ${pct(holdoutAfter)}`);
  console.log(`delta_holdout_accuracy: ${(holdoutAfter - holdoutBefore >= 0 ? "+" : "") + pct(holdoutAfter - holdoutBefore)}`);
  console.log(`fit_before_accuracy(train): ${pct(fit.beforeAccuracy)}`);
  console.log(`fit_after_accuracy(train): ${pct(fit.afterAccuracy)}`);
  console.log(`negatives_added: ${JSON.stringify(negativesAdded)}`);

  if (apply) {
    await router.saveToFile(routesPath);
    console.log("apply: true (routes guardadas)");
  } else {
    console.log("apply: false (dry-run, sin cambios en routes)");
  }
}

await main();
