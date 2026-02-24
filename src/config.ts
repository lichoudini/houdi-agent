import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";
import { resolveSecurityProfile } from "./security-profile.js";

dotenv.config();

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().trim().min(1),
  AGENTS_DIR: z.string().trim().default("./agents"),
  HOUDI_WORKSPACE_DIR: z.string().trim().default("./workspace"),
  HOUDI_CONTEXT_FILE_MAX_CHARS: z.coerce.number().int().positive().max(50_000).default(1800),
  HOUDI_CONTEXT_TOTAL_MAX_CHARS: z.coerce.number().int().positive().max(300_000).default(9_000),
  HOUDI_MEMORY_MAX_RESULTS: z.coerce.number().int().positive().max(50).default(4),
  HOUDI_MEMORY_SNIPPET_MAX_CHARS: z.coerce.number().int().positive().max(4000).default(320),
  HOUDI_MEMORY_MAX_INJECTED_CHARS: z.coerce.number().int().positive().max(50_000).default(1200),
  HOUDI_MEMORY_BACKEND: z.enum(["hybrid", "scan"]).default("hybrid"),
  HOUDI_INTENT_ROUTER_DATASET_FILE: z.string().trim().default("./houdi-intent-router-dataset.jsonl"),
  HOUDI_INTENT_ROUTER_ROUTES_FILE: z.string().trim().default("./workspace/state/intent-routes.json"),
  HOUDI_INTENT_ROUTER_VERSIONS_FILE: z.string().trim().default("./workspace/state/intent-router-versions.json"),
  HOUDI_INTENT_ROUTER_CHAT_ROUTES_FILE: z.string().trim().default("./workspace/state/intent-routes-by-chat.json"),
  HOUDI_INTENT_ROUTER_CALIBRATION_FILE: z.string().trim().default("./workspace/state/intent-calibration.json"),
  HOUDI_INTENT_ROUTER_HYBRID_ALPHA: z.coerce.number().min(0.05).max(0.95).default(0.72),
  HOUDI_INTENT_ROUTER_MIN_SCORE_GAP: z.coerce.number().min(0).max(0.5).default(0.03),
  HOUDI_INTENT_ROUTER_AB_ENABLED: z.string().optional(),
  HOUDI_INTENT_ROUTER_AB_SPLIT_PERCENT: z.coerce.number().int().min(0).max(100).default(50),
  HOUDI_INTENT_ROUTER_AB_VARIANT_B_ALPHA: z.coerce.number().min(0.05).max(0.95).default(0.66),
  HOUDI_INTENT_ROUTER_AB_VARIANT_B_MIN_GAP: z.coerce.number().min(0).max(0.5).default(0.02),
  HOUDI_INTENT_ROUTER_AB_VARIANT_B_THRESHOLD_SHIFT: z.coerce.number().min(-0.3).max(0.3).default(0),
  HOUDI_INTENT_ROUTER_ROUTE_ALPHA_OVERRIDES_JSON: z.string().trim().optional(),
  HOUDI_INTENT_ROUTER_ALERT_PRECISION_MIN: z.coerce.number().min(0).max(1).default(0.55),
  HOUDI_INTENT_ROUTER_ALERT_MIN_SAMPLES: z.coerce.number().int().min(1).max(1000).default(20),
  HOUDI_INTENT_ROUTER_HARD_NEGATIVES_ENABLED: z.string().optional(),
  HOUDI_INTENT_ROUTER_HARD_NEGATIVES_POLL_MS: z.coerce.number().int().positive().max(86_400_000).default(1_800_000),
  HOUDI_INTENT_ROUTER_HARD_NEGATIVES_READ_LIMIT: z.coerce.number().int().min(100).max(20_000).default(4000),
  HOUDI_INTENT_ROUTER_HARD_NEGATIVES_MAX_PER_ROUTE: z.coerce.number().int().min(1).max(100).default(10),
  HOUDI_INTENT_ROUTER_HARD_NEGATIVES_MIN_ADDED: z.coerce.number().int().min(1).max(200).default(2),
  HOUDI_INTENT_ROUTER_CANARY_GUARD_ENABLED: z.string().optional(),
  HOUDI_INTENT_ROUTER_CANARY_GUARD_POLL_MS: z.coerce.number().int().positive().max(86_400_000).default(300_000),
  HOUDI_INTENT_ROUTER_CANARY_GUARD_MIN_SAMPLES: z.coerce.number().int().min(5).max(5000).default(60),
  HOUDI_INTENT_ROUTER_CANARY_GUARD_MIN_ACCURACY: z.coerce.number().min(0).max(1).default(0.55),
  HOUDI_INTENT_ROUTER_CANARY_GUARD_BREACHES_TO_DISABLE: z.coerce.number().int().min(1).max(20).default(2),
  HOUDI_INTENT_SHADOW_MODE_ENABLED: z.string().optional(),
  HOUDI_INTENT_SHADOW_SAMPLE_PERCENT: z.coerce.number().int().min(0).max(100).default(0),
  HOUDI_INTENT_SHADOW_ALPHA: z.coerce.number().min(0.05).max(0.95).default(0.66),
  HOUDI_INTENT_SHADOW_MIN_SCORE_GAP: z.coerce.number().min(0).max(0.5).default(0.02),
  HOUDI_INTENT_CLARIFICATION_TTL_MS: z.coerce.number().int().positive().max(3_600_000).default(300_000),
  HOUDI_STATE_DB_FILE: z.string().trim().default("./workspace/state/houdi-state.sqlite"),
  HOUDI_IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().max(7 * 24 * 60 * 60 * 1000).default(86_400_000),
  HOUDI_INCOMING_QUEUE_MAX_PER_CHAT: z.coerce.number().int().positive().max(1000).default(30),
  HOUDI_INCOMING_QUEUE_MAX_TOTAL: z.coerce.number().int().positive().max(10_000).default(400),
  HOUDI_HANDLER_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(45_000),
  HOUDI_HANDLER_CIRCUIT_BREAKER_FAILURES: z.coerce.number().int().positive().max(20).default(3),
  HOUDI_HANDLER_CIRCUIT_BREAKER_OPEN_MS: z.coerce.number().int().positive().max(86_400_000).default(60_000),
  HOUDI_TRANSIENT_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  HOUDI_TRANSIENT_RETRY_BASE_MS: z.coerce.number().int().positive().max(60_000).default(400),
  HOUDI_AGENT_POLICY_FILE: z.string().trim().default("./workspace/state/agent-policy.json"),
  HOUDI_AGENTIC_CANARY_PERCENT: z.coerce.number().int().min(0).max(100).default(100),
  HOUDI_SECURITY_PROFILE: z.string().trim().optional(),
  HOUDI_AGENT_VERSION: z.string().trim().default("0.63b"),
  HOUDI_SCHEDULE_POLL_MS: z.coerce.number().int().positive().max(300_000).default(15_000),
  HOUDI_SELFSKILL_DRAFTS_FILE: z.string().trim().default("./houdi-selfskill-drafts.json"),
  HOUDI_INTERESTS_FILE: z.string().trim().default("./houdi-interests.json"),
  HOUDI_SUGGESTIONS_ENABLED: z.string().optional(),
  HOUDI_SUGGESTIONS_MAX_PER_DAY: z.coerce.number().int().positive().max(100).default(15),
  HOUDI_SUGGESTIONS_MIN_INTERVAL_MINUTES: z.coerce.number().int().positive().max(24 * 60).default(90),
  HOUDI_SUGGESTIONS_MIN_OBSERVATIONS: z.coerce.number().int().positive().max(500).default(10),
  HOUDI_SUGGESTIONS_POLL_MS: z.coerce.number().int().positive().max(86_400_000).default(600_000),
  DEFAULT_AGENT: z.string().trim().default("operator"),
  EXEC_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  MAX_STDIO_CHARS: z.coerce.number().int().positive().max(200_000).default(6000),
  AI_PROVIDER: z.enum(["auto", "openai", "anthropic", "gemini"]).default("auto"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().trim().default("gpt-4o-mini"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().trim().default("claude-3-5-sonnet-latest"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().trim().default("gemini-2.0-flash"),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(8192).default(350),
  HOUDI_ECO_MODE_DEFAULT: z.string().optional(),
  OPENAI_ECO_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4096).default(120),
  HOUDI_PROGRESS_NOTICES: z.string().optional(),
  OPENAI_AUDIO_MODEL: z.string().trim().default("whisper-1"),
  OPENAI_AUDIO_LANGUAGE: z.string().trim().optional(),
  OPENAI_AUDIO_MAX_FILE_BYTES: z.coerce.number().int().positive().max(50_000_000).default(20_000_000),
  HOUDI_FILE_MAX_FILE_BYTES: z.coerce.number().int().positive().max(100_000_000).default(50_000_000),
  HOUDI_IMAGE_MAX_FILE_BYTES: z.coerce.number().int().positive().max(50_000_000).default(20_000_000),
  HOUDI_DOC_MAX_FILE_BYTES: z.coerce.number().int().positive().max(100_000_000).default(25_000_000),
  HOUDI_DOC_MAX_TEXT_CHARS: z.coerce.number().int().positive().max(300_000).default(15_000),
  ENABLE_WEB_BROWSE: z.string().optional(),
  WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().positive().max(10).default(3),
  WEB_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(20_000),
  WEB_FETCH_MAX_BYTES: z.coerce.number().int().positive().max(10_000_000).default(2_000_000),
  WEB_CONTENT_MAX_CHARS: z.coerce.number().int().positive().max(200_000).default(8_000),
  ENABLE_GMAIL_ACCOUNT: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().trim().optional(),
  GMAIL_CLIENT_SECRET: z.string().trim().optional(),
  GMAIL_REFRESH_TOKEN: z.string().trim().optional(),
  GMAIL_ACCOUNT_EMAIL: z.string().trim().optional(),
  GMAIL_MAX_RESULTS: z.coerce.number().int().positive().max(100).default(5),
  ENABLE_CONNECTOR_CONTROL: z.string().optional(),
  CONNECTOR_APP_DIR: z.string().trim().optional(),
  CONNECTOR_APP_SERVICE: z.string().trim().optional(),
  CONNECTOR_TUNNEL_SERVICE: z.string().trim().optional(),
  CONNECTOR_LOCAL_HEALTH_URL: z.string().trim().optional(),
  CONNECTOR_PUBLIC_HEALTH_URL: z.string().trim().optional(),
  CONNECTOR_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).optional(),
  CONNECTOR_SOURCE_ACCOUNT_MAP_JSON: z.string().trim().optional(),
  HOUDI_LOCAL_API_ENABLED: z.string().optional(),
  HOUDI_LOCAL_API_HOST: z.string().trim().default("127.0.0.1"),
  HOUDI_LOCAL_API_PORT: z.coerce.number().int().positive().max(65535).default(3210),
  HOUDI_LOCAL_API_TOKEN: z.string().trim().optional(),
  ADMIN_APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(300),
  AUDIT_LOG_PATH: z.string().trim().default("./houdi-audit.log"),
  ENABLE_REBOOT_COMMAND: z.string().optional(),
  REBOOT_COMMAND: z.string().trim().default("systemctl reboot"),
});

function parseAllowedUserIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number.parseInt(entry, 10))
    .filter(Number.isFinite);

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must include at least one valid numeric user ID");
  }

  return new Set(ids);
}

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value === "undefined") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean flag value: ${value}`);
}

function parseStringMapJson(value: string | undefined): Record<string, string> {
  if (!value || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const output: Record<string, string> = {};
    for (const [key, rawVal] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rawVal !== "string") {
        continue;
      }
      const normalizedKey = key.trim().toLowerCase();
      const normalizedVal = rawVal.trim();
      if (!normalizedKey || !normalizedVal) {
        continue;
      }
      output[normalizedKey] = normalizedVal;
    }
    return output;
  } catch {
    return {};
  }
}

function parseIntentRouteAlphaMapJson(value: string | undefined): Record<string, number> {
  if (!value || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const allowed = new Set([
      "self-maintenance",
      "connector",
      "schedule",
      "memory",
      "gmail-recipients",
      "gmail",
      "workspace",
      "document",
      "web",
    ]);
    const output: Record<string, number> = {};
    for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
      const keyRaw = rawKey.trim();
      const key = keyRaw === "connector" ? "connector" : keyRaw;
      if (!allowed.has(key)) {
        continue;
      }
      const numeric = Number(rawValue);
      if (!Number.isFinite(numeric)) {
        continue;
      }
      output[key] = Math.max(0.05, Math.min(0.95, Number(numeric)));
    }
    return output;
  } catch {
    return {};
  }
}

function normalizeConnectorSourceMapKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseConnectorSourceAccountMapJson(value: string | undefined): Record<string, string> {
  const base = parseStringMapJson(value);
  const output: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(base)) {
    const normalizedKey = normalizeConnectorSourceMapKey(rawKey);
    const normalizedValue = rawValue.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function isValidIPv4(host: string): boolean {
  const chunks = host.split(".");
  if (chunks.length !== 4) {
    return false;
  }
  for (const chunk of chunks) {
    if (!/^\d{1,3}$/.test(chunk)) {
      return false;
    }
    const value = Number.parseInt(chunk, 10);
    if (value < 0 || value > 255) {
      return false;
    }
  }
  return true;
}

function isValidHostname(host: string): boolean {
  if (host.length > 253 || host.startsWith("-") || host.endsWith("-")) {
    return false;
  }
  const labels = host.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) {
    return false;
  }
  return labels.every((label) => /^[A-Za-z0-9-]+$/.test(label) && !label.startsWith("-") && !label.endsWith("-"));
}

function normalizeLocalApiHost(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "127.0.0.1";
  }
  const lowered = value.toLowerCase();
  if (["y", "yes", "s", "si", "sí", "n", "no", "true", "false"].includes(lowered)) {
    return "127.0.0.1";
  }
  if (lowered === "localhost" || value === "::1" || isValidIPv4(value) || isValidHostname(value)) {
    return value;
  }
  return "127.0.0.1";
}

const env = EnvSchema.parse(process.env);
const securityProfile = resolveSecurityProfile(env.HOUDI_SECURITY_PROFILE);

export const config = {
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  allowedUserIds: parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS),
  agentsDir: path.resolve(process.cwd(), env.AGENTS_DIR),
  workspaceDir: path.resolve(process.cwd(), env.HOUDI_WORKSPACE_DIR),
  contextFileMaxChars: env.HOUDI_CONTEXT_FILE_MAX_CHARS,
  contextTotalMaxChars: env.HOUDI_CONTEXT_TOTAL_MAX_CHARS,
  memoryMaxResults: env.HOUDI_MEMORY_MAX_RESULTS,
  memorySnippetMaxChars: env.HOUDI_MEMORY_SNIPPET_MAX_CHARS,
  memoryMaxInjectedChars: env.HOUDI_MEMORY_MAX_INJECTED_CHARS,
  memoryBackend: env.HOUDI_MEMORY_BACKEND,
  intentRouterDatasetFile: env.HOUDI_INTENT_ROUTER_DATASET_FILE,
  intentRouterRoutesFile: env.HOUDI_INTENT_ROUTER_ROUTES_FILE,
  intentRouterVersionsFile: env.HOUDI_INTENT_ROUTER_VERSIONS_FILE,
  intentRouterChatRoutesFile: env.HOUDI_INTENT_ROUTER_CHAT_ROUTES_FILE,
  intentRouterCalibrationFile: env.HOUDI_INTENT_ROUTER_CALIBRATION_FILE,
  intentRouterHybridAlpha: env.HOUDI_INTENT_ROUTER_HYBRID_ALPHA,
  intentRouterMinScoreGap: env.HOUDI_INTENT_ROUTER_MIN_SCORE_GAP,
  intentRouterAbEnabled: parseBooleanFlag(env.HOUDI_INTENT_ROUTER_AB_ENABLED, false),
  intentRouterAbSplitPercent: env.HOUDI_INTENT_ROUTER_AB_SPLIT_PERCENT,
  intentRouterAbVariantBAlpha: env.HOUDI_INTENT_ROUTER_AB_VARIANT_B_ALPHA,
  intentRouterAbVariantBMinGap: env.HOUDI_INTENT_ROUTER_AB_VARIANT_B_MIN_GAP,
  intentRouterAbVariantBThresholdShift: env.HOUDI_INTENT_ROUTER_AB_VARIANT_B_THRESHOLD_SHIFT,
  intentRouterRouteAlphaOverrides: parseIntentRouteAlphaMapJson(env.HOUDI_INTENT_ROUTER_ROUTE_ALPHA_OVERRIDES_JSON),
  intentRouterAlertPrecisionMin: env.HOUDI_INTENT_ROUTER_ALERT_PRECISION_MIN,
  intentRouterAlertMinSamples: env.HOUDI_INTENT_ROUTER_ALERT_MIN_SAMPLES,
  intentRouterHardNegativesEnabled: parseBooleanFlag(env.HOUDI_INTENT_ROUTER_HARD_NEGATIVES_ENABLED, true),
  intentRouterHardNegativesPollMs: env.HOUDI_INTENT_ROUTER_HARD_NEGATIVES_POLL_MS,
  intentRouterHardNegativesReadLimit: env.HOUDI_INTENT_ROUTER_HARD_NEGATIVES_READ_LIMIT,
  intentRouterHardNegativesMaxPerRoute: env.HOUDI_INTENT_ROUTER_HARD_NEGATIVES_MAX_PER_ROUTE,
  intentRouterHardNegativesMinAdded: env.HOUDI_INTENT_ROUTER_HARD_NEGATIVES_MIN_ADDED,
  intentRouterCanaryGuardEnabled: parseBooleanFlag(env.HOUDI_INTENT_ROUTER_CANARY_GUARD_ENABLED, true),
  intentRouterCanaryGuardPollMs: env.HOUDI_INTENT_ROUTER_CANARY_GUARD_POLL_MS,
  intentRouterCanaryGuardMinSamples: env.HOUDI_INTENT_ROUTER_CANARY_GUARD_MIN_SAMPLES,
  intentRouterCanaryGuardMinAccuracy: env.HOUDI_INTENT_ROUTER_CANARY_GUARD_MIN_ACCURACY,
  intentRouterCanaryGuardBreachesToDisable: env.HOUDI_INTENT_ROUTER_CANARY_GUARD_BREACHES_TO_DISABLE,
  intentShadowModeEnabled: parseBooleanFlag(env.HOUDI_INTENT_SHADOW_MODE_ENABLED, false),
  intentShadowSamplePercent: env.HOUDI_INTENT_SHADOW_SAMPLE_PERCENT,
  intentShadowAlpha: env.HOUDI_INTENT_SHADOW_ALPHA,
  intentShadowMinScoreGap: env.HOUDI_INTENT_SHADOW_MIN_SCORE_GAP,
  intentClarificationTtlMs: env.HOUDI_INTENT_CLARIFICATION_TTL_MS,
  stateDbFile: env.HOUDI_STATE_DB_FILE,
  idempotencyTtlMs: env.HOUDI_IDEMPOTENCY_TTL_MS,
  incomingQueueMaxPerChat: env.HOUDI_INCOMING_QUEUE_MAX_PER_CHAT,
  incomingQueueMaxTotal: env.HOUDI_INCOMING_QUEUE_MAX_TOTAL,
  handlerTimeoutMs: env.HOUDI_HANDLER_TIMEOUT_MS,
  handlerCircuitBreakerFailures: env.HOUDI_HANDLER_CIRCUIT_BREAKER_FAILURES,
  handlerCircuitBreakerOpenMs: env.HOUDI_HANDLER_CIRCUIT_BREAKER_OPEN_MS,
  transientRetryAttempts: env.HOUDI_TRANSIENT_RETRY_ATTEMPTS,
  transientRetryBaseMs: env.HOUDI_TRANSIENT_RETRY_BASE_MS,
  agentPolicyFile: env.HOUDI_AGENT_POLICY_FILE,
  agenticCanaryPercent: env.HOUDI_AGENTIC_CANARY_PERCENT,
  securityProfile,
  agentVersion: env.HOUDI_AGENT_VERSION,
  schedulePollMs: env.HOUDI_SCHEDULE_POLL_MS,
  selfSkillDraftsFile: env.HOUDI_SELFSKILL_DRAFTS_FILE,
  interestsFile: env.HOUDI_INTERESTS_FILE,
  suggestionsEnabled: parseBooleanFlag(env.HOUDI_SUGGESTIONS_ENABLED, true),
  suggestionsMaxPerDay: env.HOUDI_SUGGESTIONS_MAX_PER_DAY,
  suggestionsMinIntervalMinutes: env.HOUDI_SUGGESTIONS_MIN_INTERVAL_MINUTES,
  suggestionsMinObservations: env.HOUDI_SUGGESTIONS_MIN_OBSERVATIONS,
  suggestionsPollMs: env.HOUDI_SUGGESTIONS_POLL_MS,
  defaultAgent: env.DEFAULT_AGENT,
  execTimeoutMs: env.EXEC_TIMEOUT_MS,
  maxStdioChars: env.MAX_STDIO_CHARS,
  aiProvider: env.AI_PROVIDER,
  openAiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
  openAiModel: env.OPENAI_MODEL,
  anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
  anthropicModel: env.ANTHROPIC_MODEL,
  geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
  geminiModel: env.GEMINI_MODEL,
  openAiMaxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
  ecoModeDefault: parseBooleanFlag(env.HOUDI_ECO_MODE_DEFAULT, false),
  openAiEcoMaxOutputTokens: env.OPENAI_ECO_MAX_OUTPUT_TOKENS,
  progressNotices: parseBooleanFlag(env.HOUDI_PROGRESS_NOTICES, false),
  openAiAudioModel: env.OPENAI_AUDIO_MODEL,
  openAiAudioLanguage: env.OPENAI_AUDIO_LANGUAGE?.trim() || undefined,
  openAiAudioMaxFileBytes: env.OPENAI_AUDIO_MAX_FILE_BYTES,
  fileMaxFileBytes: env.HOUDI_FILE_MAX_FILE_BYTES,
  imageMaxFileBytes: env.HOUDI_IMAGE_MAX_FILE_BYTES,
  docMaxFileBytes: env.HOUDI_DOC_MAX_FILE_BYTES,
  docMaxTextChars: env.HOUDI_DOC_MAX_TEXT_CHARS,
  enableWebBrowse: parseBooleanFlag(env.ENABLE_WEB_BROWSE, true),
  webSearchMaxResults: env.WEB_SEARCH_MAX_RESULTS,
  webFetchTimeoutMs: env.WEB_FETCH_TIMEOUT_MS,
  webFetchMaxBytes: env.WEB_FETCH_MAX_BYTES,
  webContentMaxChars: env.WEB_CONTENT_MAX_CHARS,
  enableGmailAccount: parseBooleanFlag(env.ENABLE_GMAIL_ACCOUNT, false),
  gmailClientId: env.GMAIL_CLIENT_ID?.trim() || undefined,
  gmailClientSecret: env.GMAIL_CLIENT_SECRET?.trim() || undefined,
  gmailRefreshToken: env.GMAIL_REFRESH_TOKEN?.trim() || undefined,
  gmailAccountEmail: env.GMAIL_ACCOUNT_EMAIL?.trim() || undefined,
  gmailMaxResults: env.GMAIL_MAX_RESULTS,
  enableConnectorControl: parseBooleanFlag(env.ENABLE_CONNECTOR_CONTROL, false),
  connectorAppDir: path.resolve(process.cwd(), env.CONNECTOR_APP_DIR || "./connector-app"),
  connectorAppService: env.CONNECTOR_APP_SERVICE || "houdi-connector-app.service",
  connectorTunnelService: env.CONNECTOR_TUNNEL_SERVICE || "houdi-connector-tunnel.service",
  connectorLocalHealthUrl: env.CONNECTOR_LOCAL_HEALTH_URL || "http://127.0.0.1:3333/health",
  connectorPublicHealthUrl: env.CONNECTOR_PUBLIC_HEALTH_URL || "http://127.0.0.1:3333/health",
  connectorHealthTimeoutMs: env.CONNECTOR_HEALTH_TIMEOUT_MS ?? 7000,
  connectorSourceAccountMap: parseConnectorSourceAccountMapJson(env.CONNECTOR_SOURCE_ACCOUNT_MAP_JSON),
  localApiEnabled: parseBooleanFlag(env.HOUDI_LOCAL_API_ENABLED, true),
  localApiHost: normalizeLocalApiHost(env.HOUDI_LOCAL_API_HOST),
  localApiPort: env.HOUDI_LOCAL_API_PORT,
  localApiToken: env.HOUDI_LOCAL_API_TOKEN?.trim() || undefined,
  adminApprovalTtlSeconds: env.ADMIN_APPROVAL_TTL_SECONDS,
  auditLogPath: env.AUDIT_LOG_PATH,
  enableRebootCommand: parseBooleanFlag(env.ENABLE_REBOOT_COMMAND, false),
  rebootCommand: env.REBOOT_COMMAND,
};
