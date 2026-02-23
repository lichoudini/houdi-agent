#!/usr/bin/env node
import fs from "node:fs/promises";

const datasetPath = process.env.HOUDI_INTENT_ROUTER_DATASET_FILE?.trim() || "./houdi-intent-router-dataset.jsonl";
const auditPath = process.env.AUDIT_LOG_PATH?.trim() || "./houdi-audit.log";

function parseArg(name, fallback = "") {
  const hit = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!hit) {
    return fallback;
  }
  return hit.slice(name.length + 1);
}

function parseCsvSet(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

const limitArg = Number.parseInt(parseArg("--limit", "3000"), 10);
const limit = Number.isFinite(limitArg) ? Math.max(100, Math.min(50000, limitArg)) : 3000;
const targetRaw = Number.parseFloat(parseArg("--target", process.env.HOUDI_INTENT_ACCURACY_TARGET || "0.9"));
const target = Number.isFinite(targetRaw) ? Math.max(0.5, Math.min(0.99, targetRaw)) : 0.9;
const minSamplesRaw = Number.parseInt(parseArg("--min-samples", "1"), 10);
const minSamples = Number.isFinite(minSamplesRaw) ? Math.max(1, Math.min(100, minSamplesRaw)) : 1;
const includeRoutes = parseCsvSet(parseArg("--include", process.env.HOUDI_INTENT_ACCURACY_INCLUDE_ROUTES || ""));
const excludeRoutes = parseCsvSet(parseArg("--exclude", process.env.HOUDI_INTENT_ACCURACY_EXCLUDE_ROUTES || ""));
const includeProbeEvents = process.argv.includes("--include-probes");
const includePendingPlan = process.argv.includes("--include-pending-plan");
const sinceIso = parseArg("--since", "").trim();
const sinceEpochMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
const hasSinceFilter = Number.isFinite(sinceEpochMs);
const targetLabel = `target${Math.round(target * 100)}`;

function pct(hit, total) {
  if (!total) {
    return "n/a";
  }
  return `${((hit / total) * 100).toFixed(2)}%`;
}

function readJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function addCounter(map, key, field, inc = 1) {
  const row = map.get(key) || { total: 0, hit: 0, fieldTotal: {} };
  row.total += inc;
  if (field === "hit") {
    row.hit += inc;
  } else if (field) {
    row.fieldTotal[field] = (row.fieldTotal[field] || 0) + inc;
  }
  map.set(key, row);
}

function routeIncluded(route) {
  if (!route) {
    return false;
  }
  if (includeRoutes.size > 0 && !includeRoutes.has(route)) {
    return false;
  }
  if (excludeRoutes.has(route)) {
    return false;
  }
  return true;
}

function isProbeExecutionEvent(details) {
  if (!details || typeof details !== "object") {
    return false;
  }
  const source = String(details.source || "");
  const delegatedSource = String(details.delegatedSource || "");
  if (source.includes(":probe") || delegatedSource.includes(":probe")) {
    return true;
  }
  const isSubagentDelegation = delegatedSource.includes(":subagent:");
  if (!isSubagentDelegation) {
    return false;
  }
  const route = String(details.route || "").trim();
  const semanticSelected = String(details.semanticRouterSelected || "").trim();
  const shadowSelected = String(details.shadowRouterSelected || "").trim();
  const aiSelected = String(details.aiRouterSelected || "").trim();
  const handled = details.handled === true;
  const actionSuccess = details.actionSuccess === true;
  const actionError = typeof details.actionError === "string" ? details.actionError.trim() : "";
  const hasRouterSelection = Boolean(semanticSelected || shadowSelected || aiSelected);

  // Legacy probe telemetry: subagent tried multiple routes, one selected route
  // is executed and non-selected routes return handled/actionSuccess false.
  if (!handled && !actionSuccess && !actionError) {
    if (semanticSelected && route && route !== semanticSelected) {
      return true;
    }
    if (!hasRouterSelection) {
      return true;
    }
  }

  return false;
}

async function main() {
  const [datasetRaw, auditRaw] = await Promise.all([
    fs.readFile(datasetPath, "utf8").catch(() => ""),
    fs.readFile(auditPath, "utf8").catch(() => ""),
  ]);
  const datasetRows = readJsonl(datasetRaw)
    .filter((row) => {
      if (!hasSinceFilter) {
        return true;
      }
      const ts = Date.parse(String(row?.ts || ""));
      return Number.isFinite(ts) ? ts >= sinceEpochMs : true;
    })
    .slice(-limit);
  const auditRows = readJsonl(auditRaw)
    .filter((row) => {
      if (!hasSinceFilter) {
        return true;
      }
      const ts = Date.parse(String(row?.ts || ""));
      return Number.isFinite(ts) ? ts >= sinceEpochMs : true;
    })
    .slice(-limit * 3);

  const byRoute = new Map();
  let semanticTotal = 0;
  let semanticHit = 0;
  let shadowTotal = 0;
  let shadowHit = 0;

  for (const row of datasetRows) {
    if (!row || !row.finalHandler || row.finalHandler === "none" || String(row.finalHandler).startsWith("multi:")) {
      continue;
    }
    const route = String(row.finalHandler);
    if (!routeIncluded(route)) {
      continue;
    }
    const semanticPred = row.semantic?.handler ? String(row.semantic.handler) : null;
    const shadowPred = row.shadow?.handler ? String(row.shadow.handler) : null;
    addCounter(byRoute, route, null, 1);
    if (semanticPred) {
      addCounter(byRoute, route, "semanticTotal", 1);
      semanticTotal += 1;
      if (semanticPred === route) {
        addCounter(byRoute, route, "hit", 1);
        addCounter(byRoute, route, "semanticHit", 1);
        semanticHit += 1;
      }
    }
    if (shadowPred) {
      addCounter(byRoute, route, "shadowTotal", 1);
      shadowTotal += 1;
      if (shadowPred === route) {
        addCounter(byRoute, route, "shadowHit", 1);
        shadowHit += 1;
      }
    }
  }

  const execByRoute = new Map();
  let executionTotal = 0;
  let executionHit = 0;
  for (const event of auditRows) {
    if (!event || event.type !== "intent.execution.result") {
      continue;
    }
    const details = event.details || {};
    const route = String(details.route || "").trim();
    if (!route) {
      continue;
    }
    if (!routeIncluded(route)) {
      continue;
    }
    if (!includeProbeEvents && isProbeExecutionEvent(details)) {
      continue;
    }
    if (!includePendingPlan && String(details.actionError || "") === "pending-plan-confirmation") {
      continue;
    }
    const handled = typeof details.actionSuccess === "boolean"
      ? Boolean(details.actionSuccess)
      : Boolean(details.handled);
    const row = execByRoute.get(route) || { total: 0, ok: 0 };
    row.total += 1;
    if (handled) {
      row.ok += 1;
      executionHit += 1;
    }
    executionTotal += 1;
    execByRoute.set(route, row);
  }

  const routes = Array.from(new Set([...byRoute.keys(), ...execByRoute.keys()])).sort();
  console.log("Intent Accuracy Report");
  console.log(`dataset: ${datasetPath}`);
  console.log(`audit:   ${auditPath}`);
  console.log(`limit:   ${limit}`);
  console.log(`target:  ${(target * 100).toFixed(0)}%`);
  console.log(`min samples: ${minSamples}`);
  console.log(`routes include: ${includeRoutes.size ? Array.from(includeRoutes).join(", ") : "(all)"}`);
  console.log(`routes exclude: ${excludeRoutes.size ? Array.from(excludeRoutes).join(", ") : "(none)"}`);
  console.log(`probe events: ${includeProbeEvents ? "included" : "excluded"}`);
  console.log(`pending-plan events: ${includePendingPlan ? "included" : "excluded"}`);
  if (hasSinceFilter) {
    console.log(`since:   ${new Date(sinceEpochMs).toISOString()}`);
  }
  console.log("");
  console.log(`Global semantic accuracy: ${pct(semanticHit, semanticTotal)} (${semanticHit}/${semanticTotal})`);
  if (shadowTotal > 0) {
    console.log(`Global shadow accuracy:   ${pct(shadowHit, shadowTotal)} (${shadowHit}/${shadowTotal})`);
  } else {
    console.log("Global shadow accuracy:   n/a (shadow disabled or no samples)");
  }
  console.log(`Global execution success: ${pct(executionHit, executionTotal)} (${executionHit}/${executionTotal})`);
  console.log("");
  console.log("Per route:");
  for (const route of routes) {
    const interp = byRoute.get(route) || { fieldTotal: {} };
    const semHit = interp.fieldTotal?.semanticHit || 0;
    const semTotal = interp.fieldTotal?.semanticTotal || 0;
    const shHit = interp.fieldTotal?.shadowHit || 0;
    const shTotal = interp.fieldTotal?.shadowTotal || 0;
    const exec = execByRoute.get(route) || { ok: 0, total: 0 };
    const semAcc = semTotal > 0 ? semHit / semTotal : null;
    const execAcc = exec.total > 0 ? exec.ok / exec.total : null;
    const lowSample = semTotal < minSamples || exec.total < minSamples;
    const status = lowSample
      ? "LOW_SAMPLE"
      : semAcc !== null && execAcc !== null && semAcc >= target && execAcc >= target
      ? "OK"
      : "CHECK";
    const parts = [
      `${route}`,
      `semantic=${pct(semHit, semTotal)} (${semHit}/${semTotal})`,
      `shadow=${pct(shHit, shTotal)} (${shHit}/${shTotal})`,
      `execution=${pct(exec.ok, exec.total)} (${exec.ok}/${exec.total})`,
      `${targetLabel}=${status}`,
    ];
    console.log(`- ${parts.join(" | ")}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`intent-accuracy-report error: ${message}`);
  process.exitCode = 1;
});
