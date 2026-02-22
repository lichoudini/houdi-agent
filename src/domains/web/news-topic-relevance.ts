const NEWS_TOPIC_STOPWORDS = new Set<string>([
  "a",
  "acerca",
  "actual",
  "actuales",
  "actualidad",
  "al",
  "algo",
  "an",
  "ano",
  "anos",
  "ayer",
  "con",
  "cuentame",
  "cuales",
  "cuale",
  "de",
  "del",
  "dia",
  "dias",
  "dime",
  "el",
  "en",
  "encuentra",
  "encontra",
  "esta",
  "este",
  "estos",
  "esta",
  "google",
  "hoy",
  "horas",
  "hour",
  "hours",
  "internet",
  "investiga",
  "la",
  "las",
  "last",
  "latest",
  "leer",
  "lista",
  "los",
  "mail",
  "mensaje",
  "mes",
  "meses",
  "mira",
  "mostrame",
  "muestrame",
  "new",
  "news",
  "novedad",
  "novedade",
  "novedades",
  "noticia",
  "noticias",
  "para",
  "por",
  "porfa",
  "queria",
  "quiero",
  "reciente",
  "recientes",
  "resumen",
  "semana",
  "semanas",
  "sobre",
  "tema",
  "titular",
  "titulares",
  "today",
  "ultim",
  "ultima",
  "ultimas",
  "ultimo",
  "ultimos",
  "ver",
  "web",
  "week",
  "weeks",
  "year",
  "years",
  "y",
]);

const SHORT_TOPIC_TOKENS = new Set<string>(["ai", "ia", "ml", "btc", "eth", "nft", "seo", "sem", "ufc", "f1"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeNewsTopicText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function normalizeToken(rawToken: string): string {
  let token = normalizeNewsTopicText(rawToken).replace(/[^a-z0-9]/g, "").trim();
  if (!token) {
    return "";
  }
  if (token.length > 4 && token.endsWith("s")) {
    token = token.slice(0, -1);
  }
  return token;
}

export function extractNewsTopicTokens(rawQuery: string): string[] {
  const normalized = normalizeNewsTopicText(rawQuery)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }

  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const rawToken of normalized.split(" ")) {
    const token = normalizeToken(rawToken);
    if (!token || /^\d+$/.test(token)) {
      continue;
    }
    if (NEWS_TOPIC_STOPWORDS.has(token)) {
      continue;
    }
    if (token.length < 3 && !SHORT_TOPIC_TOKENS.has(token)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= 8) {
      break;
    }
  }
  return tokens;
}

function tokenMatchesNormalizedText(normalizedText: string, tokenRaw: string): boolean {
  const token = normalizeToken(tokenRaw);
  if (!token) {
    return false;
  }
  const boundary = new RegExp(`\\b${escapeRegExp(token)}\\b`);
  if (boundary.test(normalizedText)) {
    return true;
  }
  const singular = token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
  const plural = singular.endsWith("s") ? singular : `${singular}s`;
  if (singular.length >= 4 && (normalizedText.includes(singular) || normalizedText.includes(plural))) {
    return true;
  }
  return false;
}

export function countNewsTopicMatches(text: string, topicTokens: string[]): number {
  if (topicTokens.length === 0) {
    return 0;
  }
  const normalizedText = normalizeNewsTopicText(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedText) {
    return 0;
  }
  let matches = 0;
  for (const token of topicTokens) {
    if (tokenMatchesNormalizedText(normalizedText, token)) {
      matches += 1;
    }
  }
  return matches;
}
