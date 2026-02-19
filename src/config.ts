import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().trim().min(1),
  AGENTS_DIR: z.string().trim().default("./agents"),
  DEFAULT_AGENT: z.string().trim().default("operator"),
  EXEC_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  MAX_STDIO_CHARS: z.coerce.number().int().positive().max(200_000).default(6000),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().trim().default("gpt-4o-mini"),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(8192).default(800),
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
  defaultAgent: env.DEFAULT_AGENT,
  execTimeoutMs: env.EXEC_TIMEOUT_MS,
  maxStdioChars: env.MAX_STDIO_CHARS,
  openAiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
  openAiModel: env.OPENAI_MODEL,
  openAiMaxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
  adminApprovalTtlSeconds: env.ADMIN_APPROVAL_TTL_SECONDS,
  auditLogPath: env.AUDIT_LOG_PATH,
  enableRebootCommand: parseBooleanFlag(env.ENABLE_REBOOT_COMMAND, false),
  rebootCommand: env.REBOOT_COMMAND,
};
