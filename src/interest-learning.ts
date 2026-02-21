import fs from "node:fs/promises";
import path from "node:path";

type InterestCategory = "gmail" | "schedule" | "web" | "documents" | "self" | "shell" | "audio" | "news";

type ChatSuggestionState = {
  day: string;
  sentCount: number;
  lastSentAt?: string;
  lastType?: string;
};

type ChatInterestProfile = {
  chatId: number;
  observations: number;
  categories: Record<string, number>;
  keywords: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  suggestions: ChatSuggestionState;
};

type InterestLearningStorage = {
  version: number;
  chats: ChatInterestProfile[];
};

type InterestLearningServiceOptions = {
  filePath: string;
  maxKeywordsPerChat?: number;
};

type RecordUserTextInput = {
  chatId: number;
  text: string;
};

type AddInterestInput = {
  chatId: number;
  topic: string;
};

type EligibilityOptions = {
  maxPerDay: number;
  minIntervalMs: number;
  minObservations: number;
  now?: Date;
};

export type InterestSummary = {
  chatId: number;
  observations: number;
  topCategories: Array<{ category: string; score: number }>;
  topKeywords: Array<{ keyword: string; score: number }>;
  suggestionsToday: number;
  suggestionsMaxPerDay: number;
  lastSuggestedAt?: string;
};

const DEFAULT_DAY = "1970-01-01";
const CATEGORY_PATTERNS: Record<InterestCategory, RegExp> = {
  gmail: /\b(gmail|correo|correos|mail|mails|email|emails|inbox|bandeja|asunto|enviar)\b/,
  schedule: /\b(recordame|recordatorio|recordatorios|agenda|tarea|tareas|programa|programar|agendar|reunion|reunion|turno)\b/,
  web: /\b(web|internet|google|busca|buscar|enlace|enlaces|link|links|noticia|noticias|sitio|url)\b/,
  documents: /\b(pdf|docx|xlsx|xls|ppt|pptx|documento|documentos|archivo|archivos|planilla|reporte)\b/,
  self: /\b(skill|skills|habilidad|habilidades|agente|memoria|modelo|perfil|reinicia|reiniciar|servicio)\b/,
  shell: /\b(shell|exec|comando|comandos|terminal|script|git|npm|systemctl|bash)\b/,
  audio: /\b(audio|voz|voice|transcrib|transcripcion|transcripcion|whisper)\b/,
  news: /\b(noticias?|novedades?|titulares?|actualidad|news|hoy|reciente|ultim[oa]s?|ultimas?\s+horas)\b/,
};

const NEWS_INTENT_PATTERN =
  /\b(noticias?|novedades?|titulares?|actualidad|news|hoy|ayer|reciente|ultim[oa]s?|ultimas?\s+horas|internet|web|blog|blogs|post|posts|red(?:es)?\s+social(?:es)?|sitios?\s+web|fuentes?)\b/;

const NEWS_NOISE_TERMS = new Set<string>([
  "noticia",
  "noticias",
  "novedad",
  "novedades",
  "titular",
  "titulares",
  "actualidad",
  "news",
  "hoy",
  "ayer",
  "reciente",
  "recientes",
  "ultimo",
  "ultimos",
  "ultima",
  "ultimas",
  "internet",
  "web",
  "blog",
  "blogs",
  "post",
  "posts",
  "red",
  "redes",
  "social",
  "sociales",
  "sitio",
  "sitios",
  "fuente",
  "fuentes",
  "dia",
  "dias",
  "horas",
]);

