import test from "node:test";
import assert from "node:assert/strict";
import { detectScheduledAutomationIntent } from "./domains/schedule/automation-intent.js";

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

const deps = {
  normalizeIntentText,
  stripScheduleTemporalPhrases,
  sanitizeTitle,
};

test("detects daily lim automation", () => {
  const parsed = detectScheduledAutomationIntent({
    text: "Todos los dias 9am ejecutar lista lim",
    ...deps,
  });
  assert.equal(parsed.recurrenceDaily, true);
  assert.equal(parsed.domain, "lim");
  assert.equal(parsed.instruction, "lista lim");
});

test("detects scheduled web automation", () => {
  const parsed = detectScheduledAutomationIntent({
    text: "Mañana a las 10 buscar en web noticias de IA",
    ...deps,
  });
  assert.equal(parsed.domain, "web");
  assert.equal(parsed.instruction, "en web noticias de IA");
});

test("detects scheduled workspace automation", () => {
  const parsed = detectScheduledAutomationIntent({
    text: "En 2 horas consultar archivo workspace/reportes/ventas.txt",
    ...deps,
  });
  assert.equal(parsed.domain, "workspace");
  assert.equal(parsed.instruction, "archivo workspace/reportes/ventas.txt");
});

test("ignores plain reminders without automation domain", () => {
  const parsed = detectScheduledAutomationIntent({
    text: "Mañana 11 comprar panchos",
    ...deps,
  });
  assert.equal(parsed.domain, undefined);
  assert.equal(parsed.instruction, undefined);
});
