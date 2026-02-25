import type { NaturalIntentRouteName } from "./router-engine.js";

export type TypedRouteExtractionLike = {
  route: string;
  action?: string;
  required: string[];
  missing: string[];
  summary: string;
};

export type RoutedIntentHandler<Ctx> = {
  name: NaturalIntentRouteName;
  fn: (params: {
    ctx: Ctx;
    text: string;
    source: string;
    userId?: number;
    persistUserTurn: boolean;
  }) => Promise<boolean>;
};

export async function runRoutedIntentHandlers<Ctx extends { chat: { id: number }; reply: (text: string) => Promise<unknown> }>(
  params: {
    ctx: Ctx;
    text: string;
    source: string;
    userId?: number;
    persistUserTurn: boolean;
    routedHandlers: Array<RoutedIntentHandler<Ctx>>;
    semanticRouterSelected?: string | null;
    shadowRouterSelected?: string | null;
  },
  deps: {
    extractTypedRouteAction: (params: {
      route: NaturalIntentRouteName;
      text: string;
    }) => TypedRouteExtractionLike | null;
    isSensitiveIntentRoute: (route: NaturalIntentRouteName) => boolean;
    buildTypedRouteClarificationQuestion: (extraction: TypedRouteExtractionLike) => string;
    registerPendingIntentClarification: (params: {
      chatId: number;
      userId?: number;
      source: string;
      originalText: string;
      question: string;
      routeHints: NaturalIntentRouteName[];
      preferredRoute: NaturalIntentRouteName;
      preferredAction?: string;
      missing: string[];
    }) => void;
    onTypedMissing: (params: {
      handler: NaturalIntentRouteName;
      typedExtraction: TypedRouteExtractionLike;
    }) => Promise<void>;
    resolveDelegatedSubagent: (chatId: number, route: NaturalIntentRouteName) => string;
    getSubagentMode: (chatId: number) => "auto" | "pinned";
    isHandlerAllowedForSubagent: (subagent: string, route: NaturalIntentRouteName) => boolean;
    rememberSubagentDelegation: (chatId: number, subagent: string) => void;
    withReplyTracking: (ctx: Ctx, onReplyObserved: () => void) => Ctx;
    hasAssistantResponseSince: (chatId: number, sinceMs: number) => boolean;
    reliableReply: (ctx: Ctx, text: string, options: { source: string }) => Promise<void>;
    appendConversationTurn: (params: {
      chatId: number;
      userId?: number;
      role: "assistant";
      text: string;
      source: string;
    }) => Promise<void>;
    setIntentActionOutcome: (params: {
      chatId: number;
      route: NaturalIntentRouteName;
      source: string;
      success: boolean;
      error?: string;
    }) => void;
    consumeIntentActionOutcome: (params: {
      chatId: number;
      route: NaturalIntentRouteName;
      delegatedSource: string;
    }) => { success: boolean; error?: string } | null;
    safeAudit: (event: {
      type: string;
      chatId: number;
      userId?: number;
      details?: Record<string, unknown>;
    }) => Promise<void>;
    clearPendingIntentClarification: (chatId: number, userId?: number) => void;
    executeIntentHandlerResilient: (params: {
      route: NaturalIntentRouteName;
      source: string;
      executor: () => Promise<boolean>;
    }) => Promise<boolean>;
    onHandledSuccess: (params: {
      handler: NaturalIntentRouteName;
      typedExtraction: TypedRouteExtractionLike | null;
      delegatedSubagent: string;
      delegatedSource: string;
      actionSuccess: boolean;
      actionError: string | null;
    }) => Promise<void>;
  },
): Promise<boolean> {
  for (const handler of params.routedHandlers) {
    const typedExtraction = deps.extractTypedRouteAction({
      route: handler.name,
      text: params.text,
    });

    if (typedExtraction && typedExtraction.missing.length > 0 && deps.isSensitiveIntentRoute(handler.name)) {
      const clarificationQuestion = deps.buildTypedRouteClarificationQuestion(typedExtraction);
      deps.registerPendingIntentClarification({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        source: `${params.source}:typed-missing`,
        originalText: params.text,
        question: clarificationQuestion,
        routeHints: [handler.name],
        preferredRoute: handler.name,
        ...(typedExtraction.action ? { preferredAction: typedExtraction.action } : {}),
        missing: typedExtraction.missing,
      });
      await params.ctx.reply(clarificationQuestion);
      await deps.onTypedMissing({
        handler: handler.name,
        typedExtraction,
      });
      return true;
    }

    const delegatedSubagent = deps.resolveDelegatedSubagent(params.ctx.chat.id, handler.name);
    const pinnedMode = deps.getSubagentMode(params.ctx.chat.id) === "pinned";
    if (!deps.isHandlerAllowedForSubagent(delegatedSubagent, handler.name)) {
      if (pinnedMode) {
        await params.ctx.reply(
          `El subagente fijado (${delegatedSubagent}) no puede ejecutar el dominio ${handler.name}. Usa /subagent auto o /subagent set <nombre>.`,
        );
        return true;
      }
      continue;
    }

    deps.rememberSubagentDelegation(params.ctx.chat.id, delegatedSubagent);
    const delegatedSource =
      delegatedSubagent === "coordinator" ? params.source : `${params.source}:subagent:${delegatedSubagent}`;

    const handlerStartedAtMs = Date.now();
    let handlerObservedReply = false;
    const trackedCtx = deps.withReplyTracking(params.ctx, () => {
      handlerObservedReply = true;
    });

    const handled = await deps.executeIntentHandlerResilient({
      route: handler.name,
      source: delegatedSource,
      executor: async () =>
        handler.fn({
          ctx: trackedCtx,
          text: params.text,
          source: delegatedSource,
          userId: params.userId,
          persistUserTurn: params.persistUserTurn,
        }),
    });

    if (handled && handler.name !== "connector") {
      const gotResponse = handlerObservedReply || deps.hasAssistantResponseSince(params.ctx.chat.id, handlerStartedAtMs);
      if (!gotResponse) {
        const guardMessage = `No pude confirmar la respuesta del dominio ${handler.name}. Reintentá la instrucción en una sola frase.`;
        await deps.reliableReply(params.ctx, guardMessage, {
          source: `${delegatedSource}:reply-guard`,
        });
        await deps.appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "assistant",
          text: guardMessage,
          source: `${delegatedSource}:reply-guard`,
        });
        deps.setIntentActionOutcome({
          chatId: params.ctx.chat.id,
          route: handler.name,
          source: delegatedSource,
          success: false,
          error: "missing-assistant-response",
        });
        await deps.safeAudit({
          type: "intent.reply_guard.missing_response",
          chatId: params.ctx.chat.id,
          userId: params.userId,
          details: {
            source: params.source,
            route: handler.name,
            delegatedSource,
            startedAtMs: handlerStartedAtMs,
          },
        });
      }
    }

    const actionOutcome = deps.consumeIntentActionOutcome({
      chatId: params.ctx.chat.id,
      route: handler.name,
      delegatedSource,
    });
    const actionSuccess = actionOutcome ? actionOutcome.success : handled;
    const actionError = actionOutcome?.error ?? null;

    await deps.safeAudit({
      type: "intent.execution.result",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        route: handler.name,
        delegatedSource,
        handled,
        actionSuccess,
        actionError,
        semanticRouterSelected: params.semanticRouterSelected ?? null,
        shadowRouterSelected: params.shadowRouterSelected ?? null,
      },
    });

    if (!handled) {
      continue;
    }

    deps.clearPendingIntentClarification(params.ctx.chat.id, params.userId);
    await deps.onHandledSuccess({
      handler: handler.name,
      typedExtraction,
      delegatedSubagent,
      delegatedSource,
      actionSuccess,
      actionError,
    });
    return true;
  }

  return false;
}
