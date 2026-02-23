#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeExecCommandSequence } from "../../dist/domains/shell/command-sequence.js";

const inputPath = path.resolve(process.cwd(), process.argv[2] || "datasets/exec-sequence-parser.es-ar.jsonl");

function pct(ok, total) {
  if (!total) return "n/a";
  return `${((ok / total) * 100).toFixed(2)}%`;
}

const raw = await fs.readFile(inputPath, "utf8");
const rows = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

let countOk = 0;
let exactOk = 0;
for (const row of rows) {
  const predicted = normalizeExecCommandSequence(row.text);
  const countMatches = predicted.length === row.expected_count;
  const exactMatches = JSON.stringify(predicted) === JSON.stringify(row.expected_sequence);
  if (countMatches) countOk += 1;
  if (exactMatches) exactOk += 1;
}

console.log("Exec sequence parser eval");
console.log(`dataset: ${inputPath}`);
console.log(`samples: ${rows.length}`);
console.log(`accuracy_count: ${pct(countOk, rows.length)} (${countOk}/${rows.length})`);
console.log(`accuracy_exact: ${pct(exactOk, rows.length)} (${exactOk}/${rows.length})`);
