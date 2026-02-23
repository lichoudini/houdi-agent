#!/usr/bin/env node

import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { App } from "@slack/bolt";
import { buildSlackSessionKey, chatIdFromSessionKey } from "./session-routing.js";

dotenv.config();

type LocalBridgeSuccess = {
  ok: true;
  replies?: string[];
  error?: string;
};

type LocalBridgeError = {
  ok: false;
  error?: string;
};

type LocalBridgeResponse = LocalBridgeSuccess | LocalBridgeError;

type SlackMessageEvent = {
  type?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackMessageFile[];
};

type SlackMessageFile = {
  id?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
};

type SlackBridgeConfig = {
  slackBotToken: string;
  slackAppToken: string;
  bridgeUserId: number;
  bridgeBaseUrl: string;
  bridgeHeaders: Record<string, string>;
  requireMentionInChannels: boolean;
  bridgeTimeoutMs: number;
  bridgeRetryCount: number;
  bridgeRetryDelayMs: number;
  slackChunkChars: number;
  enableStatusReactions: boolean;
  enableSnippetFallback: boolean;
  snippetThresholdChars: number;
  dedupeTtlMs: number;
  slashCommand: string;
  slashEphemeral: boolean;
  allowedSlackUsers: Set<string>;
  allowedSlackChannels: Set<string>;
  maxAttachmentBytes: number;
};

type SavedSlackAttachment = {
  relPath: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
};

type ThreadAttachmentContext = {
  saved: SavedSlackAttachment[];
  updatedAt: number;
};

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta variable requerida: ${name}`);
  }
  return value;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Valor inválido en ${name}: ${raw}`);
}

function parseNumericEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Valor inválido en ${name}: ${raw}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Valor inválido en ${name}: ${raw}`);
  }
  return parsed;
}

function parseNumericEnvWithRange(name: string, defaultValue: number, minValue: number, maxValue: number): number {
  const value = parseNumericEnv(name, defaultValue);
  if (value < minValue || value > maxValue) {
    throw new Error(`Valor fuera de rango en ${name}: ${value}`);
  }
  return value;
}

function parseCsvSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function resolveBridgeUserId(): number {
  const explicit = process.env.SLACK_BRIDGE_USER_ID?.trim();
  if (explicit) {
    if (!/^\d+$/.test(explicit)) {
      throw new Error(`SLACK_BRIDGE_USER_ID inválido: ${explicit}`);
    }
    return Number.parseInt(explicit, 10);
  }

  const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^\d+$/.test(entry));

  if (allowed.length === 0) {
    throw new Error("No pude resolver userId autorizado para bridge. Define SLACK_BRIDGE_USER_ID o TELEGRAM_ALLOWED_USER_IDS.");
  }

  return Number.parseInt(allowed[0]!, 10);
}

function buildBridgeBaseUrl(): string {
  const host = process.env.HOUDI_LOCAL_API_HOST?.trim() || "127.0.0.1";
  const portRaw = process.env.HOUDI_LOCAL_API_PORT?.trim() || "3210";
  if (!/^\d+$/.test(portRaw)) {
    throw new Error(`HOUDI_LOCAL_API_PORT inválido: ${portRaw}`);
  }
  return `http://${host}:${portRaw}`;
}

function buildBridgeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = process.env.HOUDI_LOCAL_API_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function removeSlackMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function resolveChatIdForEvent(event: { channel?: string; threadTs?: string }): number {
  const sessionKey = buildSlackSessionKey(event.channel, event.threadTs) ?? "slack:unknown:thread:main";
  return chatIdFromSessionKey(sessionKey);
}

function resolveSessionKeyForEvent(event: { channel?: string; threadTs?: string }): string {
  return buildSlackSessionKey(event.channel, event.threadTs) ?? "slack:unknown:thread:main";
}

