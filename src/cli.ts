#!/usr/bin/env node

import readline from "node:readline/promises";
import process from "node:process";
import { AgentContextMemory } from "./agent-context-memory.js";
import { config } from "./config.js";
import { formatMemoryHitsNaturalText } from "./memory-presenter.js";
import { OpenAiService } from "./openai-client.js";

type CliMode = "ask" | "chat" | "memory-status" | "memory-search" | "memory-view" | "remember";
type CliTransport = "auto" | "bridge" | "local";

type CliOptions = {
  mode: CliMode;
  message?: string;
  chatId: number;
  userId: number;
  transport: CliTransport;
  json: boolean;
  useMemory: boolean;
  rememberTurns: boolean;
  memorySearchQuery?: string;
  memoryViewPath?: string;
  memoryViewFrom: number;
  memoryViewLines: number;
  rememberNote?: string;
  help: boolean;
};

type DurableUserFact = {
  key: string;
  value: string;
};

const ANSI_LIGHT_BLUE = "\x1b[94m";
const ANSI_RESET = "\x1b[0m";
const CLI_LOCAL_BRIDGE_MESSAGE_PATH = "/internal/cli/message";
const CLI_LOCAL_BRIDGE_HEALTH_PATH = "/internal/cli/health";
const CLI_LOCAL_BRIDGE_TIMEOUT_MS = 90_000;
const VRAND_QUOTE =
  "The currents before us are ever changing. We must adapt and press forward if we are to see our journey's end.";

function printUsage(): void {
  const lines = [
    "Houdi CLI",
    "",
    "Uso:",
    "  npm run cli -- [agent|ask] --message \"<texto>\" [opciones]",
    "  npm run cli -- [chat] [opciones]           # modo interactivo",
    "  npm run cli -- memory status [opciones]",
    "  npm run cli -- memory search \"<texto>\" [opciones]",
    "  npm run cli -- memory view <path> [from] [lines] [opciones]",
    "  npm run cli -- remember \"<nota>\" [opciones]",
    "",
    "Opciones:",
    "  -m, --message <texto>     Mensaje a consultar",
    "  --chat-id <n>             Scope de memoria por chat (default: HOUDI_CLI_CHAT_ID o 1)",
    "  --user-id <n>             userId lógico (default: HOUDI_CLI_USER_ID o primer TELEGRAM_ALLOWED_USER_IDS)",
    "  --transport <auto|bridge|local>  Modo de ejecución (default: auto)",
    "  --json                    Salida JSON",
    "  --no-memory               No inyectar contexto/memoria al modelo",
    "  --no-remember             No guardar turnos de conversación",
    "  --from <n>                Línea inicial para memory view",
    "  --lines <n>               Cantidad de líneas para memory view",
    "  -i, --interactive         Forzar modo interactivo",
    "  -h, --help                Mostrar ayuda",
    "",
    "Ejemplos:",
    "  npm run cli -- agent -m \"te acordas de mi equipo\"",
    "  npm run cli -- chat",
    "  npm run cli -- memory search \"gmail\"",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function buildVrandAsciiLines(): string[] {
  // 8-line ASCII banner (height fixed at 8)
  const v = [
    "V     V",
    "V     V",
    "V     V",
    "V     V",
    " V   V ",
    " V   V ",
    "  V V  ",
    "   V   ",
  ];
  const r = [
    "RRRRR  ",
    "R    R ",
    "R    R ",
    "RRRRR  ",
    "R  R   ",
    "R   R  ",
    "R    R ",
    "R     R",
  ];
  const a = [
    "  AAA  ",
    " A   A ",
    "A     A",
    "A     A",
    "AAAAAAA",
    "A     A",
    "A     A",
    "A     A",
  ];
  const n = [
    "N     N",
    "NN    N",
    "N N   N",
    "N  N  N",
    "N   N N",
    "N    NN",
    "N     N",
    "N     N",
  ];
  const d = [
    "DDDDD  ",
    "D    D ",
    "D     D",
    "D     D",
    "D     D",
    "D     D",
    "D    D ",
    "DDDDD  ",
  ];
  const lines: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    lines.push(`${v[i]}  ${r[i]}  ${a[i]}  ${n[i]}  ${d[i]}`);
  }
  return lines;
}

function printVrandWelcomeBanner(): void {
  const lines = buildVrandAsciiLines();
  const output = lines.map((line) => `${ANSI_LIGHT_BLUE}${line}${ANSI_RESET}`).join("\n");
  process.stdout.write(`${output}\n`);
  process.stdout.write(`${ANSI_LIGHT_BLUE}${VRAND_QUOTE}${ANSI_RESET}\n\n`);
}

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} inválido: ${value}`);
  }
  return parsed;
}

function nextArg(argv: string[], index: number, label: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Falta valor para ${label}`);
  }
  return value;
}

