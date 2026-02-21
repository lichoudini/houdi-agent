import type { IntentRouterDatasetEntry } from "./intent-router-stats.js";

export type CurationSuggestion = {
  route: string;
  utterances: string[];
  evidence: number;
};

function normalizePhrase(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildCurationSuggestions(
  entries: IntentRouterDatasetEntry[],
  routeNames: Set<string>,
  maxPerRoute: number,
): CurationSuggestion[] {
  const byRoute = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    if (!entry.semantic || !entry.finalHandler || !routeNames.has(entry.finalHandler)) {
      continue;
    }
    if (entry.semantic.handler === entry.finalHandler) {
      continue;
    }
    const phrase = normalizePhrase(entry.text);
    if (phrase.length < 8 || phrase.length > 160) {
      continue;
    }
    const bucket = byRoute.get(entry.finalHandler) ?? new Map<string, number>();
    bucket.set(phrase, (bucket.get(phrase) ?? 0) + 1);
    byRoute.set(entry.finalHandler, bucket);
  }

  const suggestions: CurationSuggestion[] = [];
  for (const [route, phrases] of byRoute.entries()) {
    const ranked = Array.from(phrases.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, maxPerRoute));
    suggestions.push({
      route,
      utterances: ranked.map(([phrase]) => phrase),
      evidence: ranked.reduce((acc, [, count]) => acc + count, 0),
    });
  }

  return suggestions.sort((a, b) => b.evidence - a.evidence);
}