const STOPWORDS = new Set<string>([
  "de",
  "la",
  "que",
  "el",
  "en",
  "y",
  "a",
  "los",
  "del",
  "se",
  "las",
  "por",
  "un",
  "para",
  "con",
  "no",
  "una",
  "su",
  "al",
  "lo",
  "como",
  "mas",
  "pero",
  "sus",
  "le",
  "ya",
  "o",
  "porque",
  "esta",
  "este",
  "entre",
  "cuando",
  "muy",
  "sin",
  "sobre",
  "tambien",
  "me",
  "hasta",
  "hay",
  "donde",
  "quien",
  "desde",
  "todo",
  "nos",
  "durante",
  "todos",
  "uno",
  "les",
  "ni",
  "contra",
  "otros",
  "ese",
  "eso",
  "ante",
  "ellos",
  "e",
  "esto",
  "mi",
  "antes",
  "algunos",
  "que",
  "unos",
  "yo",
  "otro",
  "otras",
  "otra",
  "el",
  "tanto",
  "esa",
  "estos",
  "mucho",
  "quienes",
  "nada",
  "muchos",
  "cual",
  "poco",
  "ella",
  "estar",
  "estas",
  "algunas",
  "algo",
  "nosotros",
  "tu",
  "te",
  "ti",
  "tus",
  "ellas",
  "nosotras",
  "vosotros",
  "vosotras",
  "os",
  "mio",
  "mia",
  "mios",
  "mias",
  "tuyo",
  "tuya",
  "tuyos",
  "tuyas",
  "suyo",
  "suya",
  "suyos",
  "suyas",
  "nuestro",
  "nuestra",
  "nuestros",
  "nuestras",
  "vuestro",
  "vuestra",
  "vuestros",
  "vuestras",
  "esos",
  "esas",
  "estoy",
  "estas",
  "esta",
  "estamos",
  "estais",
  "estan",
  "como",
  "aunque",
  "si",
  "solo",
  "fue",
  "fui",
  "era",
  "eres",
  "soy",
  "somos",
  "ser",
  "hacer",
  "hace",
  "haces",
  "hago",
  "quiero",
  "necesito",
  "puedo",
  "podria",
  "dale",
  "ok",
  "listo",
  "favor",
  "hola",
  "buenas",
  "gracias",
  "mensaje",
  "mensajes",
]);

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function extractKeywords(normalized: string): string[] {
  const tokens = normalized.match(/[a-z0-9_-]{3,32}/g) ?? [];
  const deduped = new Set<string>();
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      continue;
    }
    if (STOPWORDS.has(token)) {
      continue;
    }
    deduped.add(token);
    if (deduped.size >= 20) {
      break;
    }
  }
  return [...deduped];
}

function extractNewsKeywords(normalized: string): string[] {
  return extractKeywords(normalized).filter((keyword) => !NEWS_NOISE_TERMS.has(keyword));
}