function resolveDefaultCliChatId(): number {
  const raw = process.env.HOUDI_CLI_CHAT_ID?.trim();
  if (!raw) {
    return 1;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return parsed;
}

function resolveDefaultCliUserId(): number {
  const raw = process.env.HOUDI_CLI_USER_ID?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const firstAllowed = config.allowedUserIds.values().next().value as number | undefined;
  if (typeof firstAllowed === "number" && Number.isFinite(firstAllowed) && firstAllowed > 0) {
    return firstAllowed;
  }
  return 1;
}

function parseCliTransport(raw: string): CliTransport {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "auto" || normalized === "bridge" || normalized === "local") {
    return normalized;
  }
  throw new Error(`--transport inválido: ${raw} (usa auto|bridge|local)`);
}

function parseCliArgs(argvInput: string[]): CliOptions {
  const argv = [...argvInput];
  let mode: CliMode = "chat";
  let help = false;
  let message = "";
  let json = false;
  let useMemory = true;
  let rememberTurns = true;
  let chatId = resolveDefaultCliChatId();
  let userId = resolveDefaultCliUserId();
  let transport: CliTransport = "auto";
  let memorySearchQuery = "";
  let memoryViewPath = "";
  let memoryViewFrom = 1;
  let memoryViewLines = 40;
  let rememberNote = "";
  const positional: string[] = [];

  const first = argv[0]?.toLowerCase().trim();
  if (first === "agent" || first === "ask") {
    mode = "ask";
    argv.shift();
  } else if (first === "chat" || first === "repl") {
    mode = "chat";
    argv.shift();
  } else if (first === "memory") {
    argv.shift();
    const sub = (argv.shift() ?? "").toLowerCase().trim();
    if (!sub || sub === "status") {
      mode = "memory-status";
    } else if (sub === "search") {
      mode = "memory-search";
    } else if (sub === "view") {
      mode = "memory-view";
    } else {
      throw new Error(`Subcomando memory no reconocido: ${sub}`);
    }
  } else if (first === "remember") {
    mode = "remember";
    argv.shift();
  }

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i] ?? "";
    if (!current) {
      continue;
    }
    if (current === "-h" || current === "--help") {
      help = true;
      continue;
    }
    if (current === "-i" || current === "--interactive") {
      mode = "chat";
      continue;
    }
    if (current === "--json") {
      json = true;
      continue;
    }
    if (current === "--no-memory") {
      useMemory = false;
      continue;
    }
    if (current === "--no-remember") {
      rememberTurns = false;
      continue;
    }
    if (current === "-m" || current === "--message") {
      message = nextArg(argv, i, current);
      i += 1;
      continue;
    }
    if (current === "--chat-id") {
      chatId = parsePositiveInt(nextArg(argv, i, current), current);
      i += 1;
      continue;
    }
    if (current === "--user-id") {
      userId = parsePositiveInt(nextArg(argv, i, current), current);
      i += 1;
      continue;
    }
    if (current === "--transport") {
      transport = parseCliTransport(nextArg(argv, i, current));
      i += 1;
      continue;
    }
    if (current === "--from") {
      memoryViewFrom = parsePositiveInt(nextArg(argv, i, current), current);
      i += 1;
      continue;
    }
    if (current === "--lines") {
      memoryViewLines = parsePositiveInt(nextArg(argv, i, current), current);
      i += 1;
      continue;
    }
    if (current === "--remember") {
      mode = "remember";
      rememberNote = nextArg(argv, i, current);
      i += 1;
      continue;
    }
    if (current === "--memory-status") {
      mode = "memory-status";
      continue;
    }
    if (current === "--memory-search") {
      mode = "memory-search";
      memorySearchQuery = nextArg(argv, i, current);
      i += 1;
      continue;
    }
    if (current === "--memory-view") {
      mode = "memory-view";
      memoryViewPath = nextArg(argv, i, current);
      i += 1;
      continue;
    }
    positional.push(current);
  }

  if (!message && mode === "ask" && positional.length > 0) {
    message = positional.join(" ").trim();
  }
  if (!rememberNote && mode === "remember" && positional.length > 0) {
    rememberNote = positional.join(" ").trim();
  }
  if (!memorySearchQuery && mode === "memory-search" && positional.length > 0) {
    memorySearchQuery = positional.join(" ").trim();
  }
  if (!memoryViewPath && mode === "memory-view" && positional.length > 0) {
    memoryViewPath = positional[0] ?? "";
    if (positional.length >= 2 && /^\d+$/.test(positional[1] ?? "")) {
      memoryViewFrom = parsePositiveInt(positional[1]!, "from");
    }
    if (positional.length >= 3 && /^\d+$/.test(positional[2] ?? "")) {
      memoryViewLines = parsePositiveInt(positional[2]!, "lines");
    }
  }

  return {
    mode,
    ...(message ? { message } : {}),
    chatId,
    userId,
    transport,
    json,
    useMemory,
    rememberTurns,
    ...(memorySearchQuery ? { memorySearchQuery } : {}),
    ...(memoryViewPath ? { memoryViewPath } : {}),
    memoryViewFrom,
    memoryViewLines,
    ...(rememberNote ? { rememberNote } : {}),
    help,
  };
}

