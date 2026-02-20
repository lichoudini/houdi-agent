import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

type BootstrapFileName = "AGENTS.md" | "SOUL.md" | "USER.md" | "HEARTBEAT.md" | "MEMORY.md";

const BOOTSTRAP_FILES: BootstrapFileName[] = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "HEARTBEAT.md",
  "MEMORY.md",
];

const DEFAULT_FILE_TEMPLATES: Record<BootstrapFileName, string> = {
  "AGENTS.md": [
    "# AGENTS.md - Houdi Workspace",
    "",
    "## Objetivo",
    "Eres Houdi Agent: asistente personal operativo por Telegram.",
    "",
    "## Rutina por sesión",
    "1. Leer SOUL.md (tono y personalidad).",
    "2. Leer USER.md (preferencias del usuario).",
    "3. Leer MEMORY.md (memoria de largo plazo).",
    "4. Leer memory/YYYY-MM-DD.md (hoy y ayer) si existen.",
    "",
    "## Principios",
    "- Seguridad primero: no ejecutar acciones destructivas sin confirmación explícita.",
    "- No inventar hechos: si falta contexto, decirlo.",
    "- Documentar continuidad en archivos de memoria, no asumir memoria en RAM.",
    "",
    "## Escritura de memoria",
    "- Notas rápidas y contexto diario: memory/YYYY-MM-DD.md",
    "- Preferencias/decisiones durables: MEMORY.md",
  ].join("\n"),
  "SOUL.md": [
    "# SOUL.md - Personalidad",
    "",
    "Eres pragmático, claro y directo.",
    "Prioriza resolver problemas reales sobre dar explicaciones largas.",
    "Si hay riesgo, lo señalas sin dramatizar y propones el siguiente paso concreto.",
    "Hablas español neutral.",
  ].join("\n"),
  "USER.md": [
    "# USER.md - Perfil",
    "",
    "- Nombre: (completar)",
    "- Objetivos principales: (completar)",
    "- Preferencias de comunicación: respuestas breves y accionables",
    "- Restricciones: no ejecutar cambios irreversibles sin aprobación explícita",
  ].join("\n"),
  "HEARTBEAT.md": [
    "# HEARTBEAT.md",
    "",
    "- Revisar estado del servicio",
    "- Verificar tareas pendientes",
    "- Si no hay novedades: responder HEARTBEAT_OK",
  ].join("\n"),
  "MEMORY.md": [
    "# MEMORY.md - Memoria de largo plazo",
    "",
    "Este archivo guarda hechos durables: preferencias, decisiones y acuerdos.",
    "",
    "## Reglas",
    "- No guardar secretos salvo pedido explícito.",
    "- Usar entradas cortas y fechadas.",
  ].join("\n"),
};

export type PromptContextFile = {
  path: string;
  content: string;
  missing: boolean;
  truncated: boolean;
};

export type PromptMemoryHit = {
  path: string;
  line: number;
  snippet: string;
  score: number;
};

export type PromptContextSnapshot = {
  workspaceDir: string;
  contextFiles: PromptContextFile[];
  memoryHits: PromptMemoryHit[];
  generatedAt: string;
};

type BuildPromptContextOptions = {
  chatId?: number;
};

type SearchMemoryOptions = {
  limit?: number;
  chatId?: number;
  maxInjectedChars?: number;
};

type MemoryBackendName = "hybrid" | "scan";

type AgentContextMemoryOptions = {
  workspaceDir: string;
  contextFileMaxChars: number;
  contextTotalMaxChars: number;
  memoryMaxResults: number;
  memorySnippetMaxChars: number;
  memoryMaxInjectedChars?: number;
  memoryBackend?: MemoryBackendName;
};

type ConversationRole = "user" | "assistant";

type AppendConversationTurnParams = {
  chatId: number;
  role: ConversationRole;
  text: string;
  source: string;
  userId?: number;
};

const RECENT_DAILY_CONTEXT_DAYS = 2;
const CONVERSATION_TURN_MAX_CHARS = 1_200;
const CHAT_CONTINUITY_UPDATE_INTERVAL_TURNS = 4;
const CHAT_RECENT_CONTEXT_FILES = 6;
const CHAT_RECENT_CONTEXT_TURNS = 80;
const SEARCH_RECENT_GLOBAL_FILES = 60;
const SEARCH_RECENT_CHAT_FILES = 40;
const SEARCH_TEMPORAL_HALF_LIFE_DAYS = 21;
const MEMORY_MMR_LAMBDA = 0.72;
const MEMORY_MMR_POOL_MULTIPLIER = 4;
const MEMORY_MMR_RESULT_MULTIPLIER = 2;
const DEFAULT_MEMORY_MAX_INJECTED_CHARS = 2200;
const DEFAULT_MEMORY_BACKEND: MemoryBackendName = "hybrid";
const MEMORY_BM25_K1 = 1.2;
const MEMORY_BM25_B = 0.75;
const MEMORY_SEMANTIC_MIN_SCORE = 0.28;
const MEMORY_DATE_PATH_RE = /(?:^|\/)(\d{4})-(\d{2})-(\d{2})\.md$/;
const CHAT_MEMORY_PATH_RE = /(?:^|\/)memory\/chats\/chat-(\d+)\/\d{4}-\d{2}-\d{2}\.md$/i;
const PROMPT_INJECTION_PATTERNS = [
  /ignore (all|any|previous|above|prior) instructions/i,
  /do not follow (the )?(system|developer)/i,
  /system prompt/i,
  /developer message/i,
  /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i,
  /\b(run|execute|call|invoke)\b.{0,40}\b(tool|command)\b/i,
];

const TOPIC_STOP_WORDS = new Set([
  "a",
  "al",
  "algo",
  "ante",
  "con",
  "como",
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
  "es",
  "esa",
  "ese",
  "eso",
  "esta",
  "este",
  "esto",
  "fue",
  "ha",
  "hay",
  "hoy",
  "la",
  "las",
  "le",
  "les",
  "lo",
  "los",
  "mas",
  "me",
  "mi",
  "mis",
  "muy",
  "no",
  "nos",
  "o",
  "para",
  "pero",
  "por",
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
  "ya",
]);

type ParsedLineMetadata = {
  content: string;
  metadata?: Record<string, unknown>;
};

type ConversationExcerpt = {
  role: ConversationRole;
  text: string;
};

type MemorySearchCandidate = PromptMemoryHit & {
  normalizedSnippet: string;
  tokenSet: Set<string>;
};

