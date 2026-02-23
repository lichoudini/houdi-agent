import fs from "node:fs/promises";
import path from "node:path";
import { normalizeExecCommandSequence } from "../src/domains/shell/command-sequence.js";

type Row = {
  text: string;
  expected_count: number;
  expected_sequence: string[];
};

function ratio(ok: number, total: number): number {
  return total > 0 ? ok / total : 0;
}

async function main(): Promise<void> {
  const inputPath = path.resolve(process.cwd(), process.argv[2] || "datasets/exec-sequence-parser.es-ar.jsonl");
  const raw = await fs.readFile(inputPath, "utf8");
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

  let okCountMetric = 0;
  let okExact = 0;
  const failures: string[] = [];

  rows.forEach((row, idx) => {
    const predicted = normalizeExecCommandSequence(row.text);
    const countOk = predicted.length === row.expected_count;
    const exactOk = JSON.stringify(predicted) === JSON.stringify(row.expected_sequence);

    if (countOk) okCountMetric += 1;
    if (exactOk) okExact += 1;
    if (!(countOk && exactOk)) {
      failures.push(
        `${idx + 1}. text="${row.text}" | count ${predicted.length}!=${row.expected_count} | predicted=${JSON.stringify(predicted)} expected=${JSON.stringify(row.expected_sequence)}`,
      );
    }
  });

  const total = rows.length;
  const lines = [
    "Exec sequence parser eval",
    `dataset: ${inputPath}`,
    `samples: ${total}`,
    `accuracy_count: ${(ratio(okCountMetric, total) * 100).toFixed(2)}% (${okCountMetric}/${total})`,
    `accuracy_exact: ${(ratio(okExact, total) * 100).toFixed(2)}% (${okExact}/${total})`,
  ];

  if (failures.length > 0) {
    lines.push("", "Failures:", ...failures.slice(0, 40));
  }

  console.log(lines.join("\n"));
}

void main();