function topEntries(obj: Record<string, number>, limit: number): Array<{ key: string; value: number }> {
  return Object.entries(obj)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => {
      const byScore = (b[1] ?? 0) - (a[1] ?? 0);
      if (byScore !== 0) {
        return byScore;
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([key, value]) => ({ key, value }));
}

function dayKey(input?: Date): string {
  const date = input ?? new Date();
  return date.toISOString().slice(0, 10);
}

function normalizeSuggestionState(raw: unknown): ChatSuggestionState {
  if (!raw || typeof raw !== "object") {
    return { day: DEFAULT_DAY, sentCount: 0 };
  }
  const obj = raw as Record<string, unknown>;
  const day = typeof obj.day === "string" && obj.day.trim() ? obj.day.trim() : DEFAULT_DAY;
  const sentCountRaw =
    typeof obj.sentCount === "number" && Number.isFinite(obj.sentCount)
      ? obj.sentCount
      : Number.parseInt(String(obj.sentCount ?? 0), 10);
  const sentCount = clampInt(sentCountRaw, 0, 10_000);
  const lastSentAt = typeof obj.lastSentAt === "string" && obj.lastSentAt.trim() ? obj.lastSentAt.trim() : undefined;
  const lastType = typeof obj.lastType === "string" && obj.lastType.trim() ? obj.lastType.trim() : undefined;
  return {
    day,
    sentCount,
    ...(lastSentAt ? { lastSentAt } : {}),
    ...(lastType ? { lastType } : {}),
  };
}

function normalizeProfile(raw: unknown, maxKeywordsPerChat: number): ChatInterestProfile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const chatIdRaw = obj.chatId;
  const observationsRaw = obj.observations;
  const createdAtRaw = typeof obj.createdAt === "string" ? obj.createdAt.trim() : "";
  const updatedAtRaw = typeof obj.updatedAt === "string" ? obj.updatedAt.trim() : "";
  const categoriesRaw = obj.categories && typeof obj.categories === "object" ? (obj.categories as Record<string, unknown>) : {};
  const keywordsRaw = obj.keywords && typeof obj.keywords === "object" ? (obj.keywords as Record<string, unknown>) : {};

  const chatId =
    typeof chatIdRaw === "number" && Number.isFinite(chatIdRaw)
      ? Math.floor(chatIdRaw)
      : Number.parseInt(String(chatIdRaw ?? ""), 10);
  if (!Number.isFinite(chatId)) {
    return null;
  }

  const observations = clampInt(
    typeof observationsRaw === "number" && Number.isFinite(observationsRaw)
      ? observationsRaw
      : Number.parseInt(String(observationsRaw ?? 0), 10),
    0,
    10_000_000,
  );

  const createdAtDate = new Date(createdAtRaw);
  const updatedAtDate = new Date(updatedAtRaw);
  const fallbackDate = new Date().toISOString();
  const createdAt = Number.isFinite(createdAtDate.getTime()) ? createdAtDate.toISOString() : fallbackDate;
  const updatedAt = Number.isFinite(updatedAtDate.getTime()) ? updatedAtDate.toISOString() : createdAt;

  const categories: Record<string, number> = {};
  for (const [key, valueRaw] of Object.entries(categoriesRaw)) {
    const keyNormalized = normalizeText(key);
    if (!keyNormalized) {
      continue;
    }
    const value =
      typeof valueRaw === "number" && Number.isFinite(valueRaw)
        ? valueRaw
        : Number.parseInt(String(valueRaw ?? 0), 10);
    const score = clampInt(value, 0, 10_000_000);
    if (score > 0) {
      categories[keyNormalized] = score;
    }
  }

  const keywordPairs: Array<[string, number]> = [];
  for (const [key, valueRaw] of Object.entries(keywordsRaw)) {
    const keyword = normalizeText(key);
    if (!keyword || keyword.length < 3 || keyword.length > 32) {
      continue;
    }
    const value =
      typeof valueRaw === "number" && Number.isFinite(valueRaw)
        ? valueRaw
        : Number.parseInt(String(valueRaw ?? 0), 10);
    const score = clampInt(value, 0, 10_000_000);
    if (score > 0) {
      keywordPairs.push([keyword, score]);
    }
  }
  keywordPairs.sort((a, b) => {
    const byScore = (b[1] ?? 0) - (a[1] ?? 0);
    if (byScore !== 0) {
      return byScore;
    }
    return a[0].localeCompare(b[0]);
  });
  const keywords: Record<string, number> = {};
  for (const [keyword, score] of keywordPairs.slice(0, maxKeywordsPerChat)) {
    keywords[keyword] = score;
  }

  return {
    chatId,
    observations,
    categories,
    keywords,
    createdAt,
    updatedAt,
    suggestions: normalizeSuggestionState(obj.suggestions),
  };
}

