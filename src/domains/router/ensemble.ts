export type EnsembleInput = {
  candidates: string[];
  semanticAlternatives?: Array<{ name: string; score: number }>;
  aiSelected?: string | null;
  layerAllowed?: string[];
  contextualBoosts?: Partial<Record<string, number>>;
  calibratedConfidence?: number | null;
};

export function rankIntentCandidatesWithEnsemble(input: EnsembleInput): Array<{ name: string; score: number }> {
  const scoreByRoute = new Map<string, number>();
  const add = (name: string, value: number) => {
    scoreByRoute.set(name, (scoreByRoute.get(name) ?? 0) + value);
  };

  for (const candidate of input.candidates) {
    add(candidate, 0);
  }

  const semantic = input.semanticAlternatives ?? [];
  for (const alt of semantic) {
    add(alt.name, Math.max(0, Math.min(1, alt.score)) * 0.65);
  }

  if (input.aiSelected) {
    add(input.aiSelected, 0.35);
  }

  const layerAllowed = new Set(input.layerAllowed ?? []);
  for (const candidate of input.candidates) {
    if (layerAllowed.has(candidate)) {
      add(candidate, 0.08);
    }
  }

  const boosts = input.contextualBoosts ?? {};
  for (const [name, value] of Object.entries(boosts)) {
    if (typeof value !== "number") {
      continue;
    }
    add(name, value * 0.9);
  }

  if (typeof input.calibratedConfidence === "number" && semantic[0]) {
    add(semantic[0].name, input.calibratedConfidence * 0.25);
  }

  const ranked = Array.from(scoreByRoute.entries())
    .map(([name, score]) => ({
      name,
      score: Number(score.toFixed(6)),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked;
}
