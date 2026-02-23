import fs from "node:fs/promises";
import path from "node:path";
import { detectScheduledAutomationIntent } from "../../src/domains/schedule/automation-intent.js";

type Row = {
  text: string;
  expected_detected: boolean;
  expected_domain: "gmail" | "web" | "workspace" | "lim" | "command" | null;
  expected_daily: boolean;
};

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripScheduleTemporalPhrases(text: string): string {
  return text
    .replace(/\b(?:en|dentro\s+de)\s+(\d{1,3}|un|una|media)\s*(?:minuto|minutos|min|mins|hora|horas|h|hs|dia|dias|semana|semanas)\b/gi, " ")
    .replace(/\bpasado\s+manana\b/gi, " ")
    .replace(/\bmanana\b/gi, " ")
    .replace(/\bhoy\b/gi, " ")
    .replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, " ")
    .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, " ")
    .replace(/\b(?:(proximo)\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/gi, " ");
}

function sanitizeTitle(raw: string): string {
  return raw
    .replace(/^\s+|\s+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 400)
    .trim();
}

function ratio(ok: number, total: number): number {
  if (total <= 0) return 0;
  return ok / total;
}

async function main(): Promise<void> {
  const inputPath = path.resolve(process.cwd(), process.argv[2] || "datasets/schedule-automation-intent.es-ar.jsonl");
  const raw = await fs.readFile(inputPath, "utf8");
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

  let detectedOk = 0;
  let domainOk = 0;
  let dailyOk = 0;
  const failures: string[] = [];

  for (const [index, row] of rows.entries()) {
    const parsed = detectScheduledAutomationIntent({
      text: row.text,
      normalizeIntentText,
      stripScheduleTemporalPhrases,
      sanitizeTitle,
    });
    const predictedDetected = Boolean(parsed.instruction);
    const predictedDomain = parsed.domain ?? null;
    const predictedDaily = parsed.recurrenceDaily;

    const okDetected = predictedDetected === row.expected_detected;
    const okDomain = predictedDomain === row.expected_domain;
    const okDaily = predictedDaily === row.expected_daily;

    if (okDetected) detectedOk += 1;
    if (okDomain) domainOk += 1;
    if (okDaily) dailyOk += 1;

    if (!(okDetected && okDomain && okDaily)) {
      failures.push(
        `${index + 1}. text="${row.text}" | detected ${predictedDetected}!=${row.expected_detected} | domain ${predictedDomain}!=${row.expected_domain} | daily ${predictedDaily}!=${row.expected_daily}`,
      );
    }
  }

  const total = rows.length;
  const fullOk = rows.length - failures.length;
  const lines = [
    "Schedule automation parser eval",
    `dataset: ${inputPath}`,
    `samples: ${total}`,
    `accuracy_detected: ${(ratio(detectedOk, total) * 100).toFixed(2)}% (${detectedOk}/${total})`,
    `accuracy_domain: ${(ratio(domainOk, total) * 100).toFixed(2)}% (${domainOk}/${total})`,
    `accuracy_daily: ${(ratio(dailyOk, total) * 100).toFixed(2)}% (${dailyOk}/${total})`,
    `accuracy_full: ${(ratio(fullOk, total) * 100).toFixed(2)}% (${fullOk}/${total})`,
  ];

  if (failures.length > 0) {
    lines.push("", "Failures:", ...failures.slice(0, 40));
  }

  console.log(lines.join("\n"));
}

void main();
