import path from "node:path";
import { spawnSync } from "node:child_process";

const holdoutPath = path.resolve(process.cwd(), process.argv[2] || "workspace/state/intent-dataset-holdout.jsonl");
const limit = process.argv[3] || "50000";

const env = {
  ...process.env,
  HOUDI_INTENT_ROUTER_DATASET_FILE: holdoutPath,
};

const result = spawnSync("npx", ["tsx", "tools/experiments/intent-router-benchmark.ts", String(limit)], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

if (typeof result.status === "number") {
  process.exit(result.status);
}
process.exit(1);