function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = " [...truncado]";
  const usable = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, usable)}${marker}`;
}

function cleanDurableFactValue(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.?!,;:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pushDurableFact(
  factsByKey: Map<string, DurableUserFact>,
  key: string,
  rawValue: string,
  maxWords: number = 14,
): void {
  const value = cleanDurableFactValue(rawValue);
  if (!value) {
    return;
  }
  if (value.split(/\s+/).length > maxWords) {
    return;
  }
  if (/^(no se|ninguno|ningun|ninguna|n\/a)$/i.test(value)) {
    return;
  }
  factsByKey.set(key, { key, value });
}

function extractDurableUserFacts(text: string): DurableUserFact[] {
  const original = text.trim();
  if (!original) {
    return [];
  }
  const normalized = normalizeIntentText(original);
  const factsByKey = new Map<string, DurableUserFact>();

  let rawTeam = "";
  if (/\bmi\s+equipo(?:\s+de\s+futbol)?\b/.test(normalized)) {
    rawTeam =
      original.match(/\bmi\s+equipo(?:\s+de\s+f[uú]tbol)?\s*(?:es|era|seria|sería|se\s+llama|:|-)?\s*(.+)$/i)?.[1] ??
      "";
  }
  if (!rawTeam && /\b(?:soy|me\s+hice)\s+hincha\s+de\b/.test(normalized)) {
    rawTeam = original.match(/\b(?:soy|me\s+hice)\s+hincha\s+de\s+(.+)$/i)?.[1] ?? "";
  }
  if (!rawTeam && /\bmi\s+club(?:\s+de\s+futbol)?\b/.test(normalized)) {
    rawTeam =
      original.match(/\bmi\s+club(?:\s+de\s+f[uú]tbol)?\s*(?:es|favorito\s+es|:|-)?\s*(.+)$/i)?.[1] ?? "";
  }
  if (rawTeam) {
    pushDurableFact(factsByKey, "equipo_futbol", rawTeam, 10);
  }

  const locationRaw =
    original.match(/\b(?:estoy|vivo|resido)\s+en\s+(.+)$/i)?.[1] ??
    original.match(/\b(?:soy|vengo)\s+de\s+(.+)$/i)?.[1] ??
    "";
  if (locationRaw) {
    pushDurableFact(factsByKey, "ubicacion", locationRaw, 10);
  }

  const explicitEmail = original.match(/\bmi\s+(?:correo|email|mail)\s+(?:es|:)\s*([^\s]+@[^\s]+)\b/i)?.[1] ?? "";
  if (explicitEmail) {
    pushDurableFact(factsByKey, "email_principal", explicitEmail, 3);
  }

  if (/\b(lenguaje\s+natural|natural)\b/.test(normalized) && /\b(prefiero|quiero|usa|usar|habla|hablar)\b/.test(normalized)) {
    pushDurableFact(factsByKey, "preferencia_interaccion", "usar lenguaje natural", 6);
  }
  if (/\b(evita|sin)\b/.test(normalized) && /\b(comandos?|slash|barra)\b/.test(normalized)) {
    pushDurableFact(factsByKey, "preferencia_interaccion", "evitar comandos explicitos", 6);
  }

  return [...factsByKey.values()];
}

async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printErrorAndExit(message: string, json: boolean): never {
  if (json) {
    printJson({
      ok: false,
      error: message,
    });
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(1);
}

type LocalBridgeSuccess = {
  ok: true;
  chatId?: number;
  userId?: number;
  replies?: string[];
};

type LocalBridgeError = {
  ok: false;
  error?: string;
};

type LocalBridgeResponse = LocalBridgeSuccess | LocalBridgeError;

function buildLocalBridgeBaseUrl(): string {
  const host = config.localApiHost?.trim() || "127.0.0.1";
  const port = config.localApiPort;
  return `http://${host}:${port}`;
}

function buildLocalBridgeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = config.localApiToken?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let payload: unknown = null;
    if (bodyText.trim()) {
      try {
        payload = JSON.parse(bodyText) as unknown;
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const errorFromBody =
        payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload
          ? String((payload as Record<string, unknown>).error ?? "")
          : "";
      const detail = errorFromBody || truncateInline(bodyText, 240) || "sin detalle";
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n\n`);
    printUsage();
    process.exit(1);
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  const contextMemory = new AgentContextMemory({
    workspaceDir: config.workspaceDir,
    contextFileMaxChars: config.contextFileMaxChars,
    contextTotalMaxChars: config.contextTotalMaxChars,
    memoryMaxResults: config.memoryMaxResults,
    memorySnippetMaxChars: config.memorySnippetMaxChars,
    memoryMaxInjectedChars: config.memoryMaxInjectedChars,
    memoryBackend: config.memoryBackend,
  });
  await contextMemory.ensureWorkspace();

  const appendUserTurn = async (text: string): Promise<void> => {
    if (!options.rememberTurns) {
      return;
    }
    await contextMemory.appendConversationTurn({
      chatId: options.chatId,
      role: "user",
      text,
      source: "cli:message",
    });
    const durableFacts = extractDurableUserFacts(text);
    for (const fact of durableFacts) {
      await contextMemory.upsertLongTermFact({
        key: fact.key,
        value: fact.value,
        source: "cli:message",
        chatId: options.chatId,
      });
    }
  };

  const appendAssistantTurn = async (text: string): Promise<void> => {
    if (!options.rememberTurns) {
      return;
    }
    await contextMemory.appendConversationTurn({
      chatId: options.chatId,
      role: "assistant",
      text,
      source: "cli:message",
    });
  };

  const handleMemoryStatus = async (): Promise<void> => {
    const status = await contextMemory.getStatus();
    if (options.json) {
      printJson({ ok: true, status });
      return;
    }
    const lines = [
      "Estado de memoria:",
      `workspace: ${status.workspaceDir}`,
      `long-term (MEMORY.md): ${status.longTermMemoryExists ? "sí" : "no"}`,
      `archivos diarios: ${status.memoryFilesCount}`,
      `archivo de hoy: ${status.todayMemoryFile}`,
      `backend preferido: ${status.backendPreferred}`,
      `backend activo: ${status.backendLastUsed}`,
      `fallbacks acumulados: ${status.backendFallbackCount}`,
      ...(status.backendLastFallbackError ? [`ultimo fallback: ${status.backendLastFallbackError}`] : []),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  };

  const handleMemorySearch = async (queryInput: string): Promise<void> => {
    const query = queryInput.trim();
    if (!query) {
      throw new Error("Falta query para memory search");
    }
    const hits = await contextMemory.searchMemoryWithContext(query, {
      limit: config.memoryMaxResults,
      chatId: options.chatId,
    });
    if (options.json) {
      printJson({ ok: true, query, hits });
      return;
    }
    if (hits.length === 0) {
      process.stdout.write(`Sin resultados para: "${query}"\n`);
      return;
    }
    const text = formatMemoryHitsNaturalText({
      query,
      hits,
      intro: `Recuerdos encontrados para "${query}":`,
      followUpHint: 'Tip: usa "npm run cli -- memory view <path> <linea> <lineas>" para abrir mas contexto.',
    });
    process.stdout.write(`${text}\n`);
  };

  const handleMemoryView = async (pathInput: string, from: number, linesCount: number): Promise<void> => {
    const path = pathInput.trim();
    if (!path) {
      throw new Error("Falta path para memory view");
    }
    const result = await contextMemory.readMemoryFile(path, from, linesCount);
    if (options.json) {
      printJson({
        ok: true,
        result,
      });
      return;
    }
    process.stdout.write(
      [
        `${result.path} (lineas ${result.from}-${result.to})`,
        "",
        result.text || "(vacío)",
      ].join("\n"),
    );
    process.stdout.write("\n");
  };

  const handleRemember = async (noteInput: string): Promise<void> => {
    const note = noteInput.trim();
    if (!note) {
      throw new Error("Falta nota para remember");
    }
    const result = await contextMemory.appendDailyNote(note, {
      source: "cli:remember",
      chatId: options.chatId,
    });
    if (options.json) {
      printJson({
        ok: true,
        note,
        path: result.relPath,
      });
      return;
    }
    process.stdout.write(`Nota guardada en ${result.relPath}\n`);
  };

  if (options.mode === "memory-status") {
    await handleMemoryStatus();
    return;
  }
  if (options.mode === "memory-search") {
    await handleMemorySearch(options.memorySearchQuery ?? "");
    return;
  }
  if (options.mode === "memory-view") {
    await handleMemoryView(options.memoryViewPath ?? "", options.memoryViewFrom, options.memoryViewLines);
    return;
  }
  if (options.mode === "remember") {
    await handleRemember(options.rememberNote ?? "");
    return;
  }

  let openAi: OpenAiService | null = null;
  const bridgeBaseUrl = buildLocalBridgeBaseUrl();
  const bridgeHeaders = buildLocalBridgeHeaders();

  const buildPromptContext = async (query: string) => {
    if (!options.useMemory) {
      return undefined;
    }
    const text = query.trim();
    if (!text) {
      return undefined;
    }
    await contextMemory.flushBeforeReasoning(options.chatId);
    return await contextMemory.buildPromptContext(text, {
      chatId: options.chatId,
    });
  };

  const runOneShotLocal = async (promptInput: string): Promise<string> => {
    if (!openAi) {
      openAi = new OpenAiService();
      if (!openAi.isConfigured()) {
        throw new Error("OPENAI_API_KEY no está configurada en .env");
      }
    }
    const prompt = promptInput.trim();
    if (!prompt) {
      throw new Error("Mensaje vacío");
    }
    await appendUserTurn(prompt);
    const promptContext = await buildPromptContext(prompt);
    const answer = await openAi.ask(prompt, {
      context: promptContext,
    });
    await appendAssistantTurn(answer);
    return answer;
  };

  const runOneShotBridge = async (promptInput: string, source: string): Promise<string[]> => {
    if (!config.localApiEnabled) {
      throw new Error("Bridge local deshabilitado (HOUDI_LOCAL_API_ENABLED=false).");
    }
    const prompt = promptInput.trim();
    if (!prompt) {
      throw new Error("Mensaje vacío");
    }

    const payload = await fetchJsonWithTimeout<LocalBridgeResponse>(
      `${bridgeBaseUrl}${CLI_LOCAL_BRIDGE_MESSAGE_PATH}`,
      {
        method: "POST",
        headers: bridgeHeaders,
        body: JSON.stringify({
          text: prompt,
          chatId: options.chatId,
          userId: options.userId,
          source,
        }),
      },
      CLI_LOCAL_BRIDGE_TIMEOUT_MS,
    );

    if (!payload || typeof payload !== "object" || payload.ok !== true) {
      const errorMessage =
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as LocalBridgeError).error ?? "unknown")
          : "respuesta inválida";
      throw new Error(`Bridge local falló: ${errorMessage}`);
    }

    const replies =
      Array.isArray(payload.replies) && payload.replies.length > 0
        ? payload.replies.filter((item): item is string => typeof item === "string")
        : [];
    return replies;
  };

  const isBridgeHealthy = async (): Promise<boolean> => {
    if (!config.localApiEnabled) {
      return false;
    }
    try {
      const payload = await fetchJsonWithTimeout<Record<string, unknown>>(
        `${bridgeBaseUrl}${CLI_LOCAL_BRIDGE_HEALTH_PATH}`,
        {
          method: "GET",
          headers: bridgeHeaders,
        },
        7000,
      );
      return Boolean(payload?.ok);
    } catch {
      return false;
    }
  };

  let resolvedTransport: Exclude<CliTransport, "auto"> = "local";
  if (options.transport === "bridge") {
    const healthy = await isBridgeHealthy();
    if (!healthy) {
      throw new Error(
        `No pude conectar con el bridge local (${bridgeBaseUrl}). Levanta el servicio del bot o usa --transport local.`,
      );
    }
    resolvedTransport = "bridge";
  } else if (options.transport === "local") {
    resolvedTransport = "local";
  } else {
    resolvedTransport = (await isBridgeHealthy()) ? "bridge" : "local";
  }

  if (resolvedTransport === "local") {
    openAi = new OpenAiService();
    if (!openAi.isConfigured()) {
      throw new Error(
        `No encontré bridge local activo (${bridgeBaseUrl}) y OPENAI_API_KEY tampoco está configurada para modo local.`,
      );
    }
  }

  const runOneShot = async (promptInput: string, source: string): Promise<string[]> => {
    if (resolvedTransport === "bridge") {
      const replies = await runOneShotBridge(promptInput, source);
      return replies.length > 0 ? replies : ["(sin respuesta textual)"];
    }
    const answer = await runOneShotLocal(promptInput);
    return [answer];
  };

  if (options.mode === "ask") {
    let prompt = options.message?.trim() ?? "";
    if (!prompt) {
      prompt = await readStdinIfPiped();
    }
    if (!prompt) {
      throw new Error("Falta --message o stdin para modo ask");
    }
    const replies = await runOneShot(prompt, "cli:ask");
    const answer = replies.join("\n\n");
    if (options.json) {
      printJson({
        ok: true,
        transport: resolvedTransport,
        chatId: options.chatId,
        userId: options.userId,
        ...(resolvedTransport === "local" && openAi ? { model: openAi.getModel() } : {}),
        replies,
        answer,
      });
    } else {
      process.stdout.write(`${answer}\n`);
    }
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  printVrandWelcomeBanner();
  process.stdout.write(
    [
      `Houdi CLI chat (transport=${resolvedTransport}, chatId=${options.chatId}, userId=${options.userId}${resolvedTransport === "local" && openAi ? `, model=${openAi.getModel()}` : ""})`,
      'Comandos: "/help", "/exit", "/memory status", "/memory search <q>", "/memory view <path> [from] [lines]", "/remember <nota>"',
      "",
    ].join("\n"),
  );

  try {
    while (true) {
      const line = (await rl.question("houdi> ")).trim();
      if (!line) {
        continue;
      }
      const normalized = line.toLowerCase();
      if (normalized === "/exit" || normalized === "/quit" || normalized === ":q") {
        break;
      }
      if (normalized === "/help") {
        process.stdout.write(
          [
            "Comandos:",
            "  /exit | /quit",
            "  /memory status",
            "  /memory search <query>",
            "  /memory view <path> [from] [lines]",
            "  /remember <nota>",
            "",
          ].join("\n"),
        );
        continue;
      }
      if (normalized === "/memory status") {
        await handleMemoryStatus();
        continue;
      }
      if (normalized.startsWith("/memory search ")) {
        await handleMemorySearch(line.slice("/memory search ".length));
        continue;
      }
      if (normalized.startsWith("/memory view ")) {
        const tokens = line.slice("/memory view ".length).trim().split(/\s+/).filter(Boolean);
        const relPath = tokens[0] ?? "";
        const from = /^\d+$/.test(tokens[1] ?? "") ? parsePositiveInt(tokens[1]!, "from") : 1;
        const linesCount = /^\d+$/.test(tokens[2] ?? "") ? parsePositiveInt(tokens[2]!, "lines") : 40;
        await handleMemoryView(relPath, from, linesCount);
        continue;
      }
      if (normalized.startsWith("/remember ")) {
        await handleRemember(line.slice("/remember ".length));
        continue;
      }

      try {
        const replies = await runOneShot(line, "cli:chat");
        process.stdout.write(`${replies.join("\n\n")}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes("--json");
  printErrorAndExit(message, wantsJson);
});
