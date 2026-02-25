import type { NaturalIntentRouteName } from "./router-engine.js";

export type IntentHandler<Ctx> = {
  name: NaturalIntentRouteName;
  fn: (params: {
    ctx: Ctx;
    text: string;
    source: string;
    userId?: number;
    persistUserTurn: boolean;
  }) => Promise<boolean>;
};

export async function executeTopNMultiIntent<Ctx extends { chat: { id: number }; reply: (text: string) => Promise<unknown> }>(
  params: {
    ctx: Ctx;
    text: string;
    source: string;
    userId?: number;
    persistUserTurn: boolean;
    conversationalNarrative: boolean;
    ensembleTop: Array<{ name: NaturalIntentRouteName; score: number }>;
    routedHandlers: Array<IntentHandler<Ctx>>;
    shouldHandleRouteText: (route: NaturalIntentRouteName, text: string) => boolean;
  },
  deps: {
    appendConversationTurn: (params: {
      chatId: number;
      userId?: number;
      role: "user" | "assistant";
      text: string;
      source: string;
    }) => Promise<void>;
    replyLong: (ctx: Ctx, text: string) => Promise<void>;
    resolveDelegatedSubagent: (chatId: number, route: NaturalIntentRouteName) => string;
    isHandlerAllowedForSubagent: (subagent: string, route: NaturalIntentRouteName) => boolean;
    rememberSubagentDelegation: (chatId: number, subagent: string) => void;
    executeIntentHandlerResilient: (params: {
      route: NaturalIntentRouteName;
      source: string;
      executor: () => Promise<boolean>;
    }) => Promise<boolean>;
  },
): Promise<
  | {
      handled: false;
    }
  | {
      handled: true;
      executed: Array<{ handler: string; ok: boolean }>;
    }
> {
  if (
    params.conversationalNarrative ||
    params.source.includes(":multi-topn-") ||
    params.ensembleTop.length < 2
  ) {
    return { handled: false };
  }

  const topCandidateNames = params.ensembleTop
    .slice(0, 3)
    .map((item) => item.name)
    .filter((name, idx, arr) => arr.indexOf(name) === idx);

  const multiHandlers = params.routedHandlers.filter(
    (handler) => topCandidateNames.includes(handler.name) && params.shouldHandleRouteText(handler.name, params.text),
  );

  if (multiHandlers.length < 2) {
    return { handled: false };
  }

  if (params.persistUserTurn) {
    await deps.appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  await params.ctx.reply(`Detecté pedido multi-intent. Ejecutando ${multiHandlers.length} dominios en secuencia...`);

  const executed: Array<{ handler: string; ok: boolean }> = [];
  for (let idx = 0; idx < multiHandlers.length; idx += 1) {
    const handler = multiHandlers[idx]!;
    const delegatedSubagent = deps.resolveDelegatedSubagent(params.ctx.chat.id, handler.name);
    if (!deps.isHandlerAllowedForSubagent(delegatedSubagent, handler.name)) {
      executed.push({ handler: handler.name, ok: false });
      continue;
    }

    deps.rememberSubagentDelegation(params.ctx.chat.id, delegatedSubagent);
    const delegatedSource =
      delegatedSubagent === "coordinator"
        ? `${params.source}:multi-topn-${idx + 1}`
        : `${params.source}:multi-topn-${idx + 1}:subagent:${delegatedSubagent}`;

    const ok = await deps.executeIntentHandlerResilient({
      route: handler.name,
      source: delegatedSource,
      executor: async () =>
        handler.fn({
          ctx: params.ctx,
          text: params.text,
          source: delegatedSource,
          userId: params.userId,
          persistUserTurn: false,
        }),
    });
    executed.push({ handler: handler.name, ok });
  }

  const okCount = executed.filter((item) => item.ok).length;
  if (okCount === 0) {
    return { handled: false };
  }

  await deps.replyLong(
    params.ctx,
    [
      "Resumen multi-intent:",
      ...executed.map((item, idx) => `${idx + 1}. ${item.handler} => ${item.ok ? "OK" : "NO"}`),
    ].join("\n"),
  );

  return {
    handled: true,
    executed,
  };
}