export class InterestLearningService {
  private readonly filePath: string;
  private readonly maxKeywordsPerChat: number;
  private readonly profiles = new Map<number, ChatInterestProfile>();
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: InterestLearningServiceOptions) {
    this.filePath = path.resolve(options.filePath);
    this.maxKeywordsPerChat = clampInt(options.maxKeywordsPerChat ?? 240, 20, 4000);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let raw = "";
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      const empty: InterestLearningStorage = { version: 1, chats: [] };
      await fs.writeFile(this.filePath, `${JSON.stringify(empty, null, 2)}\n`, "utf8");
      this.loaded = true;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { version: 1, chats: [] };
    }
    const listRaw = Array.isArray((parsed as { chats?: unknown })?.chats)
      ? ((parsed as { chats: unknown[] }).chats ?? [])
      : [];
    for (const item of listRaw) {
      const profile = normalizeProfile(item, this.maxKeywordsPerChat);
      if (!profile) {
        continue;
      }
      this.profiles.set(profile.chatId, profile);
    }
    this.loaded = true;
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("InterestLearningService no esta cargado. Llama load() primero.");
    }
  }

  private async queuePersist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      const chats = [...this.profiles.values()].sort((a, b) => a.chatId - b.chatId);
      const payload: InterestLearningStorage = { version: 1, chats };
      await fs.writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    });
    await this.persistQueue;
  }

  private rotateDailySuggestionState(profile: ChatInterestProfile, now: Date): boolean {
    const today = dayKey(now);
    if (profile.suggestions.day === today) {
      return false;
    }
    profile.suggestions.day = today;
    profile.suggestions.sentCount = 0;
    profile.suggestions.lastType = undefined;
    return true;
  }

  private getOrCreateProfile(chatIdInput: number): ChatInterestProfile {
    const chatId = Math.floor(chatIdInput);
    const existing = this.profiles.get(chatId);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const created: ChatInterestProfile = {
      chatId,
      observations: 0,
      categories: {},
      keywords: {},
      createdAt: now,
      updatedAt: now,
      suggestions: {
        day: dayKey(new Date()),
        sentCount: 0,
      },
    };
    this.profiles.set(chatId, created);
    return created;
  }

  private trimKeywordMap(profile: ChatInterestProfile): void {
    const top = topEntries(profile.keywords, this.maxKeywordsPerChat);
    const next: Record<string, number> = {};
    for (const item of top) {
      next[item.key] = item.value;
    }
    profile.keywords = next;
  }

  async recordUserText(input: RecordUserTextInput): Promise<void> {
    this.ensureLoaded();
    const text = input.text.trim();
    if (!text) {
      return;
    }
    const normalized = normalizeText(text);
    if (!normalized) {
      return;
    }
    if (!NEWS_INTENT_PATTERN.test(normalized)) {
      return;
    }

    const profile = this.getOrCreateProfile(input.chatId);
    profile.observations = clampInt(profile.observations + 1, 1, 10_000_000);
    profile.categories.web = clampInt((profile.categories.web ?? 0) + 1, 1, 10_000_000);
    profile.categories.news = clampInt((profile.categories.news ?? 0) + 1, 1, 10_000_000);

    for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
      if (!pattern.test(normalized)) {
        continue;
      }
      profile.categories[category] = clampInt((profile.categories[category] ?? 0) + 1, 1, 10_000_000);
    }

    const keywords = extractNewsKeywords(normalized);
    for (const keyword of keywords) {
      profile.keywords[keyword] = clampInt((profile.keywords[keyword] ?? 0) + 1, 1, 10_000_000);
    }
    if (Object.keys(profile.keywords).length > this.maxKeywordsPerChat + 20) {
      this.trimKeywordMap(profile);
    }

    profile.updatedAt = new Date().toISOString();
    await this.queuePersist();
  }

  async addManualInterest(input: AddInterestInput): Promise<void> {
    this.ensureLoaded();
    const topic = normalizeText(input.topic);
    if (!topic) {
      return;
    }
    const profile = this.getOrCreateProfile(input.chatId);
    const keywords = extractNewsKeywords(topic);
    if (keywords.length === 0) {
      return;
    }
    profile.observations = clampInt(profile.observations + 1, 1, 10_000_000);
    profile.categories.web = clampInt((profile.categories.web ?? 0) + 1, 1, 10_000_000);
    profile.categories.news = clampInt((profile.categories.news ?? 0) + 1, 1, 10_000_000);
    for (const keyword of keywords) {
      profile.keywords[keyword] = clampInt((profile.keywords[keyword] ?? 0) + 2, 1, 10_000_000);
    }
    this.trimKeywordMap(profile);
    profile.updatedAt = new Date().toISOString();
    await this.queuePersist();
  }

  async removeInterestKeyword(chatIdInput: number, keywordInput: string): Promise<boolean> {
    this.ensureLoaded();
    const chatId = Math.floor(chatIdInput);
    const profile = this.profiles.get(chatId);
    if (!profile) {
      return false;
    }
    const keyword = normalizeText(keywordInput);
    if (!keyword) {
      return false;
    }
    if (!(keyword in profile.keywords)) {
      return false;
    }
    delete profile.keywords[keyword];
    profile.updatedAt = new Date().toISOString();
    await this.queuePersist();
    return true;
  }

  async clearChat(chatIdInput: number): Promise<boolean> {
    this.ensureLoaded();
    const chatId = Math.floor(chatIdInput);
    const existed = this.profiles.delete(chatId);
    if (!existed) {
      return false;
    }
    await this.queuePersist();
    return true;
  }

  getSummary(chatIdInput: number, maxPerDay: number): InterestSummary | null {
    this.ensureLoaded();
    const chatId = Math.floor(chatIdInput);
    const profile = this.profiles.get(chatId);
    if (!profile) {
      return null;
    }
    const categories = topEntries(profile.categories, 5).map((item) => ({
      category: item.key,
      score: item.value,
    }));
    const keywords = topEntries(profile.keywords, 10).map((item) => ({
      keyword: item.key,
      score: item.value,
    }));
    return {
      chatId: profile.chatId,
      observations: profile.observations,
      topCategories: categories,
      topKeywords: keywords,
      suggestionsToday: profile.suggestions.sentCount,
      suggestionsMaxPerDay: Math.max(1, Math.floor(maxPerDay)),
      ...(profile.suggestions.lastSentAt ? { lastSuggestedAt: profile.suggestions.lastSentAt } : {}),
    };
  }

  listEligibleChatIds(options: EligibilityOptions): number[] {
    this.ensureLoaded();
    const now = options.now ?? new Date();
    const minObservations = Math.max(1, Math.floor(options.minObservations));
    const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs));
    const maxPerDay = Math.max(1, Math.floor(options.maxPerDay));

    const eligible: number[] = [];
    let shouldPersist = false;
    for (const profile of this.profiles.values()) {
      if (this.rotateDailySuggestionState(profile, now)) {
        shouldPersist = true;
      }
      if (profile.observations < minObservations) {
        continue;
      }
      if (profile.suggestions.sentCount >= maxPerDay) {
        continue;
      }
      const lastAtMs = profile.suggestions.lastSentAt ? new Date(profile.suggestions.lastSentAt).getTime() : 0;
      if (Number.isFinite(lastAtMs) && lastAtMs > 0 && now.getTime() - lastAtMs < minIntervalMs) {
        continue;
      }
      const hasSignal = topEntries(profile.categories, 1).length > 0 || topEntries(profile.keywords, 1).length > 0;
      if (!hasSignal) {
        continue;
      }
      eligible.push(profile.chatId);
    }

    if (shouldPersist) {
      void this.queuePersist();
    }

    return eligible;
  }

  async markSuggestionSent(chatIdInput: number, type: string, nowInput?: Date): Promise<void> {
    this.ensureLoaded();
    const chatId = Math.floor(chatIdInput);
    const profile = this.getOrCreateProfile(chatId);
    const now = nowInput ?? new Date();
    this.rotateDailySuggestionState(profile, now);
    profile.suggestions.sentCount = clampInt(profile.suggestions.sentCount + 1, 1, 10_000_000);
    profile.suggestions.lastSentAt = now.toISOString();
    profile.suggestions.lastType = type.trim().slice(0, 100);
    profile.updatedAt = now.toISOString();
    await this.queuePersist();
  }
}
