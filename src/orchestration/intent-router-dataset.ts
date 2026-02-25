export type DatasetSharedInput = {
  chatId: number;
  userId?: number;
  source: string;
  text: string;
  hasMailContext: boolean;
  hasMemoryRecallCue: boolean;
  routeCandidates: string[];
  routeFilterDecision: { reason: string; allowed: string[] } | null;
  routerLayerDecision: { reason: string; allowed: string[]; layers: string[] } | null;
  hierarchyDecision: { domains: string[]; reason: string; allowed: string[] } | null;
  semanticRouteDecision:
    | {
        handler: string;
        score: number;
        reason: string;
        alternatives: Array<{ name: string; score: number }>;
      }
    | null;
  aiRouteDecision: { handler: string; reason?: string } | null;
  semanticCalibratedConfidence: number | null;
  semanticGap: number | null;
  routerAbVariant: "A" | "B";
  routerCanaryVersion: string | null;
  ensembleTop: Array<{ name: string; score: number }>;
  shadowRouteDecision?:
    | {
        handler: string;
        score: number;
        reason: string;
        alternatives: Array<{ name: string; score: number }>;
      }
    | null;
  shadowAlpha: number;
  shadowMinScoreGap: number;
  truncateInline: (text: string, maxChars: number) => string;
};

export function buildIntentRouterDatasetShared(input: DatasetSharedInput): Record<string, unknown> {
  return {
    chatId: input.chatId,
    ...(typeof input.userId === "number" ? { userId: input.userId } : {}),
    source: input.source,
    text: input.truncateInline(input.text.trim(), 500),
    hasMailContext: input.hasMailContext,
    hasMemoryRecallCue: input.hasMemoryRecallCue,
    routeCandidates: input.routeCandidates,
    ...(input.routeFilterDecision
      ? { routeFilterReason: input.routeFilterDecision.reason, routeFilterAllowed: input.routeFilterDecision.allowed }
      : input.routerLayerDecision
        ? { routeFilterReason: input.routerLayerDecision.reason, routeFilterAllowed: input.routerLayerDecision.allowed }
        : {}),
    ...(input.hierarchyDecision
      ? {
          routerHierarchyDomains: input.hierarchyDecision.domains,
          routerHierarchyReason: input.hierarchyDecision.reason,
          routerHierarchyAllowed: input.hierarchyDecision.allowed,
        }
      : {}),
    ...(input.semanticRouteDecision
      ? {
          semantic: {
            handler: input.semanticRouteDecision.handler,
            score: input.semanticRouteDecision.score,
            reason: input.semanticRouteDecision.reason,
            alternatives: input.semanticRouteDecision.alternatives,
          },
        }
      : {}),
    ...(input.aiRouteDecision ? { ai: input.aiRouteDecision } : {}),
    semanticCalibratedConfidence: input.semanticCalibratedConfidence ?? undefined,
    semanticGap: input.semanticGap ?? undefined,
    routerAbVariant: input.routerAbVariant,
    ...(input.routerCanaryVersion ? { routerCanaryVersion: input.routerCanaryVersion } : {}),
    ...(input.routerLayerDecision
      ? { routerLayers: input.routerLayerDecision.layers, routerLayerReason: input.routerLayerDecision.reason }
      : {}),
    routerEnsembleTop: input.ensembleTop,
    ...(input.shadowRouteDecision
      ? {
          shadow: {
            handler: input.shadowRouteDecision.handler,
            score: input.shadowRouteDecision.score,
            reason: input.shadowRouteDecision.reason,
            alternatives: input.shadowRouteDecision.alternatives,
            alpha: input.shadowAlpha,
            minScoreGap: input.shadowMinScoreGap,
          },
        }
      : {}),
  };
}