function resolveRequestId(prefix: string, channel?: string, ts?: string): string {
  const resolvedChannel = channel?.trim() || "unknown";
  const resolvedTs = ts?.trim() || String(Date.now());
  return `${prefix}:${resolvedChannel}:${resolvedTs}`;
}

function splitSlackChunks(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let cursor = normalized;
  while (cursor.length > maxChars) {
    let cut = cursor.lastIndexOf("\n", maxChars);
    if (cut <= maxChars * 0.3) {
      cut = cursor.lastIndexOf(" ", maxChars);
    }
    if (cut <= maxChars * 0.3) {
      cut = maxChars;
    }
    chunks.push(cursor.slice(0, cut).trim());
    cursor = cursor.slice(cut).trim();
  }
  if (cursor) {
    chunks.push(cursor);
  }
  return chunks;
}

function sanitizeFileName(raw: string): string {
  const base = path.basename(raw || "archivo");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "");
  return cleaned || "archivo";
}

function inferFileExtension(fileName: string, mimeType: string): string {
  const ext = path.extname(fileName).trim().toLowerCase();
  if (ext) {
    return ext;
  }
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "text/plain") return ".txt";
  return "";
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

function makeAttachmentPath(kind: "image" | "file", originalName: string, mimeType: string): { fullPath: string; relPath: string } {
  const rootDir = path.join(process.cwd(), "workspace", kind === "image" ? "images" : "files");
  const safeName = sanitizeFileName(originalName || "archivo");
  const ext = inferFileExtension(safeName, mimeType);
  const base = ext ? safeName.slice(0, Math.max(1, safeName.length - ext.length)) : safeName;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const finalName = `${stamp}-${rand}-${base}${ext}`;
  const fullPath = path.join(rootDir, finalName);
  const relPath = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
  return { fullPath, relPath };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableBridgeError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("payload inválido") ||
    normalized.includes("payload invalid")
  ) {
    return false;
  }
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("network") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("429") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("saturada")
  );
}

function computeRetryDelayMs(baseMs: number, attempt: number): number {
  const exp = Math.max(0, attempt);
  const scaled = Math.min(30_000, baseMs * 2 ** exp);
  const jitter = Math.floor(Math.random() * Math.max(50, Math.floor(baseMs / 2)));
  return scaled + jitter;
}