type IndexedMemoryLine = {
  path: string;
  line: number;
  content: string;
  normalized: string;
  metadata?: Record<string, unknown>;
  ageDays?: number;
  tokens: string[];
  tokenSet: Set<string>;
  tokenFreq: Map<string, number>;
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = " [...truncated]";
  const usable = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, usable)}${marker}`;
}

function truncateWithMarker(text: string, maxChars: number): { value: string; truncated: boolean } {
  if (maxChars <= 0) {
    return { value: "", truncated: text.length > 0 };
  }
  if (text.length <= maxChars) {
    return { value: text, truncated: false };
  }
  const marker = "\n\n[...truncated]";
  const usable = Math.max(0, maxChars - marker.length);
  if (usable <= 0) {
    return { value: text.slice(0, maxChars), truncated: true };
  }
  return {
    value: `${text.slice(0, usable)}${marker}`,
    truncated: true,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateTailWithMarker(text: string, maxChars: number): { value: string; truncated: boolean } {
  if (maxChars <= 0) {
    return { value: "", truncated: text.length > 0 };
  }
  if (text.length <= maxChars) {
    return { value: text, truncated: false };
  }
  const marker = "[...previous content truncated]\n\n";
  const usable = Math.max(0, maxChars - marker.length);
  if (usable <= 0) {
    return { value: text.slice(-maxChars), truncated: true };
  }
  return {
    value: `${marker}${text.slice(-usable)}`,
    truncated: true,
  };
}

function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function stemToken(token: string): string {
  let value = token;
  const suffixes = [
    "mente",
    "aciones",
    "acion",
    "ciones",
    "cion",
    "amientos",
    "amiento",
    "imientos",
    "imiento",
    "idades",
    "idad",
    "adoras",
    "adores",
    "adora",
    "ador",
    "ismos",
    "ismo",
    "istas",
    "ista",
    "ancias",
    "ancia",
    "amente",
    "ando",
    "iendo",
    "ados",
    "adas",
    "idos",
    "idas",
    "ado",
    "ada",
    "ido",
    "ida",
    "es",
    "s",
  ];

  for (const suffix of suffixes) {
    if (value.length <= suffix.length + 2) {
      continue;
    }
    if (value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }

  return value;
}

function tokenizeQuery(query: string): string[] {
  const normalized = normalizeForSearch(query);
  const rawTokens = normalized.match(/[a-z0-9ñü_-]{2,}/g) ?? [];
  const tokens = new Set<string>();
  for (const token of rawTokens) {
    tokens.add(token);
    const stem = stemToken(token);
    if (stem && stem.length >= 3) {
      tokens.add(stem);
    }
  }
  return Array.from(tokens);
}

function looksLikePromptInjection(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function tokenizeSnippetForSimilarity(text: string): Set<string> {
  const normalized = normalizeForSearch(text);
  const tokens = normalized.match(/[a-z0-9ñü_-]{2,}/g) ?? [];
  return new Set(tokens);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const token of smaller) {
    if (larger.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function tokenizeTextForIndex(text: string): string[] {
  const normalized = normalizeForSearch(text);
  const rawTokens = normalized.match(/[a-z0-9ñü_-]{2,}/g) ?? [];
  const tokens: string[] = [];
  for (const token of rawTokens) {
    tokens.push(token);
    const stem = stemToken(token);
    if (stem && stem.length >= 3 && stem !== token) {
      tokens.push(stem);
    }
  }
  return tokens;
}

function tokenFrequency(tokens: string[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return frequency;
}

function buildNgramSet(text: string, n: number = 3): Set<string> {
  const normalized = normalizeForSearch(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return new Set();
  }
  const padded = ` ${normalized} `;
  if (padded.length <= n) {
    return new Set([padded]);
  }
  const grams = new Set<string>();
  for (let i = 0; i <= padded.length - n; i += 1) {
    grams.add(padded.slice(i, i + n));
  }
  return grams;
}

function semanticSimilarityScore(params: {
  queryTokens: Set<string>;
  queryNgrams: Set<string>;
  docTokens: Set<string>;
  docNgrams: Set<string>;
}): number {
  const tokenScore = jaccardSimilarity(params.queryTokens, params.docTokens);
  const ngramScore = jaccardSimilarity(params.queryNgrams, params.docNgrams);
  return tokenScore * 0.65 + ngramScore * 0.35;
}

function computeBm25Score(params: {
  queryTerms: string[];
  docTokenFreq: Map<string, number>;
  docLength: number;
  avgDocLength: number;
  totalDocs: number;
  documentFrequency: Map<string, number>;
}): number {
  if (params.queryTerms.length === 0 || params.totalDocs <= 0) {
    return 0;
  }
  const avgLength = params.avgDocLength > 0 ? params.avgDocLength : 1;
  const docLength = Math.max(1, params.docLength);
  let score = 0;
  for (const term of params.queryTerms) {
    const tf = params.docTokenFreq.get(term) ?? 0;
    if (tf <= 0) {
      continue;
    }
    const df = params.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (params.totalDocs - df + 0.5) / (df + 0.5));
    const numerator = tf * (MEMORY_BM25_K1 + 1);
    const denominator = tf + MEMORY_BM25_K1 * (1 - MEMORY_BM25_B + MEMORY_BM25_B * (docLength / avgLength));
    score += idf * (denominator > 0 ? numerator / denominator : 0);
  }
  return score;
}

function rerankMemoryHitsByDiversity(
  sortedHits: MemorySearchCandidate[],
  limit: number,
): MemorySearchCandidate[] {
  if (sortedHits.length <= 1 || limit <= 1) {
    return sortedHits;
  }

  const poolLimit = Math.min(
    sortedHits.length,
    Math.max(limit, Math.floor(limit * MEMORY_MMR_POOL_MULTIPLIER)),
  );
  const selectionTarget = Math.min(
    poolLimit,
    Math.max(limit, Math.floor(limit * MEMORY_MMR_RESULT_MULTIPLIER)),
  );
  const pool = sortedHits.slice(0, poolLimit);
  const remaining = new Set<number>(pool.map((_, idx) => idx));
  const selectedIndices: number[] = [];

  const maxScore = Math.max(...pool.map((item) => item.score));
  const minScore = Math.min(...pool.map((item) => item.score));
  const scoreRange = maxScore - minScore;
  const normalizeScore = (score: number): number => {
    if (!Number.isFinite(score)) {
      return 0;
    }
    if (scoreRange <= 0) {
      return 1;
    }
    return (score - minScore) / scoreRange;
  };

  while (selectedIndices.length < selectionTarget && remaining.size > 0) {
    let bestIndex: number | null = null;
    let bestMmrScore = Number.NEGATIVE_INFINITY;
    let bestRawScore = Number.NEGATIVE_INFINITY;

    for (const candidateIndex of remaining) {
      const candidate = pool[candidateIndex];
      if (!candidate) {
        continue;
      }
      const relevance = normalizeScore(candidate.score);
      let maxSimilarity = 0;
      for (const selectedIndex of selectedIndices) {
        const selected = pool[selectedIndex];
        if (!selected) {
          continue;
        }
        const similarity = jaccardSimilarity(candidate.tokenSet, selected.tokenSet);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
        }
      }
      const mmrScore = MEMORY_MMR_LAMBDA * relevance - (1 - MEMORY_MMR_LAMBDA) * maxSimilarity;
      if (
        mmrScore > bestMmrScore ||
        (mmrScore === bestMmrScore && candidate.score > bestRawScore)
      ) {
        bestIndex = candidateIndex;
        bestMmrScore = mmrScore;
        bestRawScore = candidate.score;
      }
    }

    if (bestIndex === null) {
      break;
    }
    selectedIndices.push(bestIndex);
    remaining.delete(bestIndex);
  }

  const reorderedPool: MemorySearchCandidate[] = [
    ...selectedIndices.map((idx) => pool[idx]).filter((item): item is MemorySearchCandidate => Boolean(item)),
    ...[...remaining]
      .map((idx) => pool[idx])
      .filter((item): item is MemorySearchCandidate => Boolean(item))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line),
  ];

  return [...reorderedPool, ...sortedHits.slice(poolLimit)];
}

function applyMemoryInjectedCharsBudget(
  hits: MemorySearchCandidate[],
  budgetInput?: number,
): MemorySearchCandidate[] {
  if (typeof budgetInput !== "number" || !Number.isFinite(budgetInput) || budgetInput <= 0) {
    return hits;
  }

  let remaining = Math.floor(budgetInput);
  const limited: MemorySearchCandidate[] = [];
  for (const hit of hits) {
    if (remaining <= 0) {
      break;
    }
    const snippet = hit.snippet ?? "";
    if (snippet.length <= remaining) {
      limited.push(hit);
      remaining -= snippet.length;
      continue;
    }
    const truncated = truncateWithMarker(snippet, remaining);
    if (!truncated.value.trim()) {
      break;
    }
    limited.push({
      ...hit,
      snippet: truncated.value,
      normalizedSnippet: normalizeForSearch(truncated.value),
      tokenSet: tokenizeSnippetForSimilarity(truncated.value),
    });
    break;
  }
  return limited;
}

function splitLineMetadata(line: string): ParsedLineMetadata {
  const marker = "| meta=";
  const idx = line.lastIndexOf(marker);
  if (idx < 0) {
    return { content: line.trim() };
  }

  const content = line.slice(0, idx).trim();
  const rawMeta = line.slice(idx + marker.length).trim();
  if (!rawMeta) {
    return { content };
  }
  try {
    const parsed = JSON.parse(rawMeta);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { content, metadata: parsed as Record<string, unknown> };
    }
  } catch {
    // ignore malformed metadata and continue with stripped line
  }
  return { content };
}

function parseMemoryDateFromPath(relPath: string): Date | null {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const match = MEMORY_DATE_PATH_RE.exec(normalized);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function computeTemporalScoreMultiplier(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) {
    return 1;
  }
  const decay = Math.exp(-Math.log(2) * (ageDays / SEARCH_TEMPORAL_HALF_LIFE_DAYS));
  return 0.65 + decay * 0.35;
}

function extractMetadataChatId(metadata?: Record<string, unknown>): number | null {
  if (!metadata) {
    return null;
  }
  const raw = metadata.chatId;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function extractChatIdFromPath(relPath: string): number | null {
  const normalized = relPath.replace(/\\/g, "/");
  const match = CHAT_MEMORY_PATH_RE.exec(normalized);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function scoreLine(params: {
  lineContent: string;
  rawQuery: string;
  terms: string[];
  relPath: string;
  chatId?: number;
  metadata?: Record<string, unknown>;
  ageDays?: number;
}): number {
  const normalizedLine = normalizeForSearch(params.lineContent);
  const normalizedQuery = normalizeForSearch(params.rawQuery.trim());
  if (!normalizedLine || !normalizedQuery) {
    return 0;
  }

  let score = 0;
  if (normalizedQuery.length >= 3 && normalizedLine.includes(normalizedQuery)) {
    score += 8;
  }

  let matchedTerms = 0;
  for (const term of params.terms) {
    if (!term || term.length < 2) {
      continue;
    }
    if (!normalizedLine.includes(term)) {
      continue;
    }
    matchedTerms += 1;
    score += term.length >= 6 ? 1.3 : 1;
  }
  if (matchedTerms === 0 && score === 0) {
    return 0;
  }
  if (matchedTerms > 0 && matchedTerms === params.terms.length) {
    score += 2.5;
  }

  const normalizedPath = params.relPath.toLowerCase();
  if (normalizedPath.endsWith("continuity.md")) {
    score += 3;
  }
  if (normalizedPath === "memory.md") {
    score += 1;
  }

  if (typeof params.chatId === "number" && Number.isFinite(params.chatId)) {
    const metadataChatId = extractMetadataChatId(params.metadata);
    const pathChatId = extractChatIdFromPath(params.relPath);
    if (metadataChatId === params.chatId) {
      score += 4;
    } else if (pathChatId === params.chatId) {
      score += 3.2;
    }
  }

  if (typeof params.ageDays === "number" && Number.isFinite(params.ageDays) && params.ageDays >= 0) {
    score *= computeTemporalScoreMultiplier(params.ageDays);
  }

  return score;
}

function parseConversationLine(line: string): ConversationExcerpt | null {
  const parsed = splitLineMetadata(line);
  if (!parsed.content) {
    return null;
  }

  const roleTextMatch = parsed.content.match(/^\-\s*\[(\d{2}:\d{2}:\d{2})\]\s*(USER|ASSISTANT):\s*(.+)$/i);
  if (roleTextMatch) {
    const role = (roleTextMatch[2] ?? "").toLowerCase() === "assistant" ? "assistant" : "user";
    const text = (roleTextMatch[3] ?? "").trim();
    if (!text) {
      return null;
    }
    return { role, text };
  }

  const roleFromMeta =
    typeof parsed.metadata?.role === "string" && ["user", "assistant"].includes(parsed.metadata.role)
      ? (parsed.metadata.role as ConversationRole)
      : null;
  if (!roleFromMeta) {
    return null;
  }

  const rolePrefix = roleFromMeta === "assistant" ? "ASSISTANT:" : "USER:";
  const idx = parsed.content.toUpperCase().indexOf(rolePrefix);
  if (idx < 0) {
    return null;
  }
  const text = parsed.content.slice(idx + rolePrefix.length).trim();
  if (!text) {
    return null;
  }
  return { role: roleFromMeta, text };
}

function cleanContinuityLine(text: string, maxChars: number = 220): string {
  return truncateInline(text.replace(/\s+/g, " ").trim(), maxChars);
}

function ensureSafeRelativePath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").trim();
  if (!normalized) {
    throw new Error("Path vacío");
  }
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Path inválido");
  }
  return normalized;
}

export class AgentContextMemory {
  private readonly workspaceDir: string;
  private readonly contextFileMaxChars: number;
  private readonly contextTotalMaxChars: number;
  private readonly memoryMaxResults: number;
  private readonly memorySnippetMaxChars: number;
  private readonly memoryMaxInjectedChars: number;
  private readonly preferredBackend: MemoryBackendName;
  private readonly chatTurnCounters = new Map<number, number>();
  private lastBackendUsed: MemoryBackendName = DEFAULT_MEMORY_BACKEND;
  private backendFallbackCount = 0;
  private lastFallbackError?: string;

  constructor(options: AgentContextMemoryOptions) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.contextFileMaxChars = clampInt(options.contextFileMaxChars, 300, 20_000);
    this.contextTotalMaxChars = clampInt(options.contextTotalMaxChars, 1_000, 150_000);
    this.memoryMaxResults = clampInt(options.memoryMaxResults, 1, 20);
    this.memorySnippetMaxChars = clampInt(options.memorySnippetMaxChars, 80, 2_000);
    this.memoryMaxInjectedChars = clampInt(
      options.memoryMaxInjectedChars ?? DEFAULT_MEMORY_MAX_INJECTED_CHARS,
      300,
      30_000,
    );
    this.preferredBackend = options.memoryBackend ?? DEFAULT_MEMORY_BACKEND;
    this.lastBackendUsed = this.preferredBackend;
  }

  async ensureWorkspace(): Promise<void> {
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await fs.mkdir(this.getMemoryDir(), { recursive: true });
    await fs.mkdir(this.getChatsMemoryDir(), { recursive: true });

    for (const fileName of BOOTSTRAP_FILES) {
      const filePath = path.join(this.workspaceDir, fileName);
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, `${DEFAULT_FILE_TEMPLATES[fileName]}\n`, "utf8");
      }
    }
  }

  async buildPromptContext(query: string, options?: BuildPromptContextOptions): Promise<PromptContextSnapshot> {
    const [contextFiles, memoryHits] = await Promise.all([
      this.loadContextFiles(options?.chatId).catch(() => []),
      this.searchMemoryWithContext(query, {
        chatId: options?.chatId,
        limit: this.memoryMaxResults,
        maxInjectedChars: this.memoryMaxInjectedChars,
      }).catch(() => []),
    ]);
    return {
      workspaceDir: this.workspaceDir,
      contextFiles,
      memoryHits,
      generatedAt: new Date().toISOString(),
    };
  }

  async appendDailyNote(note: string, metadata?: Record<string, unknown>): Promise<{ relPath: string }> {
    const text = note.trim();
    if (!text) {
      throw new Error("Nota vacía");
    }
    const datePart = new Date().toISOString().slice(0, 10);
    const relPath = path.join("memory", `${datePart}.md`);
    await this.appendNoteToRelativePath(relPath, text, metadata);
    return { relPath: relPath.replace(/\\/g, "/") };
  }

  async upsertLongTermFact(params: {
    key: string;
    value: string;
    source?: string;
    chatId?: number;
    userId?: number;
  }): Promise<{ path: string; key: string; value: string; updated: boolean }> {
    const normalizedKey = params.key
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
    const normalizedValue = truncateInline(params.value.replace(/\s+/g, " ").trim(), 180);
    if (!normalizedKey || !normalizedValue) {
      throw new Error("Fact key/value inválidos");
    }

    const relPath = "MEMORY.md";
    const fullPath = path.join(this.workspaceDir, relPath);
    await fs.mkdir(this.workspaceDir, { recursive: true });

    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      content = `${DEFAULT_FILE_TEMPLATES["MEMORY.md"]}\n`;
    }

    const sectionTitle = "## Perfil del usuario (auto)";
    const lines = content.split(/\r?\n/);
    let sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === sectionTitle.toLowerCase());
    if (sectionStart < 0) {
      if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") {
        lines.push("");
      }
      lines.push(sectionTitle);
      lines.push("");
      sectionStart = lines.length - 2;
    }

    let sectionEnd = lines.length;
    for (let idx = sectionStart + 1; idx < lines.length; idx += 1) {
      if (/^##\s+/.test((lines[idx] ?? "").trim())) {
        sectionEnd = idx;
        break;
      }
    }

    const timestamp = new Date().toISOString();
    const metaParts = [`updated=${timestamp}`];
    if (params.source?.trim()) {
      metaParts.push(`source=${params.source.trim().replace(/\s+/g, "_")}`);
    }
    if (typeof params.chatId === "number" && Number.isFinite(params.chatId)) {
      metaParts.push(`chat=${Math.floor(params.chatId)}`);
    }
    if (typeof params.userId === "number" && Number.isFinite(params.userId)) {
      metaParts.push(`user=${Math.floor(params.userId)}`);
    }
    const newLine = `- ${normalizedKey}: ${normalizedValue} | ${metaParts.join(" | ")}`;
    const keyLinePattern = new RegExp(`^\\s*-\\s*${escapeRegExp(normalizedKey)}\\s*:`, "i");

    let updated = false;
    for (let idx = sectionStart + 1; idx < sectionEnd; idx += 1) {
      const current = lines[idx] ?? "";
      if (!keyLinePattern.test(current.trim())) {
        continue;
      }
      lines[idx] = newLine;
      updated = true;
      break;
    }

    if (!updated) {
      let insertAt = sectionEnd;
      while (insertAt > sectionStart + 1 && !(lines[insertAt - 1] ?? "").trim()) {
        insertAt -= 1;
      }
      lines.splice(insertAt, 0, newLine);
    }

    await fs.writeFile(fullPath, `${lines.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
    return {
      path: relPath,
      key: normalizedKey,
      value: normalizedValue,
      updated,
    };
  }

  async appendConversationTurn(params: AppendConversationTurnParams): Promise<{ relPath: string }> {
    const normalizedText = params.text.replace(/\s+/g, " ").trim();
    if (!normalizedText) {
      throw new Error("Texto vacío");
    }
    const roleTag = params.role === "user" ? "USER" : "ASSISTANT";
    const compactText = truncateInline(normalizedText, CONVERSATION_TURN_MAX_CHARS);
    const metadata: Record<string, unknown> = {
      source: params.source,
      role: params.role,
      chatId: params.chatId,
    };
    if (typeof params.userId === "number" && Number.isFinite(params.userId) && params.userId > 0) {
      metadata.userId = Math.floor(params.userId);
    }

    const dailyNote = await this.appendDailyNote(`${roleTag}: ${compactText}`, metadata);
    await this.appendChatConversationTurn(params.chatId, `${roleTag}: ${compactText}`, metadata);
    await this.refreshChatContinuityIfNeeded(params.chatId);
    return dailyNote;
  }

  async flushBeforeReasoning(chatIdInput?: number): Promise<void> {
    const chatId = Number.isFinite(chatIdInput) ? Math.floor(chatIdInput ?? 0) : 0;
    if (chatId <= 0) {
      return;
    }
    await this.rebuildChatContinuity(chatId);
  }

  async searchMemory(query: string, overrideLimit?: number): Promise<PromptMemoryHit[]> {
    return this.searchMemoryInternal(query, {
      limit: overrideLimit ?? this.memoryMaxResults,
    });
  }

  async searchMemoryWithContext(query: string, options?: SearchMemoryOptions): Promise<PromptMemoryHit[]> {
    return this.searchMemoryInternal(query, {
      limit: options?.limit ?? this.memoryMaxResults,
      chatId: options?.chatId,
      maxInjectedChars: options?.maxInjectedChars,
    });
  }

  private async searchMemoryInternal(query: string, options: SearchMemoryOptions): Promise<PromptMemoryHit[]> {
    const raw = query.trim();
    if (!raw) {
      return [];
    }
    const limit = clampInt(options.limit ?? this.memoryMaxResults, 1, 50);
    const backends: MemoryBackendName[] =
      this.preferredBackend === "hybrid" ? ["hybrid", "scan"] : ["scan"];

    let lastError: string | null = null;
    for (const backend of backends) {
      try {
        const hits =
          backend === "hybrid"
            ? await this.searchMemoryHybrid(raw, options)
            : await this.searchMemoryScan(raw, options);
        this.lastBackendUsed = backend;
        if (backend !== this.preferredBackend) {
          this.backendFallbackCount += 1;
          this.lastFallbackError = lastError ?? `fallback desde ${this.preferredBackend}`;
        } else {
          this.lastFallbackError = undefined;
        }
        return this.finalizeMemoryHits(hits, limit, options.maxInjectedChars);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    this.lastBackendUsed = "scan";
    if (lastError) {
      this.backendFallbackCount += 1;
      this.lastFallbackError = lastError;
    }
    return [];
  }

  private finalizeMemoryHits(
    hits: MemorySearchCandidate[],
    limit: number,
    maxInjectedChars?: number,
  ): PromptMemoryHit[] {
    if (hits.length === 0) {
      return [];
    }

    const deduped = new Map<string, MemorySearchCandidate>();
    for (const hit of hits) {
      const key = `${hit.path}#L${hit.line}:${hit.normalizedSnippet}`;
      const existing = deduped.get(key);
      if (!existing || hit.score > existing.score) {
        deduped.set(key, hit);
      }
    }

    const sorted = [...deduped.values()].sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line,
    );
    const reranked = rerankMemoryHitsByDiversity(sorted, limit);
    const budgeted = applyMemoryInjectedCharsBudget(reranked, maxInjectedChars);
    return budgeted.slice(0, limit).map((entry) => ({
      path: entry.path,
      line: entry.line,
      snippet: entry.snippet,
      score: entry.score,
    }));
  }

  private async searchMemoryScan(query: string, options: SearchMemoryOptions): Promise<MemorySearchCandidate[]> {
    const terms = tokenizeQuery(query);
    const lines = await this.collectIndexedMemoryLines(options.chatId);
    const hits: MemorySearchCandidate[] = [];

    for (const line of lines) {
      const score = scoreLine({
        lineContent: line.content,
        rawQuery: query,
        terms,
        relPath: line.path,
        chatId: options.chatId,
        metadata: line.metadata,
        ageDays: line.ageDays,
      });
      if (score <= 0) {
        continue;
      }
      const truncated = truncateWithMarker(line.content, this.memorySnippetMaxChars);
      hits.push({
        path: line.path,
        line: line.line,
        snippet: truncated.value,
        score,
        normalizedSnippet: normalizeForSearch(truncated.value),
        tokenSet: tokenizeSnippetForSimilarity(truncated.value),
      });
    }

    return hits;
  }

  private async searchMemoryHybrid(query: string, options: SearchMemoryOptions): Promise<MemorySearchCandidate[]> {
    const lines = await this.collectIndexedMemoryLines(options.chatId);
    if (lines.length === 0) {
      return [];
    }

    const terms = tokenizeQuery(query);
    const queryTokenSet = new Set(terms);
    const queryNgrams = buildNgramSet(query);
    const totalDocs = lines.length;
    const averageDocLength =
      lines.reduce((acc, line) => acc + Math.max(1, line.tokens.length), 0) / Math.max(1, lines.length);
    const documentFrequency = new Map<string, number>();

    for (const term of terms) {
      let count = 0;
      for (const line of lines) {
        if (line.tokenSet.has(term)) {
          count += 1;
        }
      }
      documentFrequency.set(term, count);
    }

    const hits: MemorySearchCandidate[] = [];
    for (const line of lines) {
      const baseScore = scoreLine({
        lineContent: line.content,
        rawQuery: query,
        terms,
        relPath: line.path,
        chatId: options.chatId,
        metadata: line.metadata,
        ageDays: line.ageDays,
      });
      const bm25Score = computeBm25Score({
        queryTerms: terms,
        docTokenFreq: line.tokenFreq,
        docLength: Math.max(1, line.tokens.length),
        avgDocLength: averageDocLength,
        totalDocs,
        documentFrequency,
      });
      const semanticScore = semanticSimilarityScore({
        queryTokens: queryTokenSet,
        queryNgrams,
        docTokens: line.tokenSet,
        docNgrams: buildNgramSet(line.normalized),
      });
      const semanticBoost = semanticScore >= MEMORY_SEMANTIC_MIN_SCORE ? semanticScore * 3.2 : 0;
      const hybridScore = baseScore + bm25Score * 3 + semanticBoost;

      if (hybridScore <= 0) {
        continue;
      }
      if (baseScore <= 0 && bm25Score <= 0 && semanticScore < MEMORY_SEMANTIC_MIN_SCORE) {
        continue;
      }

      const truncated = truncateWithMarker(line.content, this.memorySnippetMaxChars);
      hits.push({
        path: line.path,
        line: line.line,
        snippet: truncated.value,
        score: hybridScore,
        normalizedSnippet: normalizeForSearch(truncated.value),
        tokenSet: tokenizeSnippetForSimilarity(truncated.value),
      });
    }

    return hits;
  }

  private async collectIndexedMemoryLines(chatId?: number): Promise<IndexedMemoryLine[]> {
    const files = await this.getSearchFilePaths({ chatId });
    const nowMs = Date.now();
    const collected: IndexedMemoryLine[] = [];

    for (const filePath of files) {
      let content = "";
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const relPath = path.relative(this.workspaceDir, filePath).replace(/\\/g, "/");
      let ageDays: number | undefined;
      const fromPathDate = parseMemoryDateFromPath(relPath);
      if (fromPathDate) {
        ageDays = Math.max(0, nowMs - fromPathDate.getTime()) / (24 * 60 * 60 * 1000);
      } else {
        try {
          const stat = await fs.stat(filePath);
          ageDays = Math.max(0, nowMs - stat.mtime.getTime()) / (24 * 60 * 60 * 1000);
        } catch {
          ageDays = undefined;
        }
      }

      const fileLines = content.split(/\r?\n/);
      for (let idx = 0; idx < fileLines.length; idx += 1) {
        const rawLine = fileLines[idx]?.trim() ?? "";
        if (!rawLine) {
          continue;
        }
        const parsed = splitLineMetadata(rawLine);
        if (!parsed.content || looksLikePromptInjection(parsed.content)) {
          continue;
        }
        const tokens = tokenizeTextForIndex(parsed.content);
        const tokenSet = new Set(tokens);
        const tokenFreq = tokenFrequency(tokens);
        collected.push({
          path: relPath,
          line: idx + 1,
          content: parsed.content,
          normalized: normalizeForSearch(parsed.content),
          metadata: parsed.metadata,
          ageDays,
          tokens,
          tokenSet,
          tokenFreq,
        });
      }
    }

    return collected;
  }

  async readMemoryFile(
    relPathInput: string,
    fromLineInput?: number,
    linesInput?: number,
  ): Promise<{ path: string; from: number; to: number; text: string }> {
    const relPath = ensureSafeRelativePath(relPathInput);
    const fullPath = path.resolve(this.workspaceDir, relPath);
    if (!fullPath.startsWith(this.workspaceDir + path.sep) && fullPath !== this.workspaceDir) {
      throw new Error("Path fuera del workspace");
    }

    const normalized = relPath.toLowerCase();
    if (normalized !== "memory.md" && !normalized.startsWith("memory/")) {
      throw new Error("Solo se permite leer MEMORY.md o memory/*.md");
    }

    const from = clampInt(fromLineInput ?? 1, 1, 1_000_000);
    const linesCount = clampInt(linesInput ?? 40, 1, 400);

    const content = await fs.readFile(fullPath, "utf8");
    const allLines = content.split(/\r?\n/);
    const startIdx = from - 1;
    const endIdxExclusive = Math.min(allLines.length, startIdx + linesCount);
    const sliced = allLines.slice(startIdx, endIdxExclusive).join("\n");

    return {
      path: relPath,
      from,
      to: endIdxExclusive,
      text: sliced,
    };
  }

  async getStatus(): Promise<{
    workspaceDir: string;
    longTermMemoryExists: boolean;
    memoryFilesCount: number;
    todayMemoryFile: string;
    backendPreferred: MemoryBackendName;
    backendLastUsed: MemoryBackendName;
    backendFallbackCount: number;
    backendLastFallbackError?: string;
  }> {
    const todayMemoryFile = path.join("memory", `${new Date().toISOString().slice(0, 10)}.md`).replace(
      /\\/g,
      "/",
    );
    const longTermPath = path.join(this.workspaceDir, "MEMORY.md");

    let longTermMemoryExists = false;
    try {
      await fs.access(longTermPath);
      longTermMemoryExists = true;
    } catch {
      longTermMemoryExists = false;
    }

    let memoryFilesCount = 0;
    try {
      memoryFilesCount = await this.countMarkdownFilesRecursive(this.getMemoryDir(), 3);
    } catch {
      memoryFilesCount = 0;
    }

    return {
      workspaceDir: this.workspaceDir,
      longTermMemoryExists,
      memoryFilesCount,
      todayMemoryFile,
      backendPreferred: this.preferredBackend,
      backendLastUsed: this.lastBackendUsed,
      backendFallbackCount: this.backendFallbackCount,
      ...(this.lastFallbackError ? { backendLastFallbackError: this.lastFallbackError } : {}),
    };
  }

  private async loadContextFiles(chatId?: number): Promise<PromptContextFile[]> {
    let remaining = this.contextTotalMaxChars;
    const files: PromptContextFile[] = [];
    const dailyFiles = await this.getRecentDailyContextRelPaths();
    const hasChatId = typeof chatId === "number" && Number.isFinite(chatId) && chatId > 0;
    const chatDailyFiles = hasChatId ? await this.getRecentChatContextRelPaths(chatId, CHAT_RECENT_CONTEXT_FILES) : [];
    const chatContinuityRelPath = hasChatId ? this.getChatContinuityRelPath(chatId) : null;

    const coreFiles: BootstrapFileName[] = ["AGENTS.md", "SOUL.md", "USER.md", "HEARTBEAT.md"];
    const dailyReserve = dailyFiles.length > 0 ? Math.min(3200, Math.floor(this.contextTotalMaxChars * 0.25)) : 0;
    const chatReserve =
      chatDailyFiles.length > 0 || chatContinuityRelPath
        ? Math.min(5000, Math.floor(this.contextTotalMaxChars * 0.32))
        : 0;
    const memoryReserve = 1200;

    for (const fileName of coreFiles) {
      const filePath = path.join(this.workspaceDir, fileName);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const budgetCap = Math.max(0, remaining - dailyReserve - chatReserve - memoryReserve);
        const budget = Math.max(0, Math.min(this.contextFileMaxChars, budgetCap));
        const truncated = truncateWithMarker(raw.trim(), budget);
        files.push({
          path: fileName,
          content: truncated.value,
          missing: false,
          truncated: truncated.truncated,
        });
        remaining = Math.max(0, remaining - truncated.value.length);
      } catch {
        files.push({
          path: fileName,
          content: "(missing)",
          missing: true,
          truncated: false,
        });
      }
    }

    const memoryPath = path.join(this.workspaceDir, "MEMORY.md");
    try {
      const raw = await fs.readFile(memoryPath, "utf8");
      const budget = Math.max(0, Math.min(this.contextFileMaxChars, remaining - dailyReserve - chatReserve));
      const truncated = truncateWithMarker(raw.trim(), budget);
      files.push({
        path: "MEMORY.md",
        content: truncated.value,
        missing: false,
        truncated: truncated.truncated,
      });
      remaining = Math.max(0, remaining - truncated.value.length);
    } catch {
      files.push({
        path: "MEMORY.md",
        content: "(missing)",
        missing: true,
        truncated: false,
      });
    }

    if (chatContinuityRelPath) {
      const continuityPath = path.join(this.workspaceDir, chatContinuityRelPath);
      try {
        const raw = await fs.readFile(continuityPath, "utf8");
        const budget = Math.max(0, Math.min(this.contextFileMaxChars, remaining - dailyReserve));
        const truncated = truncateTailWithMarker(raw.trim(), budget);
        files.push({
          path: chatContinuityRelPath,
          content: truncated.value,
          missing: false,
          truncated: truncated.truncated,
        });
        remaining = Math.max(0, remaining - truncated.value.length);
      } catch {
        // Continuity snapshot is optional; ignore if missing.
      }
    }

    for (const relPath of chatDailyFiles) {
      const filePath = path.join(this.workspaceDir, relPath);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const budget = Math.max(0, Math.min(this.contextFileMaxChars, remaining - dailyReserve));
        const truncated = truncateTailWithMarker(raw.trim(), budget);
        files.push({
          path: relPath,
          content: truncated.value,
          missing: false,
          truncated: truncated.truncated,
        });
        remaining = Math.max(0, remaining - truncated.value.length);
      } catch {
        // ignore transient read errors for chat memory files
      }
    }

    for (const relPath of dailyFiles) {
      const filePath = path.join(this.workspaceDir, relPath);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const budget = Math.max(0, Math.min(this.contextFileMaxChars, remaining));
        const truncated = truncateTailWithMarker(raw.trim(), budget);
        files.push({
          path: relPath,
          content: truncated.value,
          missing: false,
          truncated: truncated.truncated,
        });
        remaining = Math.max(0, remaining - truncated.value.length);
      } catch {
        // ignore transient read errors for daily files
      }
    }

    return files;
  }

  private getMemoryDir(): string {
    return path.join(this.workspaceDir, "memory");
  }

  private getChatsMemoryDir(): string {
    return path.join(this.getMemoryDir(), "chats");
  }

  private getChatMemoryDir(chatId: number): string {
    return path.join(this.getChatsMemoryDir(), `chat-${chatId}`);
  }

  private getChatContinuityRelPath(chatId: number): string {
    return path.join("memory", "chats", `chat-${chatId}`, "CONTINUITY.md").replace(/\\/g, "/");
  }

  private getChatDailyRelPath(chatId: number, date: Date): string {
    return path
      .join("memory", "chats", `chat-${chatId}`, `${date.toISOString().slice(0, 10)}.md`)
      .replace(/\\/g, "/");
  }

  private async appendNoteToRelativePath(
    relPathInput: string,
    note: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const relPath = relPathInput.replace(/\\/g, "/");
    const fullPath = path.join(this.workspaceDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    const now = new Date();
    const timePart = now.toISOString().slice(11, 19);
    let extra = "";
    if (metadata && Object.keys(metadata).length > 0) {
      extra = ` | meta=${JSON.stringify(metadata)}`;
    }
    await fs.appendFile(fullPath, `- [${timePart}] ${note}${extra}\n`, "utf8");
  }

  private async appendChatConversationTurn(
    chatIdInput: number,
    note: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const chatId = Number.isFinite(chatIdInput) ? Math.floor(chatIdInput) : 0;
    if (chatId <= 0) {
      return;
    }
    const relPath = this.getChatDailyRelPath(chatId, new Date());
    await this.appendNoteToRelativePath(relPath, note, metadata);
  }

  private async refreshChatContinuityIfNeeded(chatIdInput: number): Promise<void> {
    const chatId = Number.isFinite(chatIdInput) ? Math.floor(chatIdInput) : 0;
    if (chatId <= 0) {
      return;
    }

    const nextCount = (this.chatTurnCounters.get(chatId) ?? 0) + 1;
    this.chatTurnCounters.set(chatId, nextCount);

    const continuityPath = path.join(this.workspaceDir, this.getChatContinuityRelPath(chatId));
    const continuityExists = await this.pathExists(continuityPath);
    if (continuityExists && nextCount % CHAT_CONTINUITY_UPDATE_INTERVAL_TURNS !== 0) {
      return;
    }

    await this.rebuildChatContinuity(chatId);
  }

  private async rebuildChatContinuity(chatId: number): Promise<void> {
    const recentExcerpts = await this.collectRecentChatExcerpts(chatId, CHAT_RECENT_CONTEXT_TURNS);
    if (recentExcerpts.length === 0) {
      return;
    }

    const userTexts = recentExcerpts.filter((entry) => entry.role === "user").map((entry) => entry.text);
    const assistantTexts = recentExcerpts
      .filter((entry) => entry.role === "assistant")
      .map((entry) => entry.text);

    const lastUser = userTexts.at(-1);
    const lastAssistant = assistantTexts.at(-1);
    const topics = this.collectTopicKeywords(userTexts);
    const preferences = this.collectPreferenceHints(userTexts);
    const openLoops = this.collectOpenLoops(recentExcerpts.map((entry) => entry.text));
    const recentTurns = recentExcerpts.slice(-10);

    const lines: string[] = [
      `# CONTINUITY.md - chat-${chatId}`,
      "",
      `Actualizado: ${new Date().toISOString()}`,
      "",
      "## Snapshot",
      `- Turnos considerados: ${recentExcerpts.length}`,
      `- Último usuario: ${lastUser ? cleanContinuityLine(lastUser, 180) : "(sin dato)"}`,
      `- Último asistente: ${lastAssistant ? cleanContinuityLine(lastAssistant, 180) : "(sin dato)"}`,
      "",
      "## Temas Activos",
    ];

    if (topics.length === 0) {
      lines.push("- (sin temas detectados)");
    } else {
      lines.push(...topics.map((topic) => `- ${topic}`));
    }

    lines.push("", "## Preferencias del Usuario (heurística)");
    if (preferences.length === 0) {
      lines.push("- (sin preferencias explícitas recientes)");
    } else {
      lines.push(...preferences.map((item) => `- ${item}`));
    }

    lines.push("", "## Pendientes Abiertos (heurística)");
    if (openLoops.length === 0) {
      lines.push("- (sin pendientes detectados)");
    } else {
      lines.push(...openLoops.map((item) => `- ${item}`));
    }

    lines.push("", "## Últimos Intercambios");
    for (const entry of recentTurns) {
      const roleLabel = entry.role === "assistant" ? "ASSISTANT" : "USER";
      lines.push(`- ${roleLabel}: ${cleanContinuityLine(entry.text, 220)}`);
    }

    const relPath = this.getChatContinuityRelPath(chatId);
    const fullPath = path.join(this.workspaceDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `${lines.join("\n")}\n`, "utf8");
  }

  private async collectRecentChatExcerpts(chatId: number, maxTurns: number): Promise<ConversationExcerpt[]> {
    const relPaths = await this.getRecentChatContextRelPaths(chatId, CHAT_RECENT_CONTEXT_FILES);
    if (relPaths.length === 0) {
      return [];
    }

    const excerpts: ConversationExcerpt[] = [];
    for (const relPath of [...relPaths].reverse()) {
      const fullPath = path.join(this.workspaceDir, relPath);
      let content = "";
      try {
        content = await fs.readFile(fullPath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const parsed = parseConversationLine(line);
        if (!parsed) {
          continue;
        }
        excerpts.push(parsed);
      }
    }

    if (excerpts.length <= maxTurns) {
      return excerpts;
    }
    return excerpts.slice(-maxTurns);
  }

  private collectTopicKeywords(userMessages: string[]): string[] {
    const frequency = new Map<string, number>();
    for (const message of userMessages) {
      const tokens = tokenizeQuery(message);
      for (const token of tokens) {
        if (token.length < 3) {
          continue;
        }
        if (TOPIC_STOP_WORDS.has(token)) {
          continue;
        }
        if (/^\d+$/.test(token)) {
          continue;
        }
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    }
    return [...frequency.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([token, count]) => `${token} (${count})`);
  }

  private collectPreferenceHints(userMessages: string[]): string[] {
    const preferencePattern =
      /\b(prefiero|preferiria|me gusta|no me gusta|evita|no quiero|siempre|nunca|responde|por favor evita)\b/i;
    const unique = new Set<string>();
    for (const message of userMessages) {
      if (!preferencePattern.test(message)) {
        continue;
      }
      unique.add(cleanContinuityLine(message, 180));
      if (unique.size >= 6) {
        break;
      }
    }
    return [...unique];
  }

  private collectOpenLoops(messages: string[]): string[] {
    const loopPattern =
      /\b(pendiente|falta|resta|despues|después|luego|siguiente|proximo|próximo|recorda|recordá|recordar|revisar|implementar|configurar|arreglar|resolver|continuar)\b/i;
    const unique = new Set<string>();
    for (const message of messages.reverse()) {
      if (!loopPattern.test(message)) {
        continue;
      }
      unique.add(cleanContinuityLine(message, 180));
      if (unique.size >= 6) {
        break;
      }
    }
    return [...unique];
  }

  private async getRecentDailyContextRelPaths(): Promise<string[]> {
    const relPaths: string[] = [];
    for (let dayOffset = 0; dayOffset < RECENT_DAILY_CONTEXT_DAYS; dayOffset += 1) {
      const date = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000);
      const relPath = path.join("memory", `${date.toISOString().slice(0, 10)}.md`).replace(/\\/g, "/");
      const fullPath = path.join(this.workspaceDir, relPath);
      try {
        await fs.access(fullPath);
        relPaths.push(relPath);
      } catch {
        // file not found for that day
      }
    }
    return relPaths;
  }

  private async getRecentChatContextRelPaths(chatId: number, maxFiles: number): Promise<string[]> {
    if (!Number.isFinite(chatId) || chatId <= 0) {
      return [];
    }
    const dir = this.getChatMemoryDir(Math.floor(chatId));
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse()
        .slice(0, Math.max(1, maxFiles))
        .map((name) => path.join("memory", "chats", `chat-${Math.floor(chatId)}`, name).replace(/\\/g, "/"));
    } catch {
      return [];
    }
  }

  private async getSearchFilePaths(options?: { chatId?: number }): Promise<string[]> {
    const candidates = new Set<string>();
    const memoryRoot = path.join(this.workspaceDir, "MEMORY.md");
    try {
      await fs.access(memoryRoot);
      candidates.add(memoryRoot);
    } catch {
      // ignore
    }

    const chatId = options?.chatId;
    if (typeof chatId === "number" && Number.isFinite(chatId) && chatId > 0) {
      const relContinuity = this.getChatContinuityRelPath(chatId);
      const fullContinuity = path.join(this.workspaceDir, relContinuity);
      if (await this.pathExists(fullContinuity)) {
        candidates.add(fullContinuity);
      }

      const chatFiles = await this.getRecentChatContextRelPaths(chatId, SEARCH_RECENT_CHAT_FILES);
      for (const relPath of chatFiles) {
        candidates.add(path.join(this.workspaceDir, relPath));
      }
    }

    try {
      const entries = await fs.readdir(this.getMemoryDir(), { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort()
        .reverse()
        .slice(0, SEARCH_RECENT_GLOBAL_FILES)
        .map((name) => path.join(this.getMemoryDir(), name));
      for (const file of files) {
        candidates.add(file);
      }
    } catch {
      // ignore
    }

    return [...candidates];
  }

  private async countMarkdownFilesRecursive(root: string, maxDepth: number): Promise<number> {
    if (maxDepth < 0) {
      return 0;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return 0;
    }

    let count = 0;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        count += 1;
        continue;
      }
      if (entry.isDirectory() && maxDepth > 0) {
        count += await this.countMarkdownFilesRecursive(path.join(root, entry.name), maxDepth - 1);
      }
    }
    return count;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
