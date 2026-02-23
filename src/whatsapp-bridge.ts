#!/usr/bin/env node

import crypto from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";
import dotenv from "dotenv";
import { chatIdFromSessionKey, normalizeSessionKey } from "./session-routing.js";
import { readHttpRequestBody, writeJsonResponse } from "./local-bridge-http.js";

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

type WhatsAppInboundMessage = {
  messageId: string;
  from: string;
  phoneNumberId: string;
  text: string;
  timestamp?: string;
};

type WhatsAppBridgeConfig = {
  host: string;
  port: number;
  webhookPath: string;
  verifyToken: string;
  accessToken: string;
  apiVersion: string;
  bridgeUserId: number;
  bridgeBaseUrl: string;
  bridgeHeaders: Record<string, string>;
  bodyMaxBytes: number;
  bridgeTimeoutMs: number;
  bridgeRetryCount: number;
  bridgeRetryDelayMs: number;
  replyChunkMaxChars: number;
  dedupeTtlMs: number;
  allowedFrom: Set<string>;
  appSecret?: string;
  sendBridgeErrorsToUser: boolean;
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

function parseCsvSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function normalizeWebhookPath(pathInput: string): string {
  const trimmed = pathInput.trim();
  if (!trimmed) {
    return "/webhook/whatsapp";
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/${trimmed}`;
}

function resolveBridgeUserId(): number {
  const explicit = process.env.WHATSAPP_BRIDGE_USER_ID?.trim() || process.env.SLACK_BRIDGE_USER_ID?.trim();
  if (explicit) {
    if (!/^\d+$/.test(explicit)) {
      throw new Error(`WHATSAPP_BRIDGE_USER_ID inválido: ${explicit}`);
    }
    return Number.parseInt(explicit, 10);
  }

  const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^\d+$/.test(entry));

  if (allowed.length === 0) {
    throw new Error(
      "No pude resolver userId autorizado para bridge. Define WHATSAPP_BRIDGE_USER_ID/SLACK_BRIDGE_USER_ID o TELEGRAM_ALLOWED_USER_IDS.",
    );
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

function buildConfig(): WhatsAppBridgeConfig {
  return {
    host: process.env.WHATSAPP_BRIDGE_HOST?.trim() || "0.0.0.0",
    port: parseNumericEnv("WHATSAPP_BRIDGE_PORT", 3390),
    webhookPath: normalizeWebhookPath(process.env.WHATSAPP_WEBHOOK_PATH || "/webhook/whatsapp"),
    verifyToken: readRequiredEnv("WHATSAPP_VERIFY_TOKEN"),
    accessToken: readRequiredEnv("WHATSAPP_ACCESS_TOKEN"),
    apiVersion: process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v22.0",
    bridgeUserId: resolveBridgeUserId(),
    bridgeBaseUrl: buildBridgeBaseUrl(),
    bridgeHeaders: buildBridgeHeaders(),
    bodyMaxBytes: parseNumericEnv("WHATSAPP_WEBHOOK_MAX_BYTES", 1_000_000),
    bridgeTimeoutMs: parseNumericEnv("WHATSAPP_BRIDGE_TIMEOUT_MS", 90_000),
    bridgeRetryCount: parseNumericEnv("WHATSAPP_BRIDGE_RETRY_COUNT", 2),
    bridgeRetryDelayMs: parseNumericEnv("WHATSAPP_BRIDGE_RETRY_DELAY_MS", 500),
    replyChunkMaxChars: parseNumericEnv("WHATSAPP_REPLY_CHUNK_MAX_CHARS", 1400),
    dedupeTtlMs: parseNumericEnv("WHATSAPP_EVENT_DEDUPE_TTL_MS", 120_000),
    allowedFrom: parseCsvSet(process.env.WHATSAPP_ALLOWED_FROM),
    appSecret: process.env.WHATSAPP_APP_SECRET?.trim() || undefined,
    sendBridgeErrorsToUser: parseBooleanEnv("WHATSAPP_SEND_BRIDGE_ERRORS_TO_USER", true),
  };
}

function sanitizeSessionSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}

function resolveWhatsAppSessionKey(phoneNumberId: string, from: string): string {
  const candidate = `whatsapp:${sanitizeSessionSegment(phoneNumberId)}:chat:${sanitizeSessionSegment(from)}`;
  return normalizeSessionKey(candidate) || `whatsapp:chat:${sanitizeSessionSegment(from)}`;
}

function isAllowedSender(from: string, allowlist: Set<string>): boolean {
  if (allowlist.size === 0 || allowlist.has("*")) {
    return true;
  }
  return allowlist.has(from.trim());
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

function splitReplyChunks(text: string, maxChars: number): string[] {
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

function writeTextResponse(res: ServerResponse, statusCode: number, text: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text, "utf8").toString(),
  });
  res.end(text);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function extractInboundText(message: Record<string, unknown>): string {
  const type = typeof message.type === "string" ? message.type.trim().toLowerCase() : "";
  if (type === "text") {
    const body = (message.text as { body?: unknown } | undefined)?.body;
    return typeof body === "string" ? body.trim() : "";
  }
  if (type === "button") {
    const body = (message.button as { text?: unknown } | undefined)?.text;
    return typeof body === "string" ? body.trim() : "";
  }
  if (type === "interactive") {
    const interactive = message.interactive as
      | { button_reply?: { title?: unknown }; list_reply?: { title?: unknown } }
      | undefined;
    const buttonTitle = interactive?.button_reply?.title;
    if (typeof buttonTitle === "string" && buttonTitle.trim()) {
      return buttonTitle.trim();
    }
    const listTitle = interactive?.list_reply?.title;
    if (typeof listTitle === "string" && listTitle.trim()) {
      return listTitle.trim();
    }
    return "";
  }
  if (["image", "video", "audio", "document", "sticker"].includes(type)) {
    const media = message[type] as { caption?: unknown } | undefined;
    const caption = typeof media?.caption === "string" ? media.caption.trim() : "";
    if (caption) {
      return `${caption}\n\n[adjunto ${type}]`;
    }
    return `[adjunto ${type}]`;
  }
  if (type === "location") {
    return "[ubicacion compartida]";
  }
  return "";
}

export function parseWhatsAppWebhookPayload(payload: unknown): WhatsAppInboundMessage[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const asRecord = payload as { entry?: unknown };
  const entries = Array.isArray(asRecord.entry) ? asRecord.entry : [];
  const output: WhatsAppInboundMessage[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const changes = Array.isArray((entry as { changes?: unknown }).changes)
      ? ((entry as { changes?: unknown }).changes as unknown[])
      : [];
    for (const change of changes) {
      if (!change || typeof change !== "object") {
        continue;
      }
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== "object") {
        continue;
      }
      const valueRecord = value as {
        metadata?: { phone_number_id?: unknown };
        messages?: unknown;
      };
      const phoneNumberId =
        typeof valueRecord.metadata?.phone_number_id === "string" ? valueRecord.metadata.phone_number_id.trim() : "";
      if (!phoneNumberId) {
        continue;
      }
      const messages = Array.isArray(valueRecord.messages) ? valueRecord.messages : [];
      for (const rawMessage of messages) {
        if (!rawMessage || typeof rawMessage !== "object") {
          continue;
        }
        const message = rawMessage as Record<string, unknown>;
        const messageId = typeof message.id === "string" ? message.id.trim() : "";
        const from = typeof message.from === "string" ? message.from.trim() : "";
        const text = extractInboundText(message);
        const timestamp = typeof message.timestamp === "string" ? message.timestamp.trim() : undefined;
        if (!messageId || !from || !text) {
          continue;
        }
        output.push({
          messageId,
          from,
          phoneNumberId,
          text,
          timestamp,
        });
      }
    }
  }

  return output;
}

export function verifyWhatsAppWebhookSignature(appSecret: string, body: string, headerValue: string | undefined): boolean {
  if (!appSecret.trim()) {
    return true;
  }
  const header = (headerValue || "").trim();
  if (!header || !header.startsWith("sha256=")) {
    return false;
  }
  const provided = header.slice("sha256=".length);
  const expected = crypto.createHmac("sha256", appSecret).update(body, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function callLocalBridgeOnce(params: {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  text: string;
  chatId: number;
  sessionKey: string;
  userId: number;
  requestId: string;
  source: string;
  channel: string;
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
        userId: params.userId,
        requestId: params.requestId,
        source: params.source,
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const payload = safeJsonParse(bodyText);

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
    sessionKey: string;
    userId: number;
    requestId: string;
    source: string;
    channel: string;
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

async function sendWhatsAppText(params: {
  accessToken: string;
  apiVersion: string;
  phoneNumberId: string;
  to: string;
  text: string;
}): Promise<void> {
  const endpoint = `https://graph.facebook.com/${params.apiVersion}/${params.phoneNumberId}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "text",
      text: {
        body: params.text,
        preview_url: false,
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph API ${response.status}: ${body.slice(0, 400)}`);
  }
}

async function sendWhatsAppReplies(params: {
  accessToken: string;
  apiVersion: string;
  phoneNumberId: string;
  to: string;
  replies: string[];
  chunkMaxChars: number;
}): Promise<void> {
  const joined = params.replies.join("\n\n").trim();
  const effective = joined || "(sin respuesta)";
  const chunks = splitReplyChunks(effective, params.chunkMaxChars);
  for (const chunk of chunks) {
    await sendWhatsAppText({
      accessToken: params.accessToken,
      apiVersion: params.apiVersion,
      phoneNumberId: params.phoneNumberId,
      to: params.to,
      text: chunk,
    });
  }
}

async function processInboundMessage(cfg: WhatsAppBridgeConfig, message: WhatsAppInboundMessage): Promise<void> {
  if (!isAllowedSender(message.from, cfg.allowedFrom)) {
    return;
  }

  const sessionKey = resolveWhatsAppSessionKey(message.phoneNumberId, message.from);
  const chatId = chatIdFromSessionKey(sessionKey);
  const requestId = `whatsapp:webhook:${message.messageId}`;

  const bridgeResponse = await callLocalBridgeWithRetries(
    {
      baseUrl: cfg.bridgeBaseUrl,
      headers: cfg.bridgeHeaders,
      timeoutMs: cfg.bridgeTimeoutMs,
      text: message.text,
      sessionKey,
      channel: message.phoneNumberId,
      chatId,
      userId: cfg.bridgeUserId,
      requestId,
      source: "whatsapp:webhook",
    },
    cfg.bridgeRetryCount,
    cfg.bridgeRetryDelayMs,
  );

  if (!bridgeResponse.ok) {
    if (cfg.sendBridgeErrorsToUser) {
      await sendWhatsAppText({
        accessToken: cfg.accessToken,
        apiVersion: cfg.apiVersion,
        phoneNumberId: message.phoneNumberId,
        to: message.from,
        text: `Error de bridge: ${bridgeResponse.error || "sin detalle"}`,
      });
    }
    return;
  }

  const replies = bridgeResponse.replies && bridgeResponse.replies.length > 0 ? bridgeResponse.replies : ["(sin respuesta)"];
  await sendWhatsAppReplies({
    accessToken: cfg.accessToken,
    apiVersion: cfg.apiVersion,
    phoneNumberId: message.phoneNumberId,
    to: message.from,
    replies,
    chunkMaxChars: cfg.replyChunkMaxChars,
  });
}

function parseUrlPath(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  return { pathname: url.pathname, query: url.searchParams };
}

function handleWebhookVerification(req: IncomingMessage, res: ServerResponse, cfg: WhatsAppBridgeConfig): boolean {
  const { pathname, query } = parseUrlPath(req);
  if (req.method !== "GET" || pathname !== cfg.webhookPath) {
    return false;
  }
  const mode = (query.get("hub.mode") || "").trim();
  const verifyToken = (query.get("hub.verify_token") || "").trim();
  const challenge = (query.get("hub.challenge") || "").trim();

  if (mode === "subscribe" && verifyToken === cfg.verifyToken && challenge) {
    writeTextResponse(res, 200, challenge);
    return true;
  }
  writeTextResponse(res, 403, "forbidden");
  return true;
}

async function handleWebhookMessage(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: WhatsAppBridgeConfig,
  dedupeCache: Map<string, number>,
): Promise<boolean> {
  const { pathname } = parseUrlPath(req);
  if (req.method !== "POST" || pathname !== cfg.webhookPath) {
    return false;
  }

  let body = "";
  try {
    body = await readHttpRequestBody(req, cfg.bodyMaxBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJsonResponse(res, 413, { ok: false, error: message });
    return true;
  }

  const signatureHeader = req.headers["x-hub-signature-256"];
  const signature =
    typeof signatureHeader === "string" ? signatureHeader : Array.isArray(signatureHeader) ? signatureHeader[0] : undefined;
  if (cfg.appSecret && !verifyWhatsAppWebhookSignature(cfg.appSecret, body, signature)) {
    writeJsonResponse(res, 401, { ok: false, error: "firma inválida" });
    return true;
  }

  const payload = safeJsonParse(body);
  if (!payload || typeof payload !== "object") {
    writeJsonResponse(res, 400, { ok: false, error: "payload inválido" });
    return true;
  }

  const messages = parseWhatsAppWebhookPayload(payload);
  writeJsonResponse(res, 200, { ok: true, accepted: messages.length });

  for (const message of messages) {
    const dedupeKey = `${message.phoneNumberId}:${message.messageId}`;
    if (isDuplicateEvent(dedupeCache, dedupeKey, cfg.dedupeTtlMs)) {
      continue;
    }
    processInboundMessage(cfg, message).catch((error) => {
      const err = error instanceof Error ? error.message : String(error);
      process.stderr.write(`WhatsApp bridge inbound error (${message.messageId}): ${err}\n`);
    });
  }
  return true;
}

async function main(): Promise<void> {
  const cfg = buildConfig();
  const dedupeCache = new Map<string, number>();

  const server = createServer(async (req, res) => {
    const { pathname } = parseUrlPath(req);
    if (pathname === "/health") {
      writeJsonResponse(res, 200, { ok: true, service: "houdi-whatsapp-bridge" });
      return;
    }

    if (handleWebhookVerification(req, res, cfg)) {
      return;
    }

    const handled = await handleWebhookMessage(req, res, cfg, dedupeCache);
    if (handled) {
      return;
    }

    writeJsonResponse(res, 404, { ok: false, error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      resolve();
    });
  });

  process.stdout.write(
    [
      "WhatsApp bridge listo.",
      `- webhook: http://${cfg.host}:${cfg.port}${cfg.webhookPath}`,
      `- local bridge: ${cfg.bridgeBaseUrl}/internal/cli/message`,
      `- bridge userId: ${cfg.bridgeUserId}`,
      `- allowed from: ${cfg.allowedFrom.size > 0 ? [...cfg.allowedFrom].join(", ") : "(all)"}`,
      `- signature check: ${cfg.appSecret ? "on" : "off"}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error WhatsApp bridge: ${message}\n`);
    process.exit(1);
  });
}
