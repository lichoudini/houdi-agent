import type { InputFile } from "grammy";

export type IncomingTextChatContext = {
  chat: { id: number };
  from?: { id?: number };
  sessionKey?: string;
  reply: (text: string) => Promise<unknown>;
  replyWithDocument?: (document: InputFile, options?: { caption?: string }) => Promise<unknown>;
};

export type IntentClarificationSnapshot = {
  source: string;
  preferredRoute?: string;
  preferredAction?: string;
  missing?: string[];
};

type LoopDetection =
  | {
      stuck: false;
    }
  | {
      stuck: true;
      level: string;
      detector: string;
      count: number;
      message: string;
    };

export type IncomingTextHandlerParams = {
  ctx: IncomingTextChatContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn?: boolean;
  allowSlashPrefix?: boolean;
  replyReference?: {
    messageId?: number;
    fromName?: string;
    text: string;
  };
};

export type IncomingTextHandlerDeps = {
  upsertSessionRouteMapping: (params: { sessionKey: string; chatId: number; source: string }) => void;
  peekPendingIntentClarification: (chatId: number, userId?: number) => IntentClarificationSnapshot | null;
  shouldTreatAsClarificationReply: (params: {
    text: string;
    pending: IntentClarificationSnapshot;
    replyReferenceText?: string;
  }) => boolean;
  consumePendingIntentClarification: (chatId: number, userId?: number) => IntentClarificationSnapshot | null;
  buildClarificationFollowupText: (params: {
    pending: IntentClarificationSnapshot;
    replyText: string;
  }) => string;
  safeAudit: (event: {
    type: string;
    chatId: number;
    userId?: number;
    details?: Record<string, unknown>;
  }) => Promise<void>;
  shouldDropPendingClarificationForFreshIntent: (text: string) => boolean;
  clearPendingIntentClarification: (chatId: number, userId?: number) => void;
  truncateInline: (text: string, maxChars: number) => string;
  recordConversationLoop: (chatId: number, text: string) => LoopDetection;
  observabilityIncrement: (
    name: string,
    value: number,
    labels?: Record<string, string | number | boolean | null | undefined>,
  ) => void;
  replyCriticalLoop: (ctx: IncomingTextChatContext, text: string) => Promise<void>;
  maybeHandlePendingWorkspaceDeleteConfirmation: (params: {
    ctx: IncomingTextChatContext;
    text: string;
    source: string;
    userId?: number;
  }) => Promise<boolean>;
  maybeHandlePendingWorkspaceDeletePathInput: (params: {
    ctx: IncomingTextChatContext;
    text: string;
    source: string;
    userId?: number;
  }) => Promise<boolean>;
  maybeHandlePendingPlanOrApprovalConfirmation: (params: {
    ctx: IncomingTextChatContext;
    text: string;
    source: string;
    userId?: number;
  }) => Promise<boolean>;
  detectAgentVersionIntent: (text: string) => boolean;
  buildAgentVersionText: () => string;
  appendConversationTurn: (params: {
    chatId: number;
    userId?: number;
    role: "user" | "assistant";
    text: string;
    source: string;
  }) => Promise<void>;
  maybeHandleNaturalIntentPipeline: (params: {
    ctx: IncomingTextChatContext;
    text: string;
    source: string;
    userId?: number;
    persistUserTurn: boolean;
  }) => Promise<boolean>;
  shouldEnforceOperationalExecution: (chatId: number, text: string) => boolean;
  isAiShellModeEnabled: (chatId: number) => boolean;
  executeAiShellInstruction: (ctx: IncomingTextChatContext, instruction: string) => Promise<void>;
  isOpenAiConfigured: () => boolean;
  getOpenAiNotConfiguredMessage: (kind: "text") => string;
  getOpenAiProviderLabel: (chatId: number) => string;
  getOpenAiModelName: (chatId: number) => string;
  replyProgress: (ctx: IncomingTextChatContext, text: string) => Promise<void>;
  buildPromptContextForQuery: (query: string, options?: { chatId?: number }) => Promise<unknown>;
  askOpenAiForChat: (params: {
    chatId: number;
    prompt: string;
    context?: any;
  }) => Promise<string>;
  isEcoModeEnabled: (chatId: number) => boolean;
  isDetailedAnswerRequested: (text: string) => boolean;
  compactEcoFreeChatAnswer: (text: string) => string;
  replyLong: (ctx: IncomingTextChatContext, text: string) => Promise<void>;
};

