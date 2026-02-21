import fs from "node:fs/promises";
import path from "node:path";

type IntentRouteName =
  | "stoic-smalltalk"
  | "self-maintenance"
  | "connector"
  | "schedule"
  | "memory"
  | "gmail-recipients"
  | "gmail"
  | "workspace"
  | "document"
  | "web";

type SemanticRouteConfig = {
  name: IntentRouteName;
  utterances: string[];
  negativeUtterances?: string[];
  threshold: number;
  alpha?: number;
};

type RouteScore = {
  name: IntentRouteName;
  score: number;
};

type SemanticRouteDecision = {
  handler: IntentRouteName;
  score: number;
  reason: string;
  alternatives: RouteScore[];
};

type RouteOptions = {
  allowed?: IntentRouteName[];
  topK?: number;
  boosts?: Partial<Record<IntentRouteName, number>>;
  alphaOverrides?: Partial<Record<IntentRouteName, number>>;
  minGap?: number;
};

type IntentRouterDatasetSample = {
  text: string;
  finalHandler?: string;
};

type FitOptions = {
  maxIter?: number;
  searchRange?: number;
  minThreshold?: number;
  maxThreshold?: number;
  minGap?: number;
};

type FitResult = {
  totalLabeled: number;
  beforeAccuracy: number;
  afterAccuracy: number;
  improved: boolean;
  beforeThresholds: Record<string, number>;
  afterThresholds: Record<string, number>;
};

type PersistedIntentRouterConfig = {
  version: number;
  updatedAt: string;
  hybridAlpha: number;
  minScoreGap: number;
  routes: SemanticRouteConfig[];
};

const KNOWN_ROUTE_NAMES: IntentRouteName[] = [
  "stoic-smalltalk",
  "self-maintenance",
  "connector",
  "schedule",
  "memory",
  "gmail-recipients",
  "gmail",
  "workspace",
  "document",
  "web",
];

const SPANISH_STOPWORDS = new Set([
  "a",
  "al",
  "algo",
  "ante",
  "bajo",
  "con",
  "contra",
  "de",
  "del",
  "desde",
  "donde",
  "el",
  "ella",
  "ellas",
  "ellos",
  "en",
  "entre",
  "era",
  "eramos",
  "es",
  "esa",
  "ese",
  "eso",
  "esta",
  "estaba",
  "estamos",
  "estan",
  "estar",
  "este",
  "esto",
  "fue",
  "fueron",
  "ha",
  "hay",
  "la",
  "las",
  "le",
  "les",
  "lo",
  "los",
  "me",
  "mi",
  "mis",
  "mucho",
  "muy",
  "no",
  "nos",
  "o",
  "para",
  "pero",
  "por",
  "porque",
  "que",
  "se",
  "si",
  "sin",
  "sobre",
  "su",
  "sus",
  "te",
  "tu",
  "tus",
  "un",
  "una",
  "uno",
  "unos",
  "unas",
  "y",
  "ya",
]);

const DEFAULT_ROUTES: SemanticRouteConfig[] = [
  {
    name: "stoic-smalltalk",
    threshold: 0.2,
    utterances: [
      "en que estas pensando",
      "en que andas",
      "dime algo bonito",
      "decime algo lindo",
      "dame una reflexion",
      "frase estoica",
    ],
  },
  {
    name: "self-maintenance",
    threshold: 0.3,
    utterances: [
      "reinicia el agente",
      "actualiza el repositorio",
      "sumar habilidad",
      "crear skill",
      "eliminar skill",
      "estado del servicio",
    ],
  },
  {
    name: "connector",
    threshold: 0.3,
    utterances: [
      "inicia lim",
      "deten lim",
      "reinicia lim",
      "estado del conector",
      "arranca el tunnel",
      "detener cloudflared",
      "consulta lim first_name",
      "buscar mensajes en lim",
      "trae mensajes de contacto en lim",
    ],
  },
  {
    name: "schedule",
    threshold: 0.24,
    utterances: [
      "recordame manana",
      "agenda una tarea",
      "programa recordatorio",
      "listar recordatorios",
      "editar tarea programada",
      "eliminar tarea pendiente",
    ],
  },
  {
    name: "memory",
    threshold: 0.24,
    utterances: [
      "te acordas de",
      "recordas lo que hablamos",
      "busca en memoria",
      "que recuerdas sobre",
      "acordate de esto",
      "recordatorio de contexto",
    ],
  },
  {
    name: "gmail-recipients",
    threshold: 0.28,
    utterances: [
      "agrega destinatario",
      "lista destinatarios",
      "actualiza destinatario",
      "elimina destinatario",
      "agenda de contactos de correo",
      "contactos para email",
    ],
  },
  {
    name: "gmail",
    threshold: 0.27,
    utterances: [
      "enviar correo",
      "enviame un email",
      "revisar gmail",
      "ultimo correo",
      "leer inbox",
      "mandar mail a",
    ],
  },
  {
    name: "workspace",
    threshold: 0.28,
    utterances: [
      "listar archivos",
      "crear archivo txt",
      "renombrar archivo",
      "mover archivo a carpeta",
      "eliminar archivo",
      "crear carpeta en workspace",
    ],
  },
  {
    name: "document",
    threshold: 0.24,
    utterances: [
      "leer documento pdf",
      "analiza este archivo",
      "resumi el contrato",
      "extrae texto del docx",
      "abrir documento",
      "que dice el pdf",
    ],
  },
  {
    name: "web",
    threshold: 0.23,
    utterances: [
      "busca en internet",
      "ultimas noticias",
      "revisa reddit",
      "abre este link",
      "noticias de cripto",
      "resumen de noticias de hoy",
    ],
  },
];

