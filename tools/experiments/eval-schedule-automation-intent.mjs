#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { detectScheduledAutomationIntent } from "../../dist/domains/schedule/automation-intent.js";

const inputPath = path.resolve(process.cwd(), process.argv[2] || "datasets/schedule-automation-intent.es-ar.jsonl");

function normalizeIntentText(text) {
  return String(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripScheduleTemporalPhrases(text) {
  return String(text)
    .replace(/\b(?:en|dentro\s+de)\s+(\d{1,3}|un|una|media)\s*(?:minuto|minutos|min|mins|hora|horas|h|hs|dia|dias|semana|semanas)\b/gi, " ")
    .replace(/\bpasado\s+manana\b/gi, " ")
    .replace(/\bmanana\b/gi, " ")
    .replace(/\bhoy\b/gi, " ")
    .replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, " ")
    .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, " ")
    .replace(/\b(?:(proximo)\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/gi, " ");
}

function sanitizeTitle(raw) {
  return String(raw)
    .replace(/^\s+|\s+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 400)
    .trim();
}

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

let detectedOk = 0;
let domainOk = 0;
let dailyOk = 0;
let fullOk = 0;
for (const row of rows) {
  const parsed = detectScheduledAutomationIntent({
    text: row.text,
    normalizeIntentText,
    stripScheduleTemporalPhrases,
    sanitizeTitle,
  });
  const predictedDetected = Boolean(parsed.instruction);
  const predictedDomain = parsed.domain ?? null;
  const predictedDaily = Boolean(parsed.recurrenceDaily);
  const okDetected = predictedDetected === Boolean(row.expected_detected);
  const okDomain = predictedDomain === (row.expected_domain ?? null);
  const okDaily = predictedDaily === Boolean(row.expected_daily);

  if (okDetected) detectedOk += 1;
  if (okDomain) domainOk += 1;
  if (okDaily) dailyOk += 1;
  if (okDetected && okDomain && okDaily) fullOk += 1;
}

console.log("Schedule automation parser eval");
console.log(`dataset: ${inputPath}`);
console.log(`samples: ${rows.length}`);
console.log(`accuracy_detected: ${pct(detectedOk, rows.length)} (${detectedOk}/${rows.length})`);
console.log(`accuracy_domain: ${pct(domainOk, rows.length)} (${domainOk}/${rows.length})`);
console.log(`accuracy_daily: ${pct(dailyOk, rows.length)} (${dailyOk}/${rows.length})`);
console.log(`accuracy_full: ${pct(fullOk, rows.length)} (${fullOk}/${rows.length})`);
