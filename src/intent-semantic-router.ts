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
  threshold: number;
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
};

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

const ROUTES: SemanticRouteConfig[] = [
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
      "recordame mañana",
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

export class IntentSemanticRouter {
  private readonly routes: SemanticRouteConfig[];
  private readonly idfByTerm = new Map<string, number>();
  private readonly routeVectors = new Map<IntentRouteName, Map<string, number>>();

  constructor(routes: SemanticRouteConfig[] = ROUTES) {
    this.routes = routes;
    this.train();
  }

  private train(): void {
    const docs: Array<{ name: IntentRouteName; terms: string[] }> = [];
    const docFreq = new Map<string, number>();

    for (const route of this.routes) {
      for (const utterance of route.utterances) {
        const terms = withBigrams(tokenize(utterance));
        docs.push({ name: route.name, terms });
        const unique = new Set(terms);
        for (const term of unique) {
          docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
        }
      }
    }

    const totalDocs = Math.max(1, docs.length);
    for (const [term, df] of docFreq.entries()) {
      const idf = Math.log((1 + totalDocs) / (1 + df)) + 1;
      this.idfByTerm.set(term, idf);
    }

    const routeBuckets = new Map<IntentRouteName, Array<Map<string, number>>>();
    for (const doc of docs) {
      const tf = buildTermFrequency(doc.terms);
      const vector = new Map<string, number>();
      for (const [term, freq] of tf.entries()) {
        vector.set(term, freq * (this.idfByTerm.get(term) ?? 1));
      }
      const list = routeBuckets.get(doc.name) ?? [];
      list.push(vector);
      routeBuckets.set(doc.name, list);
    }

    for (const route of this.routes) {
      const vectors = routeBuckets.get(route.name) ?? [];
      const merged = new Map<string, number>();
      if (vectors.length === 0) {
        this.routeVectors.set(route.name, merged);
        continue;
      }
      for (const vector of vectors) {
        for (const [term, value] of vector.entries()) {
          merged.set(term, (merged.get(term) ?? 0) + value);
        }
      }
      for (const [term, value] of merged.entries()) {
        merged.set(term, value / vectors.length);
      }
      this.routeVectors.set(route.name, merged);
    }
  }

  private embedQuery(text: string): Map<string, number> {
    const terms = withBigrams(tokenize(text));
    const tf = buildTermFrequency(terms);
    const vector = new Map<string, number>();
    for (const [term, freq] of tf.entries()) {
      vector.set(term, freq * (this.idfByTerm.get(term) ?? 1));
    }
    return vector;
  }

  route(text: string, options?: RouteOptions): SemanticRouteDecision | null {
    const normalized = normalizeText(text);
    if (!normalized || normalized.length < 3) {
      return null;
    }

    const allowedSet = new Set<IntentRouteName>(options?.allowed ?? this.routes.map((route) => route.name));
    const queryVector = this.embedQuery(normalized);
    const scored: RouteScore[] = [];
    for (const route of this.routes) {
      if (!allowedSet.has(route.name)) {
        continue;
      }
      const routeVector = this.routeVectors.get(route.name) ?? new Map<string, number>();
      const score = cosineSimilarity(queryVector, routeVector);
      scored.push({ name: route.name, score });
    }
    if (scored.length === 0) {
      return null;
    }
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0]!;
    const second = scored[1];
    const routeConfig = this.routes.find((route) => route.name === best.name);
    if (!routeConfig) {
      return null;
    }
    if (best.score < routeConfig.threshold) {
      return null;
    }
    if (second && best.score - second.score < DEFAULT_MIN_SCORE_GAP) {
      return null;
    }

    const topK = Math.max(1, Math.min(5, Math.floor(options?.topK ?? 3)));
    return {
      handler: best.name,
      score: Number(best.score.toFixed(4)),
      reason: second
        ? `semantic score ${best.score.toFixed(4)} >= threshold ${routeConfig.threshold.toFixed(2)} and gap ${(best.score - second.score).toFixed(4)} >= ${DEFAULT_MIN_SCORE_GAP.toFixed(2)}`
        : `semantic score ${best.score.toFixed(4)} >= threshold ${routeConfig.threshold.toFixed(2)}`,
      alternatives: scored.slice(0, topK).map((item) => ({
        name: item.name,
        score: Number(item.score.toFixed(4)),
      })),
    };
  }

  getRouteThreshold(name: IntentRouteName): number | null {
    const route = this.routes.find((item) => item.name === name);
    return route ? route.threshold : null;
  }

  listRouteThresholds(): Array<{ name: IntentRouteName; threshold: number }> {
    return this.routes.map((route) => ({
      name: route.name,
      threshold: route.threshold,
    }));
  }
}

export type { IntentRouteName, SemanticRouteDecision };
