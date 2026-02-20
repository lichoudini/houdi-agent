import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().trim().min(1),
  AGENTS_DIR: z.string().trim().default("./agents"),
  HOUDI_WORKSPACE_DIR: z.string().trim().default("./workspace"),
  HOUDI_CONTEXT_FILE_MAX_CHARS: z.coerce.number().int().positive().max(50_000).default(3000),
  HOUDI_CONTEXT_TOTAL_MAX_CHARS: z.coerce.number().int().positive().max(300_000).default(15_000),
  HOUDI_MEMORY_MAX_RESULTS: z.coerce.number().int().positive().max(50).default(6),
  HOUDI_MEMORY_SNIPPET_MAX_CHARS: z.coerce.number().int().positive().max(4000).default(320),
  HOUDI_MEMORY_MAX_INJECTED_CHARS: z.coerce.number().int().positive().max(50_000).default(2200),
  HOUDI_MEMORY_BACKEND: z.enum(["hybrid", "scan"]).default("hybrid"),
  HOUDI_SCHEDULE_FILE: z.string().trim().default("./houdi-schedule.json"),
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
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().trim().default("gpt-4o-mini"),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(8192).default(800),
  HOUDI_PROGRESS_NOTICES: z.string().optional(),
  OPENAI_AUDIO_MODEL: z.string().trim().default("whisper-1"),
  OPENAI_AUDIO_LANGUAGE: z.string().trim().optional(),
  OPENAI_AUDIO_MAX_FILE_BYTES: z.coerce.number().int().positive().max(50_000_000).default(20_000_000),
  HOUDI_FILE_MAX_FILE_BYTES: z.coerce.number().int().positive().max(100_000_000).default(50_000_000),
  HOUDI_IMAGE_MAX_FILE_BYTES: z.coerce.number().int().positive().max(50_000_000).default(20_000_000),
  HOUDI_DOC_MAX_FILE_BYTES: z.coerce.number().int().positive().max(100_000_000).default(25_000_000),
  HOUDI_DOC_MAX_TEXT_CHARS: z.coerce.number().int().positive().max(300_000).default(15_000),
  ENABLE_WEB_BROWSE: z.string().optional(),
  WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().positive().max(10).default(5),
  WEB_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(20_000),
  WEB_FETCH_MAX_BYTES: z.coerce.number().int().positive().max(10_000_000).default(2_000_000),
  WEB_CONTENT_MAX_CHARS: z.coerce.number().int().positive().max(200_000).default(15_000),
  ENABLE_GMAIL_ACCOUNT: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().trim().optional(),
  GMAIL_CLIENT_SECRET: z.string().trim().optional(),
  GMAIL_REFRESH_TOKEN: z.string().trim().optional(),
  GMAIL_ACCOUNT_EMAIL: z.string().trim().optional(),
  GMAIL_MAX_RESULTS: z.coerce.number().int().positive().max(100).default(10),
  ENABLE_LIM_CONTROL: z.string().optional(),
  LIM_APP_DIR: z.string().trim().optional(),
  LIM_APP_SERVICE: z.string().trim().optional(),
  LIM_TUNNEL_SERVICE: z.string().trim().optional(),
  LIM_LOCAL_HEALTH_URL: z.string().trim().optional(),
  LIM_PUBLIC_HEALTH_URL: z.string().trim().optional(),
  LIM_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).optional(),
  ENABLE_CONNECTOR_CONTROL: z.string().optional(),
  CONNECTOR_APP_DIR: z.string().trim().optional(),
  CONNECTOR_RETRIEVER_SERVICE: z.string().trim().optional(),
  CONNECTOR_CLOUDFLARED_SERVICE: z.string().trim().optional(),
  CONNECTOR_LOCAL_HEALTH_URL: z.string().trim().optional(),
  CONNECTOR_PUBLIC_HEALTH_URL: z.string().trim().optional(),
  CONNECTOR_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).optional(),
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

const env = EnvSchema.parse(process.env);

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
  scheduleFile: env.HOUDI_SCHEDULE_FILE,
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
  openAiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
  openAiModel: env.OPENAI_MODEL,
  openAiMaxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
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
  enableLimControl: parseBooleanFlag(env.ENABLE_LIM_CONTROL ?? env.ENABLE_CONNECTOR_CONTROL, false),
  limAppDir: path.resolve(process.cwd(), env.LIM_APP_DIR || env.CONNECTOR_APP_DIR || "./lim-app"),
  limAppService: env.LIM_APP_SERVICE || env.CONNECTOR_RETRIEVER_SERVICE || "houdi-lim-app.service",
  limTunnelService: env.LIM_TUNNEL_SERVICE || env.CONNECTOR_CLOUDFLARED_SERVICE || "houdi-lim-tunnel.service",
  limLocalHealthUrl: env.LIM_LOCAL_HEALTH_URL || env.CONNECTOR_LOCAL_HEALTH_URL || "http://127.0.0.1:3333/health",
  limPublicHealthUrl: env.LIM_PUBLIC_HEALTH_URL || env.CONNECTOR_PUBLIC_HEALTH_URL || "http://127.0.0.1:3333/health",
  limHealthTimeoutMs: env.LIM_HEALTH_TIMEOUT_MS ?? env.CONNECTOR_HEALTH_TIMEOUT_MS ?? 7000,
  localApiEnabled: parseBooleanFlag(env.HOUDI_LOCAL_API_ENABLED, true),
  localApiHost: env.HOUDI_LOCAL_API_HOST,
  localApiPort: env.HOUDI_LOCAL_API_PORT,
  localApiToken: env.HOUDI_LOCAL_API_TOKEN?.trim() || undefined,
  adminApprovalTtlSeconds: env.ADMIN_APPROVAL_TTL_SECONDS,
  auditLogPath: env.AUDIT_LOG_PATH,
  enableRebootCommand: parseBooleanFlag(env.ENABLE_REBOOT_COMMAND, false),
  rebootCommand: env.REBOOT_COMMAND,
};