const DEFAULT_MIN_SCORE_GAP = 0.03;
const DEFAULT_HYBRID_ALPHA = 0.72;
const DEFAULT_NEGATIVE_PENALTY_BETA = 0.18;
const DEFAULT_BM25_K1 = 1.4;
const DEFAULT_BM25_B = 0.75;
const DEFAULT_BM25_LAMBDA = 0.35;
const DECISION_CACHE_MAX_ENTRIES = 5000;

function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !SPANISH_STOPWORDS.has(token));
}

function withBigrams(tokens: string[]): string[] {
  const terms = [...tokens];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    terms.push(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return terms;
}

function withCharTrigrams(input: string): string[] {
  const compact = normalizeText(input).replace(/\s+/g, "_");
  if (compact.length < 3) {
    return compact ? [compact] : [];
  }
  const grams: string[] = [];
  for (let i = 0; i <= compact.length - 3; i += 1) {
    grams.push(compact.slice(i, i + 3));
  }
  return grams;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const value of a.values()) {
    normA += value * value;
  }
  for (const value of b.values()) {
    normB += value * value;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }

  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, value] of small.entries()) {
    const other = large.get(term);
    if (typeof other === "number") {
      dot += value * other;
    }
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildTermFrequency(terms: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const term of terms) {
    tf.set(term, (tf.get(term) ?? 0) + 1);
  }
  return tf;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function safeParsePersistedRoutes(raw: string): PersistedIntentRouterConfig | null {
  try {
    const parsed = JSON.parse(raw) as PersistedIntentRouterConfig;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (!Array.isArray(parsed.routes) || parsed.routes.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export class IntentSemanticRouter {
  private routes: SemanticRouteConfig[];
  private hybridAlpha: number;
  private minScoreGap: number;
  private readonly negativePenaltyBeta: number;
  private readonly bm25K1: number;
  private readonly bm25B: number;
  private readonly bm25Lambda: number;
  private readonly idfByWordTerm = new Map<string, number>();
  private readonly idfByCharTerm = new Map<string, number>();
  private readonly wordDocFreq = new Map<string, number>();
  private totalWordDocs = 0;
  private avgWordDocLength = 0;
  private readonly routeWordDocs = new Map<IntentRouteName, Array<string[]>>();
  private readonly routeWordVectors = new Map<IntentRouteName, Map<string, number>>();
  private readonly routeCharVectors = new Map<IntentRouteName, Map<string, number>>();
  private readonly routeNegativeWordVectors = new Map<IntentRouteName, Map<string, number>>();
  private readonly routeNegativeCharVectors = new Map<IntentRouteName, Map<string, number>>();
  private readonly constructorRouteAlphaOverrides = new Map<IntentRouteName, number>();
  private readonly routeAlphaByName = new Map<IntentRouteName, number>();
  private readonly decisionCache = new Map<
    string,
    {
      cachedAt: number;
      decision: SemanticRouteDecision | null;
    }
  >();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(params?: {
    routes?: SemanticRouteConfig[];
    hybridAlpha?: number;
    minScoreGap?: number;
    negativePenaltyBeta?: number;
    bm25K1?: number;
    bm25B?: number;
    bm25Lambda?: number;
    routeAlphaOverrides?: Partial<Record<IntentRouteName, number>>;
  }) {
    this.routes = (params?.routes ?? DEFAULT_ROUTES).map((route) => ({
      name: route.name,
      threshold: clamp(route.threshold, 0.01, 0.99),
      utterances: route.utterances.map((item) => item.trim()).filter(Boolean),
      negativeUtterances: (route.negativeUtterances ?? []).map((item) => item.trim()).filter(Boolean),
      ...(typeof route.alpha === "number" ? { alpha: clamp(route.alpha, 0.05, 0.95) } : {}),
    }));
    this.hybridAlpha = clamp(params?.hybridAlpha ?? DEFAULT_HYBRID_ALPHA, 0.05, 0.95);
    this.minScoreGap = clamp(params?.minScoreGap ?? DEFAULT_MIN_SCORE_GAP, 0.0, 0.5);
    this.negativePenaltyBeta = clamp(params?.negativePenaltyBeta ?? DEFAULT_NEGATIVE_PENALTY_BETA, 0, 0.5);
    this.bm25K1 = clamp(params?.bm25K1 ?? DEFAULT_BM25_K1, 0.2, 3);
    this.bm25B = clamp(params?.bm25B ?? DEFAULT_BM25_B, 0, 1);
    this.bm25Lambda = clamp(params?.bm25Lambda ?? DEFAULT_BM25_LAMBDA, 0, 1);
    if (params?.routeAlphaOverrides) {
      for (const [route, value] of Object.entries(params.routeAlphaOverrides)) {
        if (!KNOWN_ROUTE_NAMES.includes(route as IntentRouteName) || typeof value !== "number") {
          continue;
        }
        this.constructorRouteAlphaOverrides.set(route as IntentRouteName, clamp(value, 0.05, 0.95));
      }
    }
    this.train();
  }

  private train(): void {
    this.idfByWordTerm.clear();
    this.idfByCharTerm.clear();
    this.wordDocFreq.clear();
    this.routeWordDocs.clear();
    this.routeAlphaByName.clear();
    this.routeWordVectors.clear();
    this.routeCharVectors.clear();
    this.routeNegativeWordVectors.clear();
    this.routeNegativeCharVectors.clear();
    this.decisionCache.clear();
    for (const [route, alpha] of this.constructorRouteAlphaOverrides.entries()) {
      this.routeAlphaByName.set(route, alpha);
    }

    const wordDocs: Array<{ name: IntentRouteName; terms: string[] }> = [];
    const charDocs: Array<{ name: IntentRouteName; terms: string[] }> = [];
    const wordDocFreq = new Map<string, number>();
    const charDocFreq = new Map<string, number>();

    for (const route of this.routes) {
      for (const utterance of route.utterances) {
        const wordTerms = withBigrams(tokenize(utterance));
        const charTerms = withCharTrigrams(utterance);
        wordDocs.push({ name: route.name, terms: wordTerms });
        charDocs.push({ name: route.name, terms: charTerms });
        const routeDocs = this.routeWordDocs.get(route.name) ?? [];
        routeDocs.push(wordTerms);
        this.routeWordDocs.set(route.name, routeDocs);

        const wordUnique = new Set(wordTerms);
        for (const term of wordUnique) {
          wordDocFreq.set(term, (wordDocFreq.get(term) ?? 0) + 1);
        }
        const charUnique = new Set(charTerms);
        for (const term of charUnique) {
          charDocFreq.set(term, (charDocFreq.get(term) ?? 0) + 1);
        }
      }
    }

    this.totalWordDocs = Math.max(1, wordDocs.length);
    this.avgWordDocLength =
      wordDocs.length > 0
        ? wordDocs.reduce((acc, doc) => acc + Math.max(1, doc.terms.length), 0) / wordDocs.length
        : 1;
    for (const [term, df] of wordDocFreq.entries()) {
      this.wordDocFreq.set(term, df);
    }

    const totalWordDocs = Math.max(1, wordDocs.length);
    for (const [term, df] of wordDocFreq.entries()) {
      const idf = Math.log((1 + totalWordDocs) / (1 + df)) + 1;
      this.idfByWordTerm.set(term, idf);
    }

    const totalCharDocs = Math.max(1, charDocs.length);
    for (const [term, df] of charDocFreq.entries()) {
      const idf = Math.log((1 + totalCharDocs) / (1 + df)) + 1;
      this.idfByCharTerm.set(term, idf);
    }

    const wordBuckets = new Map<IntentRouteName, Array<Map<string, number>>>();
    for (const doc of wordDocs) {
      const tf = buildTermFrequency(doc.terms);
      const vector = new Map<string, number>();
      for (const [term, freq] of tf.entries()) {
        vector.set(term, freq * (this.idfByWordTerm.get(term) ?? 1));
      }
      const list = wordBuckets.get(doc.name) ?? [];
      list.push(vector);
      wordBuckets.set(doc.name, list);
    }

    const charBuckets = new Map<IntentRouteName, Array<Map<string, number>>>();
    for (const doc of charDocs) {
      const tf = buildTermFrequency(doc.terms);
      const vector = new Map<string, number>();
      for (const [term, freq] of tf.entries()) {
        vector.set(term, freq * (this.idfByCharTerm.get(term) ?? 1));
      }
      const list = charBuckets.get(doc.name) ?? [];
      list.push(vector);
      charBuckets.set(doc.name, list);
    }

    const negativeWordBuckets = new Map<IntentRouteName, Array<Map<string, number>>>();
    const negativeCharBuckets = new Map<IntentRouteName, Array<Map<string, number>>>();
    for (const route of this.routes) {
      for (const utterance of route.negativeUtterances ?? []) {
        const wordTerms = withBigrams(tokenize(utterance));
        const charTerms = withCharTrigrams(utterance);
        const wordTf = buildTermFrequency(wordTerms);
        const charTf = buildTermFrequency(charTerms);
        const wordVector = new Map<string, number>();
        const charVector = new Map<string, number>();
        for (const [term, freq] of wordTf.entries()) {
          wordVector.set(term, freq * (this.idfByWordTerm.get(term) ?? 1));
        }
        for (const [term, freq] of charTf.entries()) {
          charVector.set(term, freq * (this.idfByCharTerm.get(term) ?? 1));
        }
        const wordList = negativeWordBuckets.get(route.name) ?? [];
        wordList.push(wordVector);
        negativeWordBuckets.set(route.name, wordList);
        const charList = negativeCharBuckets.get(route.name) ?? [];
        charList.push(charVector);
        negativeCharBuckets.set(route.name, charList);
      }
    }

    for (const route of this.routes) {
      this.routeWordVectors.set(route.name, this.averageVectors(wordBuckets.get(route.name) ?? []));
      this.routeCharVectors.set(route.name, this.averageVectors(charBuckets.get(route.name) ?? []));
      this.routeNegativeWordVectors.set(route.name, this.averageVectors(negativeWordBuckets.get(route.name) ?? []));
      this.routeNegativeCharVectors.set(route.name, this.averageVectors(negativeCharBuckets.get(route.name) ?? []));
      if (typeof route.alpha === "number") {
        this.routeAlphaByName.set(route.name, clamp(route.alpha, 0.05, 0.95));
      }
    }
  }

  private averageVectors(vectors: Array<Map<string, number>>): Map<string, number> {
    const merged = new Map<string, number>();
    if (vectors.length === 0) {
      return merged;
    }
    for (const vector of vectors) {
      for (const [term, value] of vector.entries()) {
        merged.set(term, (merged.get(term) ?? 0) + value);
      }
    }
    for (const [term, value] of merged.entries()) {
      merged.set(term, value / vectors.length);
    }
    return merged;
  }

  private embedWordQuery(text: string): Map<string, number> {
    const terms = withBigrams(tokenize(text));
    const tf = buildTermFrequency(terms);
    const vector = new Map<string, number>();
    for (const [term, freq] of tf.entries()) {
      vector.set(term, freq * (this.idfByWordTerm.get(term) ?? 1));
    }
    return vector;
  }

  private embedCharQuery(text: string): Map<string, number> {
    const terms = withCharTrigrams(text);
    const tf = buildTermFrequency(terms);
    const vector = new Map<string, number>();
    for (const [term, freq] of tf.entries()) {
      vector.set(term, freq * (this.idfByCharTerm.get(term) ?? 1));
    }
    return vector;
  }

  private normalizeBm25Score(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }
    // Saturating curve to keep BM25 in [0,1] and comparable to cosine.
    return clamp(1 - Math.exp(-raw / 6), 0, 1);
  }

  private scoreRouteBm25(routeName: IntentRouteName, queryTermsInput: string[]): number {
    const queryTerms = Array.from(new Set(queryTermsInput.filter(Boolean)));
    if (queryTerms.length === 0) {
      return 0;
    }
    const docs = this.routeWordDocs.get(routeName) ?? [];
    if (docs.length === 0) {
      return 0;
    }

    let bestDocScore = 0;
    for (const docTerms of docs) {
      const tf = buildTermFrequency(docTerms);
      const docLen = Math.max(1, docTerms.length);
      let score = 0;
      for (const term of queryTerms) {
        const termFreq = tf.get(term) ?? 0;
        if (termFreq <= 0) {
          continue;
        }
        const df = this.wordDocFreq.get(term) ?? 0;
        const idf = Math.log(1 + (this.totalWordDocs - df + 0.5) / (df + 0.5));
        const denom = termFreq + this.bm25K1 * (1 - this.bm25B + this.bm25B * (docLen / Math.max(1, this.avgWordDocLength)));
        score += idf * ((termFreq * (this.bm25K1 + 1)) / Math.max(1e-9, denom));
      }
      if (score > bestDocScore) {
        bestDocScore = score;
      }
    }
    return this.normalizeBm25Score(bestDocScore);
  }

  private computeAdaptiveAlpha(routeName: IntentRouteName, normalizedText: string, override?: number): number {
    const baseAlpha = clamp(
      typeof override === "number"
        ? override
        : this.routeAlphaByName.get(routeName) ?? this.hybridAlpha,
      0.05,
      0.95,
    );
    const wordTerms = tokenize(normalizedText);
    const tokenCount = wordTerms.length;
    const nonAlphaNumChars = normalizedText.replace(/[a-z0-9\s]/g, "").length;
    const noiseRatio = normalizedText.length > 0 ? nonAlphaNumChars / normalizedText.length : 0;
    let adaptive = baseAlpha;
    if (tokenCount <= 4) {
      adaptive += 0.08;
    } else if (tokenCount >= 16) {
      adaptive -= 0.05;
    }
    if (noiseRatio >= 0.22) {
      adaptive -= 0.06;
    }
    if (/\b(gmail|mail|email|lim|workspace|archivo|carpeta|recordatorio|noticias|web)\b/.test(normalizedText)) {
      adaptive += 0.03;
    }
    return clamp(adaptive, 0.05, 0.95);
  }

  private scoreRoutes(
    text: string,
    options?: Pick<RouteOptions, "allowed" | "boosts" | "alphaOverrides">,
  ): RouteScore[] {
    const normalized = normalizeText(text);
    const allowedSet = new Set<IntentRouteName>(options?.allowed ?? this.routes.map((route) => route.name));
    const wordVector = this.embedWordQuery(normalized);
    const charVector = this.embedCharQuery(normalized);
    const queryTerms = withBigrams(tokenize(normalized));
    const boosts = options?.boosts ?? {};
    const alphaOverrides = options?.alphaOverrides ?? {};

    const scored: RouteScore[] = [];
    for (const route of this.routes) {
      if (!allowedSet.has(route.name)) {
        continue;
      }
      const routeWordVector = this.routeWordVectors.get(route.name) ?? new Map<string, number>();
      const routeCharVector = this.routeCharVectors.get(route.name) ?? new Map<string, number>();
      const routeNegativeWordVector = this.routeNegativeWordVectors.get(route.name) ?? new Map<string, number>();
      const routeNegativeCharVector = this.routeNegativeCharVectors.get(route.name) ?? new Map<string, number>();
      const wordScore = cosineSimilarity(wordVector, routeWordVector);
      const bm25Score = this.scoreRouteBm25(route.name, queryTerms);
      const lexicalScore = clamp((1 - this.bm25Lambda) * wordScore + this.bm25Lambda * bm25Score, 0, 1);
      const charScore = cosineSimilarity(charVector, routeCharVector);
      const negativeWordScore = cosineSimilarity(wordVector, routeNegativeWordVector);
      const negativeCharScore = cosineSimilarity(charVector, routeNegativeCharVector);
      const adaptiveAlpha = this.computeAdaptiveAlpha(route.name, normalized, alphaOverrides[route.name]);
      const negativePenalty = this.negativePenaltyBeta * (adaptiveAlpha * negativeWordScore + (1 - adaptiveAlpha) * negativeCharScore);
      const boost = boosts[route.name] ?? 0;
      const hybridScore = clamp(adaptiveAlpha * lexicalScore + (1 - adaptiveAlpha) * charScore + boost - negativePenalty, 0, 1);
      scored.push({ name: route.name, score: hybridScore });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  private classifyByThresholds(
    scored: RouteScore[],
    thresholds: Record<string, number>,
    minGap: number,
  ): IntentRouteName | null {
    const best = scored[0];
    if (!best) {
      return null;
    }
    const threshold = thresholds[best.name] ?? 0;
    if (best.score < threshold) {
      return null;
    }
    const second = scored[1];
    if (second && best.score - second.score < minGap) {
      return null;
    }
    return best.name;
  }

  route(text: string, options?: RouteOptions): SemanticRouteDecision | null {
    const normalized = normalizeText(text);
    if (!normalized || normalized.length < 3) {
      return null;
    }
    const cacheKey = JSON.stringify({
      text: normalized,
      allowed: options?.allowed ?? [],
      boosts: options?.boosts ?? {},
      alphaOverrides: options?.alphaOverrides ?? {},
      topK: options?.topK ?? 3,
      minGap: options?.minGap ?? this.minScoreGap,
    });
    const fromCache = this.decisionCache.get(cacheKey);
    if (fromCache && Date.now() - fromCache.cachedAt < 5 * 60 * 1000) {
      this.cacheHits += 1;
      return fromCache.decision ? { ...fromCache.decision, alternatives: [...fromCache.decision.alternatives] } : null;
    }
    this.cacheMisses += 1;

    const scored = this.scoreRoutes(normalized, {
      allowed: options?.allowed,
      boosts: options?.boosts,
      alphaOverrides: options?.alphaOverrides,
    });
    if (scored.length === 0) {
      return null;
    }

    const best = scored[0]!;
    const second = scored[1];
    const routeConfig = this.routes.find((route) => route.name === best.name);
    if (!routeConfig) {
      return null;
    }

    const minGap = typeof options?.minGap === "number" ? options.minGap : this.minScoreGap;
    if (best.score < routeConfig.threshold) {
      this.setDecisionCache(cacheKey, null);
      return null;
    }
    if (second && best.score - second.score < minGap) {
      this.setDecisionCache(cacheKey, null);
      return null;
    }

    const topK = Math.max(1, Math.min(10, Math.floor(options?.topK ?? 3)));
    const decision = {
      handler: best.name,
      score: Number(best.score.toFixed(4)),
      reason: second
        ? `hybrid score ${best.score.toFixed(4)} >= threshold ${routeConfig.threshold.toFixed(2)} and gap ${(best.score - second.score).toFixed(4)} >= ${minGap.toFixed(2)} (alpha=${this.hybridAlpha.toFixed(2)})`
        : `hybrid score ${best.score.toFixed(4)} >= threshold ${routeConfig.threshold.toFixed(2)} (alpha=${this.hybridAlpha.toFixed(2)})`,
      alternatives: scored.slice(0, topK).map((item) => ({
        name: item.name,
        score: Number(item.score.toFixed(4)),
      })),
    };
    this.setDecisionCache(cacheKey, decision);
    return decision;
  }

  private setDecisionCache(cacheKey: string, decision: SemanticRouteDecision | null): void {
    if (this.decisionCache.size >= DECISION_CACHE_MAX_ENTRIES) {
      const firstKey = this.decisionCache.keys().next().value;
      if (typeof firstKey === "string") {
        this.decisionCache.delete(firstKey);
      }
    }
    this.decisionCache.set(cacheKey, {
      cachedAt: Date.now(),
      decision,
    });
  }

  getRouteThreshold(name: IntentRouteName): number | null {
    const route = this.routes.find((item) => item.name === name);
    return route ? route.threshold : null;
  }

  setRouteThreshold(name: IntentRouteName, threshold: number): boolean {
    const route = this.routes.find((item) => item.name === name);
    if (!route) {
      return false;
    }
    route.threshold = clamp(threshold, 0.01, 0.99);
    return true;
  }

  listRouteThresholds(): Array<{ name: IntentRouteName; threshold: number }> {
    return this.routes.map((route) => ({
      name: route.name,
      threshold: route.threshold,
    }));
  }

  listRoutes(): SemanticRouteConfig[] {
    return this.routes.map((route) => ({
      name: route.name,
      threshold: route.threshold,
      utterances: [...route.utterances],
      negativeUtterances: [...(route.negativeUtterances ?? [])],
      ...(typeof route.alpha === "number" ? { alpha: route.alpha } : {}),
    }));
  }

  clearDecisionCache(): void {
    this.decisionCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  getDecisionCacheStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.decisionCache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  getHybridAlpha(): number {
    return this.hybridAlpha;
  }

  getMinScoreGap(): number {
    return this.minScoreGap;
  }

  setHybridAlpha(value: number): void {
    this.hybridAlpha = clamp(value, 0.05, 0.95);
  }

  setMinScoreGap(value: number): void {
    this.minScoreGap = clamp(value, 0, 0.5);
  }

  async loadFromFile(filePath: string, options?: { createIfMissing?: boolean }): Promise<void> {
    const resolved = path.resolve(process.cwd(), filePath);
    try {
      const raw = await fs.readFile(resolved, "utf8");
      const parsed = safeParsePersistedRoutes(raw);
      if (!parsed) {
        throw new Error("archivo de rutas inválido");
      }
      const validRoutes = parsed.routes
        .filter((route) => KNOWN_ROUTE_NAMES.includes(route.name))
        .map((route) => ({
          name: route.name,
          threshold: clamp(route.threshold, 0.01, 0.99),
          utterances: route.utterances.map((item) => item.trim()).filter(Boolean),
          negativeUtterances: (route.negativeUtterances ?? []).map((item) => item.trim()).filter(Boolean),
          ...(typeof route.alpha === "number" ? { alpha: clamp(route.alpha, 0.05, 0.95) } : {}),
        }))
        .filter((route) => route.utterances.length > 0);
      if (validRoutes.length === 0) {
        throw new Error("sin rutas válidas");
      }
      this.routes = validRoutes;
      this.hybridAlpha = clamp(parsed.hybridAlpha ?? this.hybridAlpha, 0.05, 0.95);
      this.minScoreGap = clamp(parsed.minScoreGap ?? this.minScoreGap, 0, 0.5);
      this.train();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/enoent/i.test(message) && options?.createIfMissing) {
        await this.saveToFile(resolved);
        return;
      }
      throw error;
    }
  }

  async saveToFile(filePath: string): Promise<void> {
    const resolved = path.resolve(process.cwd(), filePath);
    const payload: PersistedIntentRouterConfig = {
      version: 1,
      updatedAt: new Date().toISOString(),
      hybridAlpha: this.hybridAlpha,
      minScoreGap: this.minScoreGap,
      routes: this.listRoutes(),
    };
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  evaluateDataset(samples: IntentRouterDatasetSample[], minGapOverride?: number): number {
    const labeled = samples.filter((item) => typeof item.finalHandler === "string" && item.finalHandler.trim().length > 0);
    if (labeled.length === 0) {
      return 0;
    }
    const thresholds = Object.fromEntries(this.routes.map((route) => [route.name, route.threshold]));
    const minGap = typeof minGapOverride === "number" ? minGapOverride : this.minScoreGap;
    let correct = 0;
    for (const sample of labeled) {
      const scored = this.scoreRoutes(sample.text);
      const predicted = this.classifyByThresholds(scored, thresholds, minGap);
      if (predicted && predicted === sample.finalHandler) {
        correct += 1;
      }
    }
    return correct / labeled.length;
  }

  fitThresholdsFromDataset(samples: IntentRouterDatasetSample[], options?: FitOptions): FitResult {
    const labeled = samples.filter((item) => typeof item.finalHandler === "string" && item.finalHandler.trim().length > 0);
    const totalLabeled = labeled.length;
    const beforeThresholds = Object.fromEntries(this.routes.map((route) => [route.name, round3(route.threshold)]));

    if (totalLabeled < 25) {
      return {
        totalLabeled,
        beforeAccuracy: this.evaluateDataset(labeled),
        afterAccuracy: this.evaluateDataset(labeled),
        improved: false,
        beforeThresholds,
        afterThresholds: beforeThresholds,
      };
    }

    const minThreshold = clamp(options?.minThreshold ?? 0.05, 0.01, 0.95);
    const maxThreshold = clamp(options?.maxThreshold ?? 0.95, minThreshold + 0.01, 0.99);
    const maxIter = Math.max(50, Math.min(5000, Math.floor(options?.maxIter ?? 600)));
    const searchRange = clamp(options?.searchRange ?? 0.09, 0.01, 0.5);
    const minGap = clamp(options?.minGap ?? this.minScoreGap, 0, 0.5);

    const current = Object.fromEntries(this.routes.map((route) => [route.name, route.threshold]));
    let best = { ...current };
    let bestAcc = this.evaluateWithThresholds(labeled, best, minGap);

    // Coordinate descent over quantile-based candidates per route.
    const routeQuantileCandidates = new Map<string, number[]>();
    for (const route of this.routes) {
      const positives: number[] = [];
      for (const sample of labeled) {
        if (sample.finalHandler !== route.name) {
          continue;
        }
        const scored = this.scoreRoutes(sample.text);
        const own = scored.find((item) => item.name === route.name);
        if (own) {
          positives.push(own.score);
        }
      }
      const sorted = positives.sort((a, b) => a - b);
      const quantiles = [0.1, 0.2, 0.3, 0.4, 0.5].map((q) => {
        if (sorted.length === 0) {
          return route.threshold;
        }
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
        return sorted[idx] ?? route.threshold;
      });
      const aroundCurrent = [
        route.threshold - searchRange,
        route.threshold - searchRange / 2,
        route.threshold,
        route.threshold + searchRange / 2,
        route.threshold + searchRange,
      ];
      routeQuantileCandidates.set(
        route.name,
        Array.from(
          new Set(
            [...quantiles, ...aroundCurrent]
              .map((item) => round3(clamp(item, minThreshold, maxThreshold)))
              .filter((item) => Number.isFinite(item)),
          ),
        ).sort((a, b) => a - b),
      );
    }

    const rounds = Math.max(1, Math.min(8, Math.floor(maxIter / Math.max(1, this.routes.length * 10))));
    for (let round = 0; round < rounds; round += 1) {
      let improvedRound = false;
      for (const route of this.routes) {
        const candidates = routeQuantileCandidates.get(route.name) ?? [route.threshold];
        let localBestThreshold = best[route.name] ?? route.threshold;
        let localBestAccuracy = bestAcc;
        for (const candidateThreshold of candidates) {
          const candidate = { ...best, [route.name]: candidateThreshold };
          const acc = this.evaluateWithThresholds(labeled, candidate, minGap);
          if (acc > localBestAccuracy) {
            localBestAccuracy = acc;
            localBestThreshold = candidateThreshold;
          }
        }
        if (localBestAccuracy > bestAcc) {
          bestAcc = localBestAccuracy;
          best = { ...best, [route.name]: localBestThreshold };
          improvedRound = true;
        }
      }
      if (!improvedRound) {
        break;
      }
    }

    // Random refinement around best solution.
    for (let i = 0; i < maxIter; i += 1) {
      const candidate: Record<string, number> = { ...best };
      for (const route of this.routes) {
        const base = best[route.name] ?? route.threshold;
        const jitter = randomInRange(-searchRange, searchRange);
        candidate[route.name] = round3(clamp(base + jitter, minThreshold, maxThreshold));
      }
      const acc = this.evaluateWithThresholds(labeled, candidate, minGap);
      if (acc > bestAcc) {
        bestAcc = acc;
        best = candidate;
      }
    }

    for (const route of this.routes) {
      route.threshold = clamp(best[route.name] ?? route.threshold, minThreshold, maxThreshold);
    }

    const afterThresholds = Object.fromEntries(this.routes.map((route) => [route.name, round3(route.threshold)]));
    const beforeAccuracy = this.evaluateWithThresholds(labeled, current, minGap);
    const afterAccuracy = this.evaluateWithThresholds(labeled, best, minGap);

    return {
      totalLabeled,
      beforeAccuracy,
      afterAccuracy,
      improved: afterAccuracy > beforeAccuracy,
      beforeThresholds,
      afterThresholds,
    };
  }

  augmentNegativesFromDataset(samples: IntentRouterDatasetSample[], maxPerRoute = 25): Record<string, number> {
    const perRoute = new Map<string, Set<string>>();
    for (const sample of samples) {
      const expected = (sample.finalHandler ?? "").trim();
      if (!expected || !KNOWN_ROUTE_NAMES.includes(expected as IntentRouteName)) {
        continue;
      }
      const scored = this.scoreRoutes(sample.text);
      const predicted = scored[0]?.name;
      if (!predicted || predicted === expected) {
        continue;
      }
      const normalized = normalizeText(sample.text);
      if (normalized.length < 6 || normalized.length > 220) {
        continue;
      }
      const bucket = perRoute.get(predicted) ?? new Set<string>();
      if (bucket.size < maxPerRoute) {
        bucket.add(normalized);
      }
      perRoute.set(predicted, bucket);
    }

    const addedByRoute: Record<string, number> = {};
    for (const route of this.routes) {
      const bucket = perRoute.get(route.name);
      if (!bucket || bucket.size === 0) {
        continue;
      }
      const currentSet = new Set((route.negativeUtterances ?? []).map((item) => normalizeText(item)));
      let added = 0;
      for (const phrase of bucket) {
        if (currentSet.has(phrase)) {
          continue;
        }
        route.negativeUtterances = [...(route.negativeUtterances ?? []), phrase];
        currentSet.add(phrase);
        added += 1;
      }
      if (added > 0) {
        addedByRoute[route.name] = added;
      }
    }
    if (Object.keys(addedByRoute).length > 0) {
      this.train();
    }
    return addedByRoute;
  }

  private evaluateWithThresholds(
    samples: IntentRouterDatasetSample[],
    thresholds: Record<string, number>,
    minGap: number,
  ): number {
    if (samples.length === 0) {
      return 0;
    }
    let correct = 0;
    for (const sample of samples) {
      const scored = this.scoreRoutes(sample.text);
      const predicted = this.classifyByThresholds(scored, thresholds, minGap);
      if (predicted && predicted === sample.finalHandler) {
        correct += 1;
      }
    }
    return correct / samples.length;
  }
}

export type {
  FitResult,
  IntentRouteName,
  RouteOptions,
  SemanticRouteConfig,
  SemanticRouteDecision,
};
