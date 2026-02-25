import type { IntentRouteName, SemanticRouteDecision } from "../intent-semantic-router.js";

export type NaturalIntentRouteName =
  | "self-maintenance"
  | "schedule"
  | "memory"
  | "gmail-recipients"
  | "gmail"
  | "workspace"
  | "document"
  | "web";

export type NaturalIntentHandlerName = NaturalIntentRouteName | "none";

export type IntentRouterFilterDecision = {
  allowed: string[];
  reason: string;
  strict: boolean;
  exhausted: boolean;
};

export type RouteLayerDecisionLike = {
  allowed: string[];
  reason: string;
  strict: boolean;
  exhausted: boolean;
  layers: string[];
};

export type HierarchicalIntentDecisionLike = {
  allowed: string[];
  reason: string;
  strict: boolean;
  exhausted: boolean;
  domains: string[];
};

export type RouterScoreBoosts = Record<string, number>;

export type ChatScopedRouterLike = {
  router: {
    route: (
      text: string,
      options?: {
        allowed?: IntentRouteName[];
        boosts?: RouterScoreBoosts;
        alphaOverrides?: Record<string, number>;
        topK?: number;
      },
    ) => SemanticRouteDecision | null;
  };
  abVariant: "A" | "B";
  canaryVersionId: string | null;
  effectiveAlpha: number;
  effectiveMinGap: number;
};

export type RoutingResolution = {
  hasMailContext: boolean;
  hasMemoryRecallCue: boolean;
  routeCandidates: NaturalIntentRouteName[];
  routerLayerDecision: RouteLayerDecisionLike | null;
  hierarchyDecision: HierarchicalIntentDecisionLike | null;
  effectiveHierarchyDecision: HierarchicalIntentDecisionLike | null;
  routeFilterDecision: IntentRouterFilterDecision | null;
  semanticAllowedCandidates: NaturalIntentRouteName[];
  strictNarrowingExhausted: boolean;
  routeScoreBoosts: RouterScoreBoosts;
  routerAbVariant: "A" | "B";
  routerCanaryVersion: string | null;
  semanticRouteDecision: SemanticRouteDecision | null;
  semanticCalibratedConfidence: number | null;
  semanticGap: number | null;
  shadowRouteDecision: SemanticRouteDecision | null;
  aiRouteDecision: { handler: NaturalIntentHandlerName; reason?: string } | null;
  ensembleTop: Array<{ name: NaturalIntentRouteName; score: number }>;
  routedHandlerNames: NaturalIntentRouteName[];
  chatScopedRouterMeta: {
    effectiveAlpha: number;
    effectiveMinGap: number;
  };
};

export type ResolveNaturalIntentRoutingDeps = {
  getIndexedListKind: (chatId: number) => "workspace-list" | "stored-files" | "web-results" | "gmail-list" | null;
  hasPendingWorkspaceDeleteConfirmation: (chatId: number) => boolean;
  applyIntentRouteLayers: (
    candidates: NaturalIntentRouteName[],
    params: {
      normalizedText: string;
      hasMailContext: boolean;
      hasMemoryRecallCue: boolean;
      indexedListKind: "workspace-list" | "stored-files" | "web-results" | "gmail-list" | null;
      hasPendingWorkspaceDelete: boolean;
    },
  ) => RouteLayerDecisionLike | null;
  narrowRouteCandidates: (
    candidates: NaturalIntentRouteName[],
    allowed: NaturalIntentRouteName[],
    options?: { strict?: boolean },
  ) => { allowed: NaturalIntentRouteName[]; exhausted: boolean };
  buildHierarchicalIntentDecision: (params: {
    normalizedText: string;
    candidates: NaturalIntentRouteName[];
    hasMailContext: boolean;
    hasMemoryRecallCue: boolean;
    indexedListKind: "workspace-list" | "stored-files" | "web-results" | "gmail-list" | null;
    hasPendingWorkspaceDelete: boolean;
  }) => HierarchicalIntentDecisionLike | null;
  buildIntentRouterContextFilter: (params: {
    chatId: number;
    text: string;
    candidates: NaturalIntentRouteName[];
    hasMailContext: boolean;
    hasMemoryRecallCue: boolean;
  }) => IntentRouterFilterDecision | null;
  buildIntentRouterScoreBoosts: (params: {
    chatId: number;
    text: string;
    hasMailContext: boolean;
    hasMemoryRecallCue: boolean;
  }) => RouterScoreBoosts;
  buildIntentRouterForChat: (chatId: number) => ChatScopedRouterLike;
  alphaOverrides: Record<string, number>;
  calibrateConfidence: (handler: string, score: number) => number;
  shouldRunIntentShadowMode: (chatId: number, text: string) => boolean;
  runShadowRoute: (params: {
    text: string;
    allowed: NaturalIntentRouteName[];
    boosts: RouterScoreBoosts;
    alphaOverrides: Record<string, number>;
    topK: number;
  }) => SemanticRouteDecision | null;
  shouldRunAiJudgeForEnsemble: (decision: SemanticRouteDecision | null) => boolean;
  classifyNaturalIntentRouteWithAi: (params: {
    chatId: number;
    text: string;
    candidates: NaturalIntentRouteName[];
  }) => Promise<{ handler: NaturalIntentHandlerName; reason?: string } | null>;
  rankIntentCandidatesWithEnsemble: (params: {
    candidates: NaturalIntentRouteName[];
    semanticAlternatives?: Array<{ name: string; score: number }>;
    aiSelected: NaturalIntentRouteName | null;
    layerAllowed: NaturalIntentRouteName[];
    contextualBoosts: RouterScoreBoosts;
    calibratedConfidence: number | null;
  }) => Array<{ name: string; score: number }>;
};

