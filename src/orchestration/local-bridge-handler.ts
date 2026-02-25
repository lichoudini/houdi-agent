import type { IncomingMessage, ServerResponse } from "node:http";
import type { IncomingTextChatContext } from "./incoming-text-handler.js";

type BridgeRequestContext = {
  chatId: number;
  sessionKey?: string | null;
};

type IdempotencyReadResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

export type LocalBridgeHandlerDeps = {
  healthPath: string;
  messagePath: string;
  maxBodyBytes: number;
  localApiToken?: string;
  agentVersion: string;
  securityProfileName: string;
  observabilityIncrement: (name: string, value?: number, labels?: Record<string, string | number | boolean>) => void;
  observabilityTiming: (name: string, durationMs: number) => void;
  observabilitySnapshot: () => {
    counters: Array<Record<string, unknown>>;
    timings: unknown;
  };
  buildRuntimeHealthSnapshot: () => Promise<unknown>;
  writeJsonResponse: (res: ServerResponse, statusCode: number, payload: Record<string, unknown>) => void;
  isLocalBridgeAuthorized: (req: IncomingMessage, token?: string) => boolean;
  readHttpRequestBody: (req: IncomingMessage, maxBytes: number) => Promise<string>;
  parsePositiveInteger: (value: unknown) => number | undefined;
  resolveChatIdForBridgePayload: (params: {
    source?: string;
    chatId?: number;
    sessionKey?: string;
    channel?: string;
    threadTs?: string;
  }) => BridgeRequestContext;
  idempotencyNormalizeRequestId: (value: unknown) => string | null;
  idempotencyRead: (chatId: number, requestId: string) => IdempotencyReadResult | null;
  idempotencyTryAcquire: (chatId: number, requestId: string) => boolean;
  idempotencyRelease: (chatId: number, requestId: string) => void;
  idempotencySave: (chatId: number, requestId: string, value: IdempotencyReadResult) => void;
  getDefaultAllowedUserId: () => number | undefined;
  allowedUserIds: Set<number>;
  upsertSessionRouteMapping: (params: { sessionKey: string; chatId: number; source: string }) => void;
  truncateInline: (text: string, maxChars: number) => string;
  runInIncomingQueue: (params: {
    chatId: number;
    source: string;
    executor: () => Promise<void>;
  }) => Promise<void>;
  handleIncomingTextMessage: (params: {
    ctx: IncomingTextChatContext;
    text: string;
    source: string;
    userId?: number;
    persistUserTurn?: boolean;
    allowSlashPrefix?: boolean;
  }) => Promise<void>;
  isIncomingQueueOverflowError: (error: unknown) => boolean;
  logWarn: (message: string) => void;
};

