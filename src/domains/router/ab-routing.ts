export type IntentRouterAbVariant = "A" | "B";

export type IntentRouterAbConfig = {
  enabled: boolean;
  splitPercent: number;
  variantBAlpha: number;
  variantBMinGap: number;
  variantBThresholdShift: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function resolveIntentRouterAbVariant(chatId: number, config: IntentRouterAbConfig): IntentRouterAbVariant {
  if (!config.enabled) {
    return "A";
  }
  const split = clamp(Math.floor(config.splitPercent), 0, 100);
  if (split <= 0) {
    return "A";
  }
  if (split >= 100) {
    return "B";
  }
  const bucket = Math.abs(chatId) % 100;
  return bucket < split ? "B" : "A";
}