export async function resolveNaturalIntentRouting(
  params: {
    chatId: number;
    text: string;
    normalizedText: string;
    handlerNames: NaturalIntentRouteName[];
  },
  deps: ResolveNaturalIntentRoutingDeps,
): Promise<RoutingResolution> {
  const hasMailContext = /\b(correo|correos|mail|mails|email|emails|gmail|inbox|bandeja)\b/.test(params.normalizedText);
  const hasMemoryRecallCue =
    /\b(te\s+acordas|te\s+acuerdas|te\s+recordas|te\s+recuerdas|recordas|recuerdas|memoria|memory|habiamos\s+hablado|hablamos)\b/.test(
      params.normalizedText,
    );

  const routeCandidates = [...params.handlerNames];
  const isNaturalRouteName = (value: string): value is NaturalIntentRouteName => {
    return routeCandidates.includes(value as NaturalIntentRouteName);
  };
  const toNaturalCandidates = (values: string[]): NaturalIntentRouteName[] => {
    return values.filter((value): value is NaturalIntentRouteName => isNaturalRouteName(value));
  };
  const indexedListKind = deps.getIndexedListKind(params.chatId);
  const hasPendingWorkspaceDelete = deps.hasPendingWorkspaceDeleteConfirmation(params.chatId);

  const routerLayerDecision = deps.applyIntentRouteLayers(routeCandidates, {
    normalizedText: params.normalizedText,
    hasMailContext,
    hasMemoryRecallCue,
    indexedListKind,
    hasPendingWorkspaceDelete,
  });

  const layerAllowedCandidatesRaw = routerLayerDecision ? toNaturalCandidates(routerLayerDecision.allowed) : routeCandidates;
  const layerNarrowed = routerLayerDecision
    ? deps.narrowRouteCandidates(routeCandidates, layerAllowedCandidatesRaw, { strict: routerLayerDecision.strict })
    : { allowed: routeCandidates, exhausted: false };

  const layerAllowedCandidates = layerNarrowed.allowed;
  const hierarchyDecision = deps.buildHierarchicalIntentDecision({
    normalizedText: params.normalizedText,
    candidates: layerAllowedCandidates,
    hasMailContext,
    hasMemoryRecallCue,
    indexedListKind,
    hasPendingWorkspaceDelete,
  });

  const hierarchyAllowedCandidatesRaw = hierarchyDecision
    ? toNaturalCandidates(hierarchyDecision.allowed)
    : layerAllowedCandidates;
  const hierarchyNarrowed = hierarchyDecision
    ? deps.narrowRouteCandidates(layerAllowedCandidates, hierarchyAllowedCandidatesRaw, { strict: hierarchyDecision.strict })
    : { allowed: layerAllowedCandidates, exhausted: false };

  let effectiveHierarchyDecision = hierarchyDecision;
  let hierarchyAllowedCandidates = hierarchyNarrowed.allowed;

  if (
    hierarchyAllowedCandidates.length === 0 &&
    layerAllowedCandidates.length > 0 &&
    routerLayerDecision &&
    routerLayerDecision.strict
  ) {
    hierarchyAllowedCandidates = layerAllowedCandidates;
    effectiveHierarchyDecision = null;
  }

  const routeFilterDecision = deps.buildIntentRouterContextFilter({
    chatId: params.chatId,
    text: params.text,
    candidates: hierarchyAllowedCandidates,
    hasMailContext,
    hasMemoryRecallCue,
  });

  const semanticAllowedCandidates = routeFilterDecision
    ? toNaturalCandidates(routeFilterDecision.allowed)
    : hierarchyAllowedCandidates;

  const strictNarrowingExhausted = Boolean(
    (routerLayerDecision?.strict &&
      (routerLayerDecision.exhausted || layerNarrowed.exhausted || layerAllowedCandidates.length === 0)) ||
    (effectiveHierarchyDecision?.strict &&
      (effectiveHierarchyDecision.exhausted || hierarchyNarrowed.exhausted || hierarchyAllowedCandidates.length === 0)) ||
    (routeFilterDecision?.strict && (routeFilterDecision.exhausted || semanticAllowedCandidates.length === 0)),
  );

  const routeScoreBoosts = deps.buildIntentRouterScoreBoosts({
    chatId: params.chatId,
    text: params.text,
    hasMailContext,
    hasMemoryRecallCue,
  });

  const chatScopedRouter = deps.buildIntentRouterForChat(params.chatId);
  const routerAbVariant = chatScopedRouter.abVariant;
  const routerCanaryVersion = chatScopedRouter.canaryVersionId;

  const semanticRouteDecision =
    semanticAllowedCandidates.length > 0
      ? chatScopedRouter.router.route(params.text, {
          allowed: semanticAllowedCandidates,
          boosts: routeScoreBoosts,
          alphaOverrides: deps.alphaOverrides,
          topK: 5,
        })
      : null;

  let semanticGap: number | null = null;
  let semanticCalibratedConfidence: number | null = null;
  if (semanticRouteDecision) {
    const second = semanticRouteDecision.alternatives[1];
    semanticGap = second ? semanticRouteDecision.score - second.score : null;
    semanticCalibratedConfidence = deps.calibrateConfidence(semanticRouteDecision.handler, semanticRouteDecision.score);
  }

  const shadowRouteDecision =
    semanticAllowedCandidates.length > 0 && deps.shouldRunIntentShadowMode(params.chatId, params.text)
      ? deps.runShadowRoute({
          text: params.text,
          allowed: semanticAllowedCandidates,
          boosts: routeScoreBoosts,
          alphaOverrides: deps.alphaOverrides,
          topK: 5,
        })
      : null;

  const aiRouteDecision = deps.shouldRunAiJudgeForEnsemble(semanticRouteDecision)
    ? await deps.classifyNaturalIntentRouteWithAi({
        chatId: params.chatId,
        text: params.text,
        candidates: semanticAllowedCandidates,
      })
    : null;

  const ranked = deps.rankIntentCandidatesWithEnsemble({
    candidates: semanticAllowedCandidates,
    semanticAlternatives: semanticRouteDecision?.alternatives,
    aiSelected:
      aiRouteDecision?.handler && aiRouteDecision.handler !== "none" ? (aiRouteDecision.handler as NaturalIntentRouteName) : null,
    layerAllowed: routerLayerDecision ? toNaturalCandidates(routerLayerDecision.allowed) : routeCandidates,
    contextualBoosts: routeScoreBoosts,
    calibratedConfidence: semanticCalibratedConfidence,
  });

  const ensembleTop = ranked
    .map((item) => ({
      name: item.name as NaturalIntentRouteName,
      score: item.score,
    }))
    .slice(0, 5);

  const routedHandlerNames = (() => {
    if (ensembleTop.length === 0) {
      return routeCandidates;
    }
    const ordered = ensembleTop.map((item) => item.name);
    const used = new Set(ordered);
    return [...ordered, ...routeCandidates.filter((name) => !used.has(name))];
  })();

  return {
    hasMailContext,
    hasMemoryRecallCue,
    routeCandidates,
    routerLayerDecision,
    hierarchyDecision,
    effectiveHierarchyDecision,
    routeFilterDecision,
    semanticAllowedCandidates,
    strictNarrowingExhausted,
    routeScoreBoosts,
    routerAbVariant,
    routerCanaryVersion,
    semanticRouteDecision,
    semanticCalibratedConfidence,
    semanticGap,
    shadowRouteDecision,
    aiRouteDecision,
    ensembleTop,
    routedHandlerNames,
    chatScopedRouterMeta: {
      effectiveAlpha: chatScopedRouter.effectiveAlpha,
      effectiveMinGap: chatScopedRouter.effectiveMinGap,
    },
  };
}