export async function handleLocalBridgeHttpRequestWithDeps(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalBridgeHandlerDeps,
): Promise<void> {
  const requestStartedAt = Date.now();
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = (req.url?.split("?", 1)[0] ?? "/").trim() || "/";
  deps.observabilityIncrement("bridge.http.request", 1, { method, pathname });

  if (method === "GET" && pathname === deps.healthPath) {
    const metrics = deps.observabilitySnapshot();
    const health = await deps.buildRuntimeHealthSnapshot();
    deps.writeJsonResponse(res, 200, {
      ok: true,
      health,
      service: "houdi-local-bridge",
      version: deps.agentVersion,
      messagePath: deps.messagePath,
      securityProfile: deps.securityProfileName,
      metrics: {
        counters: metrics.counters.slice(-40),
        timings: metrics.timings,
      },
    });
    deps.observabilityTiming("bridge.http.request.latency_ms", Date.now() - requestStartedAt);
    return;
  }

  if (method !== "POST" || pathname !== deps.messagePath) {
    deps.writeJsonResponse(res, 404, {
      ok: false,
      error: "not_found",
    });
    return;
  }

  if (!deps.isLocalBridgeAuthorized(req, deps.localApiToken)) {
    deps.writeJsonResponse(res, 401, {
      ok: false,
      error: "unauthorized",
    });
    return;
  }

  let bodyRaw = "";
  try {
    bodyRaw = await deps.readHttpRequestBody(req, deps.maxBodyBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.writeJsonResponse(res, 400, {
      ok: false,
      error: `request_body_invalid: ${message}`,
    });
    return;
  }

  let payload: unknown;
  try {
    payload = bodyRaw ? (JSON.parse(bodyRaw) as unknown) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.writeJsonResponse(res, 400, {
      ok: false,
      error: `json_invalid: ${message}`,
    });
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    deps.writeJsonResponse(res, 400, {
      ok: false,
      error: "payload must be a JSON object",
    });
    return;
  }

  const record = payload as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    deps.writeJsonResponse(res, 400, {
      ok: false,
      error: "text is required",
    });
    return;
  }

  const bridgeChatId = deps.parsePositiveInteger(record.chatId);
  const bridgeSessionKeyRaw = typeof record.sessionKey === "string" ? record.sessionKey : undefined;
  const bridgeChannel = typeof record.channel === "string" ? record.channel : undefined;
  const bridgeThreadTs = typeof record.threadTs === "string" ? record.threadTs : undefined;
  const resolvedBridgeRoute = deps.resolveChatIdForBridgePayload({
    source: typeof record.source === "string" ? record.source : undefined,
    chatId: bridgeChatId,
    sessionKey: bridgeSessionKeyRaw,
    channel: bridgeChannel,
    threadTs: bridgeThreadTs,
  });
  const chatId = resolvedBridgeRoute.chatId;
  const sessionKey = resolvedBridgeRoute.sessionKey;

  const requestId = deps.idempotencyNormalizeRequestId(record.requestId);
  if (requestId) {
    const cached = deps.idempotencyRead(chatId, requestId);
    if (cached) {
      deps.writeJsonResponse(res, cached.statusCode, {
        ...cached.body,
        idempotent: true,
        requestId,
      });
      deps.observabilityIncrement("bridge.http.idempotency.hit");
      deps.observabilityTiming("bridge.http.request.latency_ms", Date.now() - requestStartedAt);
      return;
    }
    if (!deps.idempotencyTryAcquire(chatId, requestId)) {
      deps.writeJsonResponse(res, 409, {
        ok: false,
        error: "duplicate_in_flight",
        requestId,
      });
      deps.observabilityIncrement("bridge.http.idempotency.in_flight_reject");
      deps.observabilityTiming("bridge.http.request.latency_ms", Date.now() - requestStartedAt);
      return;
    }
  }

  const defaultAllowedUserId = deps.getDefaultAllowedUserId();
  const userId = deps.parsePositiveInteger(record.userId) ?? defaultAllowedUserId;

  if (typeof userId !== "number" || !deps.allowedUserIds.has(userId)) {
    if (requestId) {
      deps.idempotencyRelease(chatId, requestId);
    }
    deps.writeJsonResponse(res, 403, {
      ok: false,
      error: "userId is not authorized",
    });
    return;
  }

  const sourceCandidate = typeof record.source === "string" ? record.source.trim() : "";
  const source = sourceCandidate ? deps.truncateInline(sourceCandidate, 80) : "cli:bridge";
  if (sessionKey) {
    deps.upsertSessionRouteMapping({ sessionKey, chatId, source });
  }

  const replies: string[] = [];
  const ctx: IncomingTextChatContext = {
    chat: { id: chatId },
    from: { id: userId },
    ...(sessionKey ? { sessionKey } : {}),
    reply: async (textReply: string) => {
      replies.push(textReply);
      return undefined;
    },
    replyWithDocument: async (_document, options) => {
      const caption = options?.caption?.trim();
      replies.push(
        caption
          ? `${caption}\n[Adjunto no disponible por CLI. Pedimelo por Telegram.]`
          : "Adjunto no disponible por CLI. Pedimelo por Telegram.",
      );
      return undefined;
    },
  };

  try {
    await deps.runInIncomingQueue({
      chatId,
      source,
      executor: async () =>
        deps.handleIncomingTextMessage({
          ctx,
          text,
          source,
          userId,
          persistUserTurn: true,
          allowSlashPrefix: true,
        }),
    });

    deps.writeJsonResponse(res, 200, {
      ok: true,
      chatId,
      ...(sessionKey ? { sessionKey } : {}),
      userId,
      replies,
      ...(requestId ? { requestId } : {}),
    });
    deps.observabilityIncrement("bridge.http.message.ok");

    if (requestId) {
      deps.idempotencySave(chatId, requestId, {
        statusCode: 200,
        body: {
          ok: true,
          chatId,
          ...(sessionKey ? { sessionKey } : {}),
          userId,
          replies,
          requestId,
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logWarn(`Local bridge error: ${message}`);
    const isQueueOverflow = deps.isIncomingQueueOverflowError(error);
    const payloadError = {
      ok: false,
      error: message,
      ...(requestId ? { requestId } : {}),
    };
    deps.writeJsonResponse(res, isQueueOverflow ? 429 : 500, payloadError);
    deps.observabilityIncrement("bridge.http.message.error", 1, {
      kind: isQueueOverflow ? "queue_overflow" : "generic",
    });
    if (requestId) {
      deps.idempotencySave(chatId, requestId, {
        statusCode: isQueueOverflow ? 429 : 500,
        body: payloadError,
      });
    }
  } finally {
    if (requestId) {
      deps.idempotencyRelease(chatId, requestId);
    }
    deps.observabilityTiming("bridge.http.request.latency_ms", Date.now() - requestStartedAt);
  }
}
