import fs from "node:fs/promises";
import path from "node:path";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.split("=");
    return [k, v ?? ""];
  }),
);

const inputPaths = (args.get("--inputs") || "houdi-intent-router-dataset.jsonl,datasets/intent-latam.seed.jsonl")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((p) => path.resolve(process.cwd(), p));
const trainPath = path.resolve(process.cwd(), args.get("--train") || "workspace/state/intent-dataset-train.jsonl");
const holdoutPath = path.resolve(process.cwd(), args.get("--holdout") || "workspace/state/intent-dataset-holdout.jsonl");
const holdoutPct = Math.max(1, Math.min(40, Number.parseInt(args.get("--holdout-pct") || "10", 10) || 10));

function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function simpleHash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

const allowedHandlers = new Set([
  "self-maintenance",
  "lim",
  "schedule",
  "memory",
  "gmail-recipients",
  "gmail",
  "workspace",
  "document",
  "web",
]);

const merged = [];
for (const p of inputPaths) {
  const rows = await readJsonl(p);
  for (const row of rows) {
    const text = String(row?.text || "").trim();
    const finalHandler = String(row?.finalHandler || row?.semantic?.handler || "").trim();
    if (!text || !finalHandler || !allowedHandlers.has(finalHandler)) {
      continue;
    }
    merged.push({
      text,
      finalHandler,
      source: row?.source || "unknown",
      locale: row?.locale || "es",
      country: row?.country || null,
    });
  }
}

const dedup = new Map();
for (const row of merged) {
  const key = `${row.finalHandler}::${normalizeText(row.text)}`;
  if (!dedup.has(key)) {
    dedup.set(key, row);
  }
}

const uniqueRows = [...dedup.values()];
const train = [];
const holdout = [];

for (const row of uniqueRows) {
  const bucket = simpleHash(`${row.finalHandler}::${normalizeText(row.text)}`) % 100;
  if (bucket < holdoutPct) {
    holdout.push(row);
  } else {
    train.push(row);
  }
}

await fs.mkdir(path.dirname(trainPath), { recursive: true });
await fs.mkdir(path.dirname(holdoutPath), { recursive: true });
await fs.writeFile(trainPath, `${train.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");
await fs.writeFile(holdoutPath, `${holdout.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");

console.log(`inputs: ${inputPaths.join(", ")}`);
console.log(`rows_merged: ${merged.length}`);
console.log(`rows_unique: ${uniqueRows.length}`);
console.log(`train: ${train.length} -> ${trainPath}`);
console.log(`holdout(${holdoutPct}%): ${holdout.length} -> ${holdoutPath}`);