async function callLocalBridgeOnce(params: {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  text: string;
  chatId: number;
  sessionKey?: string;
  channel?: string;
  threadTs?: string;
  userId: number;
  requestId: string;
  source: string;
}): Promise<LocalBridgeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, params.timeoutMs);

  try {
    const response = await fetch(`${params.baseUrl}/internal/cli/message`, {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify({
        text: params.text,
        chatId: params.chatId,
        sessionKey: params.sessionKey,
        channel: params.channel,
        threadTs: params.threadTs,
        userId: params.userId,
        requestId: params.requestId,
        source: params.source,
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let payload: unknown = {};
    if (bodyText.trim()) {
      try {
        payload = JSON.parse(bodyText) as unknown;
      } catch {
        payload = {};
      }
    }

    if (!response.ok) {
      const errorFromPayload =
        payload && typeof payload === "object" && "error" in payload ? String((payload as { error?: unknown }).error) : "";
      return {
        ok: false,
        error: `Bridge HTTP ${response.status}${errorFromPayload ? `: ${errorFromPayload}` : ""}`,
      };
    }

    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        error: "Bridge devolvió payload inválido.",
      };
    }

    const asRecord = payload as { ok?: unknown; replies?: unknown; error?: unknown };
    if (asRecord.ok !== true) {
      return {
        ok: false,
        error: typeof asRecord.error === "string" ? asRecord.error : "Bridge devolvió ok=false.",
      };
    }

    const replies = Array.isArray(asRecord.replies)
      ? asRecord.replies.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
      : [];
    return {
      ok: true,
      replies,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `No pude conectar al local bridge: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callLocalBridgeWithRetries(
  params: {
    baseUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
    text: string;
    chatId: number;
    sessionKey?: string;
    channel?: string;
    threadTs?: string;
    userId: number;
    requestId: string;
    source: string;
  },
  retryCount: number,
  retryDelayMs: number,
): Promise<LocalBridgeResponse> {
  let attempt = 0;
  let lastError: string | undefined;
  while (attempt <= retryCount) {
    const response = await callLocalBridgeOnce(params);
    if (response.ok) {
      return response;
    }
    lastError = response.error;
    if (!isRetryableBridgeError(lastError || "")) {
      break;
    }
    if (attempt === retryCount) {
      break;
    }
    await sleep(computeRetryDelayMs(retryDelayMs, attempt));
    attempt += 1;
  }
  return {
    ok: false,
    error: lastError || "Bridge falló sin detalle.",
  };
}

function buildConfig(): SlackBridgeConfig {
  return {
    slackBotToken: readRequiredEnv("SLACK_BOT_TOKEN"),
    slackAppToken: readRequiredEnv("SLACK_APP_TOKEN"),
    bridgeUserId: resolveBridgeUserId(),
    bridgeBaseUrl: buildBridgeBaseUrl(),
    bridgeHeaders: buildBridgeHeaders(),
    requireMentionInChannels: parseBooleanEnv("SLACK_REQUIRE_MENTION_IN_CHANNELS", true),
    bridgeTimeoutMs: parseNumericEnv("SLACK_BRIDGE_TIMEOUT_MS", 90_000),
    bridgeRetryCount: parseNumericEnv("SLACK_BRIDGE_RETRY_COUNT", 2),
    bridgeRetryDelayMs: parseNumericEnv("SLACK_BRIDGE_RETRY_DELAY_MS", 500),
    slackChunkChars: parseNumericEnv("SLACK_REPLY_CHUNK_MAX_CHARS", 3500),
    enableStatusReactions: parseBooleanEnv("SLACK_ENABLE_STATUS_REACTIONS", true),
    enableSnippetFallback: parseBooleanEnv("SLACK_ENABLE_FILE_SNIPPET_FALLBACK", true),
    snippetThresholdChars: parseNumericEnv("SLACK_SNIPPET_THRESHOLD_CHARS", 12_000),
    dedupeTtlMs: parseNumericEnv("SLACK_EVENT_DEDUPE_TTL_MS", 120_000),
    slashCommand: process.env.SLACK_SLASH_COMMAND?.trim() || "houdi",
    slashEphemeral: parseBooleanEnv("SLACK_SLASH_EPHEMERAL", true),
    allowedSlackUsers: parseCsvSet(process.env.SLACK_ALLOWED_USER_IDS),
    allowedSlackChannels: parseCsvSet(process.env.SLACK_ALLOWED_CHANNEL_IDS),
    maxAttachmentBytes: parseNumericEnvWithRange("SLACK_MAX_ATTACHMENT_BYTES", 25 * 1024 * 1024, 1024, 200 * 1024 * 1024),
  };
}

async function resolveSlackFileDownloadUrl(app: App, file: SlackMessageFile): Promise<string> {
  if (file.url_private_download?.trim()) {
    return file.url_private_download.trim();
  }
  const fileId = file.id?.trim();
  if (!fileId) {
    throw new Error("Archivo Slack sin id/url_private_download");
  }
  const info = await app.client.files.info({ file: fileId });
  const enriched = info.file as { url_private_download?: string } | undefined;
  const url = enriched?.url_private_download?.trim();
  if (!url) {
    throw new Error(`No pude resolver URL de descarga para file=${fileId}`);
  }
  return url;
}

async function downloadSlackAttachment(app: App, token: string, file: SlackMessageFile, maxBytes: number): Promise<SavedSlackAttachment> {
  const mimeType = (file.mimetype || "application/octet-stream").trim().toLowerCase();
  const kind: "image" | "file" = isImageMimeType(mimeType) ? "image" : "file";
  const downloadUrl = await resolveSlackFileDownloadUrl(app, file);
  const response = await fetch(downloadUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`No pude descargar adjunto (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length <= 0) {
    throw new Error("Adjunto vacío");
  }
  if (buffer.length > maxBytes) {
    throw new Error(`Adjunto supera límite (${buffer.length} bytes > ${maxBytes})`);
  }

  const fileName = file.name?.trim() || `slack-file-${Date.now()}`;
  const { fullPath, relPath } = makeAttachmentPath(kind, fileName, mimeType);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, buffer);
  return { relPath, mimeType, size: buffer.length, kind };
}

async function materializeSlackAttachments(
  app: App,
  token: string,
  files: SlackMessageFile[],
  maxBytes: number,
): Promise<SavedSlackAttachment[]> {
  const saved: SavedSlackAttachment[] = [];
  for (const file of files) {
    try {
      const one = await downloadSlackAttachment(app, token, file, maxBytes);
      saved.push(one);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Slack adjunto ignorado: ${message}\n`);
    }
  }
  return saved;
}

function buildAttachmentContextPrompt(saved: SavedSlackAttachment[]): string {
  if (saved.length === 0) {
    return "";
  }
  const lines = saved.map((item, idx) => `${idx + 1}. ${item.relPath} (${item.mimeType}, ${item.size} bytes)`);
  return `Archivos adjuntos recibidos desde Slack:\n${lines.join("\n")}`;
}

function shouldReuseAttachmentContext(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized.length <= 24) {
    return true;
  }
  return /analiz|resum|leer|revis|describ|extrae|interpret|tradu|que ves|que dice|procesa|explic/.test(normalized);
}

function cleanupAttachmentContextCache(cache: Map<string, ThreadAttachmentContext>, ttlMs: number): void {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.updatedAt > ttlMs) {
      cache.delete(key);
    }
  }
}

function cleanupDedupeCache(cache: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of cache.entries()) {
    if (expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function isDuplicateEvent(cache: Map<string, number>, dedupeKey: string, ttlMs: number): boolean {
  const now = Date.now();
  cleanupDedupeCache(cache, now);
  const expires = cache.get(dedupeKey);
  if (typeof expires === "number" && expires > now) {
    return true;
  }
  cache.set(dedupeKey, now + ttlMs);
  return false;
}

async function safeReaction(
  app: App,
  emoji: string,
  channel: string,
  timestamp: string,
): Promise<void> {
  try {
    await app.client.reactions.add({
      channel,
      timestamp,
      name: emoji,
    });
  } catch {
    // reaction scopes are optional
  }
}

async function safeReactionRemove(
  app: App,
  emoji: string,
  channel: string,
  timestamp: string,
): Promise<void> {
  try {
    await app.client.reactions.remove({
      channel,
      timestamp,
      name: emoji,
    });
  } catch {
    // ignore
  }
}

async function postSlackReplies(params: {
  app: App;
  channel: string;
  threadTs?: string;
  replies: string[];
  chunkChars: number;
  enableSnippetFallback: boolean;
  snippetThresholdChars: number;
}): Promise<void> {
  const text = params.replies.join("\n\n").trim();
  if (!text) {
    await params.app.client.chat.postMessage({
      channel: params.channel,
      thread_ts: params.threadTs,
      text: "(sin respuesta)",
    });
    return;
  }

  if (params.enableSnippetFallback && text.length >= params.snippetThresholdChars) {
    try {
      if (params.threadTs) {
        await params.app.client.files.uploadV2({
          channel_id: params.channel,
          thread_ts: params.threadTs,
          filename: `houdi-response-${Date.now()}.txt`,
          title: "Houdi response",
          content: text,
        });
      } else {
        await params.app.client.files.uploadV2({
          channel_id: params.channel,
          filename: `houdi-response-${Date.now()}.txt`,
          title: "Houdi response",
          content: text,
        });
      }
      return;
    } catch {
      // fallback to chat chunks
    }
  }

  for (const reply of params.replies) {
    const chunks = splitSlackChunks(reply, params.chunkChars);
    for (const chunk of chunks) {
      await params.app.client.chat.postMessage({
        channel: params.channel,
        thread_ts: params.threadTs,
        text: chunk,
      });
    }
  }
}

async function main(): Promise<void> {
  const cfg = buildConfig();
  const app = new App({
    token: cfg.slackBotToken,
    appToken: cfg.slackAppToken,
    socketMode: true,
  });

  const auth = await app.client.auth.test({ token: cfg.slackBotToken });
  const botUserId = auth.user_id?.trim() || "";
  const dedupeCache = new Map<string, number>();
  const attachmentContextCache = new Map<string, ThreadAttachmentContext>();
  const attachmentContextTtlMs = 2 * 60 * 60 * 1000;

  const processInbound = async (params: {
    source: string;
    text: string;
    channel: string;
    messageTs: string;
    threadTs?: string;
    requestId: string;
    files?: SlackMessageFile[];
  }): Promise<void> => {
    const normalizedText = removeSlackMentions(params.text);
    const stableThreadRef = params.threadTs || "main";
    const contextKey = `${params.channel}:${stableThreadRef}`;
    cleanupAttachmentContextCache(attachmentContextCache, attachmentContextTtlMs);
    const incomingAttachments =
      params.files && params.files.length > 0
        ? await materializeSlackAttachments(app, cfg.slackBotToken, params.files, cfg.maxAttachmentBytes)
        : [];
    if (incomingAttachments.length > 0) {
      attachmentContextCache.set(contextKey, { saved: incomingAttachments, updatedAt: Date.now() });
    }
    const hasIncomingImages = incomingAttachments.some((item) => item.kind === "image");
    if (hasIncomingImages) {
      await app.client.chat.postMessage({
        channel: params.channel,
        thread_ts: params.threadTs || params.messageTs,
        text: "✅ La imagen fue guardada.",
      });
      if (cfg.enableStatusReactions) {
        await safeReaction(app, "white_check_mark", params.channel, params.messageTs);
      }
      return;
    }
    const cachedAttachments = attachmentContextCache.get(contextKey)?.saved || [];
    const savedAttachments =
      incomingAttachments.length > 0
        ? incomingAttachments
        : cachedAttachments.length > 0 && shouldReuseAttachmentContext(normalizedText)
          ? cachedAttachments
          : [];
    const attachmentBlock = buildAttachmentContextPrompt(savedAttachments);
    const effectiveText =
      normalizedText && attachmentBlock
        ? `${normalizedText}\n\n${attachmentBlock}`
        : normalizedText
          ? normalizedText
          : attachmentBlock
            ? savedAttachments.some((item) => item.kind === "image")
              ? `Analiza estas imágenes y responde en español.\n\n${attachmentBlock}`
              : `Lee y resume estos archivos adjuntos.\n\n${attachmentBlock}`
            : "";

    if (!effectiveText) {
      return;
    }

    if (cfg.enableStatusReactions) {
      await safeReaction(app, "hourglass_flowing_sand", params.channel, params.messageTs);
    }

    const bridgeResponse = await callLocalBridgeWithRetries(
      {
        baseUrl: cfg.bridgeBaseUrl,
        headers: cfg.bridgeHeaders,
        timeoutMs: cfg.bridgeTimeoutMs,
        text: effectiveText,
        sessionKey: resolveSessionKeyForEvent({ channel: params.channel, threadTs: params.threadTs }),
        channel: params.channel,
        threadTs: params.threadTs,
        chatId: resolveChatIdForEvent({ channel: params.channel, threadTs: params.threadTs }),
        userId: cfg.bridgeUserId,
        requestId: params.requestId,
        source: params.source,
      },
      cfg.bridgeRetryCount,
      cfg.bridgeRetryDelayMs,
    );

    if (cfg.enableStatusReactions) {
      await safeReactionRemove(app, "hourglass_flowing_sand", params.channel, params.messageTs);
    }

    if (!bridgeResponse.ok) {
      if (cfg.enableStatusReactions) {
        await safeReaction(app, "x", params.channel, params.messageTs);
      }
      await app.client.chat.postMessage({
        channel: params.channel,
        thread_ts: params.threadTs || params.messageTs,
        text: `Error de bridge: ${bridgeResponse.error || "sin detalle"}`,
      });
      return;
    }

    const replies = bridgeResponse.replies && bridgeResponse.replies.length > 0 ? bridgeResponse.replies : ["(sin respuesta)"];
    await postSlackReplies({
      app,
      channel: params.channel,
      threadTs: params.threadTs || params.messageTs,
      replies,
      chunkChars: cfg.slackChunkChars,
      enableSnippetFallback: cfg.enableSnippetFallback,
      snippetThresholdChars: cfg.snippetThresholdChars,
    });

    if (cfg.enableStatusReactions) {
      await safeReaction(app, "white_check_mark", params.channel, params.messageTs);
    }
  };

  app.event("app_mention", async ({ event }) => {
    const message = event as SlackMessageEvent;
    if (message.bot_id || !message.user) {
      return;
    }
    if (cfg.allowedSlackUsers.size > 0 && !cfg.allowedSlackUsers.has(message.user)) {
      return;
    }
    if (!message.channel || !message.ts) {
      return;
    }

    const dedupeKey = `mention:${message.channel}:${message.ts}`;
    if (isDuplicateEvent(dedupeCache, dedupeKey, cfg.dedupeTtlMs)) {
      return;
    }

    const text = message.text?.trim() || "";
    const files = Array.isArray(message.files) ? message.files : [];
    if (!text && files.length === 0) {
      return;
    }

    await processInbound({
      source: "slack:app_mention",
      text,
      channel: message.channel,
      messageTs: message.ts,
      threadTs: message.thread_ts,
      requestId: resolveRequestId("slack:mention", message.channel, message.ts),
      files,
    });
  });

  app.event("message", async ({ event }) => {
    const message = event as SlackMessageEvent;
    if ((message.subtype && message.subtype !== "file_share") || message.bot_id || !message.user) {
      return;
    }
    if (cfg.allowedSlackUsers.size > 0 && !cfg.allowedSlackUsers.has(message.user)) {
      return;
    }
    if (!message.channel || !message.ts) {
      return;
    }
    if (cfg.allowedSlackChannels.size > 0 && !cfg.allowedSlackChannels.has(message.channel)) {
      return;
    }

    const dedupeKey = `message:${message.channel}:${message.ts}`;
    if (isDuplicateEvent(dedupeCache, dedupeKey, cfg.dedupeTtlMs)) {
      return;
    }

    const channelType = message.channel_type || "";
    const isChannelLike = channelType === "channel" || channelType === "group";
    const isDirect = channelType === "im" || channelType === "mpim";
    if (!isDirect && !isChannelLike) {
      return;
    }

    const text = (message.text || "").trim();
    const files = Array.isArray(message.files) ? message.files : [];
    if (!text && files.length === 0) {
      return;
    }

    if (isChannelLike && cfg.requireMentionInChannels) {
      const hasMention = !!botUserId && text.includes(`<@${botUserId}>`);
      const threadRef = message.thread_ts || "main";
      cleanupAttachmentContextCache(attachmentContextCache, attachmentContextTtlMs);
      const hasThreadAttachmentContext = attachmentContextCache.has(`${message.channel}:${threadRef}`);
      if (!hasMention && files.length === 0 && !hasThreadAttachmentContext) {
        return;
      }
    }

    await processInbound({
      source: "slack:message",
      text,
      channel: message.channel,
      messageTs: message.ts,
      threadTs: message.thread_ts,
      requestId: resolveRequestId("slack:message", message.channel, message.ts),
      files,
    });
  });

  app.command(`/${cfg.slashCommand}`, async ({ command, ack, respond }) => {
    await ack();

    const channel = command.channel_id?.trim() || "";
    const ts = String(Date.now() / 1000);
    if (!channel) {
      await respond({
        text: "No pude resolver canal de Slack para este slash command.",
        response_type: "ephemeral",
      });
      return;
    }
    if (cfg.allowedSlackUsers.size > 0 && !cfg.allowedSlackUsers.has(command.user_id)) {
      await respond({
        text: "No estás autorizado para usar Houdi en este workspace.",
        response_type: "ephemeral",
      });
      return;
    }
    if (cfg.allowedSlackChannels.size > 0 && !cfg.allowedSlackChannels.has(channel)) {
      await respond({
        text: "Este canal no está autorizado para Houdi.",
        response_type: "ephemeral",
      });
      return;
    }

    const text = (command.text || "").trim();
    if (!text) {
      await respond({
        text: `Uso: /${cfg.slashCommand} <instrucción>`,
        response_type: "ephemeral",
      });
      return;
    }

    const bridgeResponse = await callLocalBridgeWithRetries(
      {
        baseUrl: cfg.bridgeBaseUrl,
        headers: cfg.bridgeHeaders,
        timeoutMs: cfg.bridgeTimeoutMs,
        text,
        sessionKey: resolveSessionKeyForEvent({ channel, threadTs: "slash" }),
        channel,
        threadTs: "slash",
        chatId: resolveChatIdForEvent({ channel, threadTs: "slash" }),
        userId: cfg.bridgeUserId,
        requestId: resolveRequestId("slack:slash", channel, ts),
        source: "slack:slash",
      },
      cfg.bridgeRetryCount,
      cfg.bridgeRetryDelayMs,
    );

    if (!bridgeResponse.ok) {
      await respond({
        text: `Error de bridge: ${bridgeResponse.error || "sin detalle"}`,
        response_type: "ephemeral",
      });
      return;
    }

    const replies = bridgeResponse.replies && bridgeResponse.replies.length > 0 ? bridgeResponse.replies : ["(sin respuesta)"];
    const joined = replies.join("\n\n").trim();
    if (joined.length <= cfg.slackChunkChars) {
      await respond({
        text: joined,
        response_type: cfg.slashEphemeral ? "ephemeral" : "in_channel",
      });
      return;
    }

    const chunks = splitSlackChunks(joined, cfg.slackChunkChars);
    for (const chunk of chunks) {
      await app.client.chat.postMessage({
        channel,
        text: chunk,
      });
    }
    await respond({
      text: "Respuesta enviada en mensajes separados por longitud.",
      response_type: "ephemeral",
    });
  });

  process.stdout.write(
    [
      "Slack bridge listo.",
      `- mode: socket`,
      `- local bridge: ${cfg.bridgeBaseUrl}/internal/cli/message`,
      `- bridge userId: ${cfg.bridgeUserId}`,
      `- mention-gating channels: ${cfg.requireMentionInChannels ? "on" : "off"}`,
      `- allowed slack users: ${cfg.allowedSlackUsers.size > 0 ? [...cfg.allowedSlackUsers].join(", ") : "(all)"}`,
      `- allowed slack channels: ${cfg.allowedSlackChannels.size > 0 ? [...cfg.allowedSlackChannels].join(", ") : "(all)"}`,
      `- status reactions: ${cfg.enableStatusReactions ? "on" : "off"}`,
      `- snippet fallback: ${cfg.enableSnippetFallback ? "on" : "off"}`,
      `- slash command: /${cfg.slashCommand}`,
      "",
    ].join("\n"),
  );

  await app.start();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error Slack bridge: ${message}\n`);
  process.exit(1);
});
