#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { IntentSemanticRouter } from "../../dist/intent-semantic-router.js";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.split("=");
    return [k, v ?? ""];
  }),
);

const datasetPath = path.resolve(process.cwd(), args.get("--dataset") || "workspace/state/intent-dataset-holdout.jsonl");
const routesPath = path.resolve(process.cwd(), args.get("--routes") || "workspace/state/intent-routes.json");
const focusDomain = (args.get("--domain") || "").trim();

const allowed = new Set([
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

function pct(hit, total) {
  if (!total) return "n/a";
  return `${((hit / total) * 100).toFixed(2)}%`;
}

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_:-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line);
        const text = String(row?.text || "").trim();
        const finalHandler = String(row?.finalHandler || "").trim();
        if (!text || !allowed.has(finalHandler)) {
          return [];
        }
        return [{ text, finalHandler }];
      } catch {
        return [];
      }
    });
}

async function main() {
  const rowsRaw = await readJsonl(datasetPath);
  const rowsDedup = [];
  const seen = new Set();
  for (const row of rowsRaw) {
    const key = `${row.finalHandler}::${normalizeText(row.text)}`;
    if (!seen.has(key)) {
      seen.add(key);
      rowsDedup.push(row);
    }
  }
  const rows = focusDomain ? rowsDedup.filter((row) => row.finalHandler === focusDomain) : rowsDedup;

  if (rows.length === 0) {
    console.log(`sin muestras para dataset=${datasetPath}${focusDomain ? ` domain=${focusDomain}` : ""}`);
    process.exit(0);
  }

  const router = new IntentSemanticRouter();
  await router.loadFromFile(routesPath, { createIfMissing: true });

  const byDomain = new Map();
  let globalOk = 0;
  for (const row of rows) {
    const predicted = router.route(row.text)?.handler ?? "__none__";
    const ok = predicted === row.finalHandler;
    if (ok) {
      globalOk += 1;
    }
    const slot = byDomain.get(row.finalHandler) || {
      total: 0,
      ok: 0,
      confusions: new Map(),
    };
    slot.total += 1;
    if (ok) {
      slot.ok += 1;
    } else {
      slot.confusions.set(predicted, (slot.confusions.get(predicted) || 0) + 1);
    }
    byDomain.set(row.finalHandler, slot);
  }

  const domains = [...byDomain.keys()].sort((a, b) => {
    const aa = byDomain.get(a);
    const bb = byDomain.get(b);
    const ar = aa && aa.total > 0 ? aa.ok / aa.total : 0;
    const br = bb && bb.total > 0 ? bb.ok / bb.total : 0;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });

  console.log("Intent Domain Report");
  console.log(`dataset: ${datasetPath}`);
  console.log(`routes:  ${routesPath}`);
  console.log(`samples: ${rows.length}`);
  console.log(`global_accuracy: ${pct(globalOk, rows.length)} (${globalOk}/${rows.length})`);
  console.log("");
  console.log("Per-domain:");

  for (const domain of domains) {
    const row = byDomain.get(domain);
    if (!row) continue;
    const confusions = [...row.confusions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => `${name}:${count}`)
      .join(", ");
    console.log(
      `- ${domain} | accuracy=${pct(row.ok, row.total)} (${row.ok}/${row.total})` +
        (confusions ? ` | top_confusions=${confusions}` : ""),
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`intent-domain-report error: ${message}`);
  process.exitCode = 1;
});