export async function handleIncomingTextMessageWithDeps(
  params: IncomingTextHandlerParams,
  deps: IncomingTextHandlerDeps,
): Promise<void> {
  const text = params.text.trim();
  if (!text) {
    return;
  }

  const userId = params.userId ?? params.ctx.from?.id;
  const source = params.source;
  if (params.ctx.sessionKey) {
    deps.upsertSessionRouteMapping({
      sessionKey: params.ctx.sessionKey,
      chatId: params.ctx.chat.id,
      source,
    });
  }
  const persistUserTurn = params.persistUserTurn ?? true;
  const allowSlashPrefix = params.allowSlashPrefix ?? false;
  const replyReferenceText = params.replyReference?.text?.trim() ?? "";
  const hasReplyReference = replyReferenceText.length > 0;
  const textWithReplyReference = hasReplyReference
    ? [
        text,
        "",
        "[REPLY_REFERENCE]",
        `message_id=${params.replyReference?.messageId ?? "n/a"}`,
        `from=${deps.truncateInline(params.replyReference?.fromName?.trim() || "desconocido", 120)}`,
        `text=${deps.truncateInline(replyReferenceText, 3000)}`,
      ].join("\n")
    : text;
  let textForIntent = text;
  let clarificationApplied = false;
  const pendingClarification = deps.peekPendingIntentClarification(params.ctx.chat.id, userId);
  if (
    pendingClarification &&
    deps.shouldTreatAsClarificationReply({
      text,
      pending: pendingClarification,
      ...(replyReferenceText ? { replyReferenceText } : {}),
    })
  ) {
    const consumed = deps.consumePendingIntentClarification(params.ctx.chat.id, userId);
    if (consumed) {
      textForIntent = deps.buildClarificationFollowupText({
        pending: consumed,
        replyText: text,
      });
      clarificationApplied = true;
      void deps.safeAudit({
        type: "intent.clarification.consume",
        chatId: params.ctx.chat.id,
        userId,
        details: {
          source,
          pendingSource: consumed.source,
          preferredRoute: consumed.preferredRoute ?? null,
          preferredAction: consumed.preferredAction ?? null,
          missing: consumed.missing ?? null,
          textPreview: deps.truncateInline(text, 220),
        },
      });
    }
  } else if (pendingClarification && deps.shouldDropPendingClarificationForFreshIntent(text)) {
    deps.clearPendingIntentClarification(params.ctx.chat.id, userId);
    void deps.safeAudit({
      type: "intent.clarification.drop",
      chatId: params.ctx.chat.id,
      userId,
      details: {
        source,
        pendingSource: pendingClarification.source,
        reason: "fresh-intent-detected",
        textPreview: deps.truncateInline(text, 220),
      },
    });
  }
  const textForPersistence = clarificationApplied
    ? [textWithReplyReference, "[INTENT_CLARIFICATION_APPLIED]", deps.truncateInline(textForIntent, 3000)].join("\n\n")
    : textWithReplyReference;

  if (!allowSlashPrefix && text.startsWith("/")) {
    return;
  }

  const loopDetection = deps.recordConversationLoop(params.ctx.chat.id, text);
  if (loopDetection.stuck) {
    deps.observabilityIncrement("loop.detected", 1, {
      level: loopDetection.level,
      detector: loopDetection.detector,
      chatId: params.ctx.chat.id,
      source,
    });
    await deps.safeAudit({
      type: "loop.detected",
      chatId: params.ctx.chat.id,
      userId,
      details: {
        level: loopDetection.level,
        detector: loopDetection.detector,
        count: loopDetection.count,
        source,
      },
    });
    if (loopDetection.level === "critical") {
      await deps.replyCriticalLoop(
        params.ctx,
        `${loopDetection.message}\nSi quieres, reescribo la acción en un plan paso a paso para ejecutarla una sola vez.`,
      );
      return;
    }
  }

  const handledPendingWorkspaceDelete = await deps.maybeHandlePendingWorkspaceDeleteConfirmation({
    ctx: params.ctx,
    text,
    source,
    userId,
  });
  if (handledPendingWorkspaceDelete) {
    return;
  }

  const handledPendingWorkspaceDeletePath = await deps.maybeHandlePendingWorkspaceDeletePathInput({
    ctx: params.ctx,
    text,
    source,
    userId,
  });
  if (handledPendingWorkspaceDeletePath) {
    return;
  }

  const handledPendingPlanOrApproval = await deps.maybeHandlePendingPlanOrApprovalConfirmation({
    ctx: params.ctx,
    text,
    source,
    userId,
  });
  if (handledPendingPlanOrApproval) {
    return;
  }

  if (deps.detectAgentVersionIntent(text)) {
    const versionReply = deps.buildAgentVersionText();
    if (persistUserTurn) {
      await deps.appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId,
        role: "user",
        text: textForPersistence,
        source,
      });
    }
    await params.ctx.reply(versionReply);
    await deps.appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId,
      role: "assistant",
      text: versionReply,
      source: `${source}:version-intent`,
    });
    return;
  }

  const handledAsNaturalIntent = await deps.maybeHandleNaturalIntentPipeline({
    ctx: params.ctx,
    text: textForIntent,
    source,
    userId,
    persistUserTurn,
  });
  if (handledAsNaturalIntent) {
    return;
  }

  if (deps.shouldEnforceOperationalExecution(params.ctx.chat.id, textForIntent)) {
    if (persistUserTurn) {
      await deps.appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId,
        role: "user",
        text: textForPersistence,
        source,
      });
    }
    const responseText =
      "SAFE mode: detecté una orden operativa, pero no hubo ejecución confirmada. Reformulá con acción+parámetros o usa comando explícito (/workspace, /gmail, /schedule, /connector, /shell).";
    await params.ctx.reply(responseText);
    await deps.appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId,
      role: "assistant",
      text: responseText,
      source: `${source}:safe-operational-block`,
    });
    await deps.safeAudit({
      type: "intent.execution_required_not_executed",
      chatId: params.ctx.chat.id,
      userId,
      details: {
        source,
        safeMode: true,
        textPreview: deps.truncateInline(textForIntent, 220),
      },
    });
    return;
  }

  if (persistUserTurn) {
    await deps.appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId,
      role: "user",
      text: textForPersistence,
      source,
    });
  }

  if (deps.isAiShellModeEnabled(params.ctx.chat.id)) {
    try {
      await deps.executeAiShellInstruction(params.ctx, textWithReplyReference);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await params.ctx.reply(`Error en shell IA: ${message}`);
    }
    return;
  }

  if (!deps.isOpenAiConfigured()) {
    await params.ctx.reply(deps.getOpenAiNotConfiguredMessage("text"));
    return;
  }

  const model = deps.getOpenAiModelName(params.ctx.chat.id);
  await deps.replyProgress(
    params.ctx,
    `Pensando con IA (${deps.getOpenAiProviderLabel(params.ctx.chat.id)} - ${model})...`,
  );

  try {
    const promptContext = await deps.buildPromptContextForQuery(textWithReplyReference, {
      chatId: params.ctx.chat.id,
    });
    const answerRaw = await deps.askOpenAiForChat({
      chatId: params.ctx.chat.id,
      prompt: textWithReplyReference,
      context: promptContext,
    });
    const ecoEnabled = deps.isEcoModeEnabled(params.ctx.chat.id);
    const answer =
      ecoEnabled && !deps.isDetailedAnswerRequested(textWithReplyReference)
        ? deps.compactEcoFreeChatAnswer(answerRaw)
        : answerRaw;
    await deps.replyLong(params.ctx, answer);
    await deps.appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId,
      role: "assistant",
      text: answer,
      source,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`Error al consultar IA: ${message}`);
  }
}
