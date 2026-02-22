import type { WebSearchResult } from "../../web-browser.js";

export type ParsedWebQuery = { ok: true; query: string } | { ok: false; error: string };

function sanitizeNaturalWebQuery(raw: string): string {
  return raw
    .replace(/\b(por favor|porfa|gracias)\b/gi, " ")
    .replace(/\b(dime|decime|contame|cuentame|cuéntame|mostrame|muestrame|muéstrame)\b/gi, " ")
    .replace(
      /\b(busca(?:me)?|buscar|investiga(?:r)?|averigua(?:r)?|googlea(?:r)?|navega(?:r)?|consulta(?:r)?|abre|abrir|abr[ií]|lee|leer|revisa(?:r)?|analiza(?:r)?|resum[ií](?:r)?|explica(?:r)?|muestra(?:r)?)\b/gi,
      " ",
    )
    .replace(/\b(en la web|en internet|por internet|online|en google)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeWebCommandQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const cleaned = sanitizeNaturalWebQuery(trimmed);
  return cleaned || trimmed;
}

export function parseWebSearchCommandInput(raw: string): ParsedWebQuery {
  const query = normalizeWebCommandQuery(raw);
  if (!query) {
    return { ok: false, error: "Uso: /web <consulta>" };
  }
  return { ok: true, query };
}

export function parseWebAskCommandInput(raw: string): ParsedWebQuery {
  const query = normalizeWebCommandQuery(raw);
  if (!query) {
    return { ok: false, error: "Uso: /webask <consulta>" };
  }
  return { ok: true, query };
}

export function parseWebOpenCommandInput(params: {
  raw: string;
  lastResults: WebSearchResult[] | undefined;
  parseTarget: (input: string, lastResults: WebSearchResult[] | undefined) => { url: string; question: string; sourceIndex?: number };
}): { ok: true; value: { url: string; question: string; sourceIndex?: number } } | { ok: false; error: string } {
  try {
    const parsed = params.parseTarget(params.raw.trim(), params.lastResults);
    return { ok: true, value: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
